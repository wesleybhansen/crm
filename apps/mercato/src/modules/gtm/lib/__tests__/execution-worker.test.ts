import type { QueuedJob } from '@open-mercato/queue'
import { GtmSendAttempt } from '../../data/entities'
import { claimDueAttempts, recoverStuckAttempts, type ClaimResult } from '../execute/claim'
import { executeClaimedAttempt } from '../execute/send'
import type { ExecutionEm } from '../execute/schedule'
import type { GtmSendTransport } from '../execute/transport'
import type { GtmExecutionTickJob } from '../execute/queue-contract'
import handle, {
  GTM_EXECUTION_TICK_QUEUE,
  LEASE_RELEASE_MARGIN_MS,
  metadata,
  processExecutionTick,
} from '../../workers/execution-tick'
import { FakeEm } from './support/fake-em'
import { ctx as fixtureCtx } from './support/campaign-fixtures'
import { FakeTransport, LAUNCH_ISO, fixedClock, seedLaunchedCampaign } from './support/execution-fixtures'

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001'
const TENANT_ID = '00000000-0000-4000-8000-000000000002'
const USER_ID = '00000000-0000-4000-8000-000000000003'

function job(payload: unknown): QueuedJob<GtmExecutionTickJob> {
  return {
    id: 'job-1',
    payload: payload as GtmExecutionTickJob,
    createdAt: '2026-08-18T08:00:00.000Z',
  }
}

describe('GTM C6 execution queue worker', () => {
  const originalModuleGate = process.env.GTM_ENGINEER_ENABLED
  const originalExecutionGate = process.env.GTM_EXECUTION_ENABLED

  afterEach(() => {
    if (originalModuleGate === undefined) delete process.env.GTM_ENGINEER_ENABLED
    else process.env.GTM_ENGINEER_ENABLED = originalModuleGate
    if (originalExecutionGate === undefined) delete process.env.GTM_EXECUTION_ENABLED
    else process.env.GTM_EXECUTION_ENABLED = originalExecutionGate
  })

  it('registers a single-concurrency queue target without creating a schedule', () => {
    expect(GTM_EXECUTION_TICK_QUEUE).toBe('gtm-execution-tick')
    expect(metadata).toEqual({
      queue: GTM_EXECUTION_TICK_QUEUE,
      id: 'gtm:execution-tick',
      concurrency: 1,
    })
  })

  it.each([
    [undefined, undefined],
    ['true', undefined],
    [undefined, 'true'],
    ['false', 'true'],
    ['true', 'false'],
  ])('returns before payload or dependency access while either gate is dark', async (moduleGate, executionGate) => {
    if (moduleGate === undefined) delete process.env.GTM_ENGINEER_ENABLED
    else process.env.GTM_ENGINEER_ENABLED = moduleGate
    if (executionGate === undefined) delete process.env.GTM_EXECUTION_ENABLED
    else process.env.GTM_EXECUTION_ENABLED = executionGate
    const resolve = jest.fn(() => {
      throw new Error('must remain unreachable')
    })

    await expect(handle(job({ credentials: 'not-even-parsed' }), {
      jobId: 'job-1',
      attemptNumber: 1,
      queueName: GTM_EXECUTION_TICK_QUEUE,
      resolve,
    })).resolves.toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('validates the enabled payload before resolving the ORM', async () => {
    process.env.GTM_ENGINEER_ENABLED = 'true'
    process.env.GTM_EXECUTION_ENABLED = 'true'
    const resolve = jest.fn()

    await expect(handle(job({ organizationId: 'not-a-uuid' }), {
      jobId: 'job-1',
      attemptNumber: 1,
      queueName: GTM_EXECUTION_TICK_QUEUE,
      resolve,
    })).rejects.toThrow()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('forwards exact scope and limit and executes claimed attempts sequentially', async () => {
    const attempts = [
      { id: 'attempt-1' } as GtmSendAttempt,
      { id: 'attempt-2' } as GtmSendAttempt,
    ]
    const claimed: ClaimResult['claimed'] = attempts.map((attempt, index) => ({
      attempt,
      claimToken: `claim-${index + 1}`,
      fence: index + 1,
    }))
    const claimDueAttempts = jest.fn(async (_em, ctx, input): Promise<ClaimResult> => ({
      now: new Date('2026-08-18T08:00:00.000Z'),
      due: 3,
      claimed,
    }))
    const recoverStuckAttempts = jest.fn(async () => ({
      now: new Date('2026-08-18T08:00:00.000Z'),
      ambiguous: 1,
    }))
    let active = 0
    let maxActive = 0
    const executionOrder: string[] = []
    const executeClaimedAttempt = jest.fn(async (_em, ctx, attempt, deps) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      expect(ctx).toEqual({
        organizationId: ORGANIZATION_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        requestId: 'queue:job-1',
      })
      expect(deps.transport).toBe(transport)
      await Promise.resolve()
      executionOrder.push(attempt.id)
      active -= 1
      return { outcome: 'accepted' as const, attemptId: attempt.id }
    })
    const transport: GtmSendTransport = { send: jest.fn() }
    const em = {} as ExecutionEm

    const result = await processExecutionTick(
      em,
      {
        organizationId: ORGANIZATION_ID,
        tenantId: TENANT_ID,
        requestedByUserId: USER_ID,
        limit: 17,
        _idempotencyKey: 'scheduler:ignored-by-durable-claim',
      },
      'queue:job-1',
      { recoverStuckAttempts, claimDueAttempts, executeClaimedAttempt, transport },
    )

    expect(recoverStuckAttempts).toHaveBeenCalledWith(em, {
      organizationId: ORGANIZATION_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      requestId: 'queue:job-1',
    })
    expect(recoverStuckAttempts.mock.invocationCallOrder[0])
      .toBeLessThan(claimDueAttempts.mock.invocationCallOrder[0])
    expect(claimDueAttempts).toHaveBeenCalledWith(em, {
      organizationId: ORGANIZATION_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      requestId: 'queue:job-1',
    }, { limit: 17 })
    expect(executionOrder).toEqual(['attempt-1', 'attempt-2'])
    expect(maxActive).toBe(1)
    expect(result).toEqual({
      ambiguousRecovered: 1,
      due: 3,
      claimed: 2,
      outcomes: [
        { outcome: 'accepted', attemptId: 'attempt-1' },
        { outcome: 'accepted', attemptId: 'attempt-2' },
      ],
    })
  })

  it('releases a claim whose lease is about to lapse instead of executing it (M2)', async () => {
    const em = new FakeEm()
    const claimNow = new Date('2026-08-18T08:00:00.000Z')
    const expiring = em.create(GtmSendAttempt, {
      organizationId: ORGANIZATION_ID,
      tenantId: TENANT_ID,
      enrollmentId: '00000000-0000-4000-8000-000000000010',
      stepId: '00000000-0000-4000-8000-000000000011',
      campaignVersionId: '00000000-0000-4000-8000-000000000012',
      idempotencyKey: 'send:expiring:1',
      state: 'claimed',
      claimToken: 'token-expiring',
      claimExpiresAt: new Date(claimNow.getTime() + LEASE_RELEASE_MARGIN_MS - 1_000),
      fence: 1,
    })
    em.persist(expiring)
    await em.flush()
    const claimed: ClaimResult['claimed'] = [{ attempt: expiring, claimToken: 'token-expiring', fence: 1 }]
    const executeClaimedAttempt = jest.fn()
    const result = await processExecutionTick(
      em,
      { organizationId: ORGANIZATION_ID, tenantId: TENANT_ID, requestedByUserId: USER_ID },
      'queue:job-2',
      {
        recoverStuckAttempts: async () => ({ now: claimNow, ambiguous: 0 }),
        claimDueAttempts: async () => ({ now: claimNow, due: 1, claimed }),
        executeClaimedAttempt,
        transport: { send: jest.fn() },
      },
    )
    expect(executeClaimedAttempt).not.toHaveBeenCalled()
    expect(result.outcomes).toEqual([{ outcome: 'released', attemptId: expiring.id, reason: 'lease_expiring' }])
    // Back to 'approved' under the fence: due again on the very next tick.
    expect(em.table(GtmSendAttempt)[0]).toMatchObject({ state: 'approved', claimToken: null, claimExpiresAt: null })
  })
})

/*
 * C1 regression (review CRITICAL): with the real ORM every accepted send but
 * the last one in a multi-attempt tick was flushed back to 'provider_started'
 * by the next attempt's start transaction (a managed entity mutated after the
 * fenced nativeUpdate + identity-map flush on commit), and the next tick's
 * recoverStuckAttempts parked it 'ambiguous'. The identity-map FakeEm
 * reproduces that lifecycle; the fix (no entity mutation after nativeUpdate,
 * one EntityManager fork per attempt) is asserted here end to end through
 * the real claim/execute/recover code.
 */
describe('multi-attempt tick under ORM identity-map semantics (C1)', () => {
  beforeAll(() => {
    process.env.GTM_UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret'
    process.env.GTM_UNSUBSCRIBE_KEYRING = JSON.stringify({ test: 'test-unsubscribe-secret' })
    process.env.GTM_UNSUBSCRIBE_ACTIVE_KEY_ID = 'test'
    process.env.GTM_PUBLIC_BASE_URL = 'https://crm.fixture.example'
  })

  it('ticks two due attempts: both rows end accepted and STAY accepted after recovery', async () => {
    const seedEm = new FakeEm()
    const fixture = await seedLaunchedCampaign(seedEm, {
      clock: fixedClock(LAUNCH_ISO),
      recipients: 2,
      emails: 1,
    })
    expect(fixture.attempts).toHaveLength(2)
    // The tick runs against a fork with real identity-map semantics sharing
    // the seeded rows.
    const em = seedEm.fork({ identityMap: true })
    const clock = fixedClock('2026-07-22T16:30:00.000Z')
    const transport = new FakeTransport()

    const result = await processExecutionTick(
      em,
      { organizationId: fixtureCtx.organizationId, tenantId: fixtureCtx.tenantId, requestedByUserId: fixtureCtx.userId },
      'queue:c1',
      {
        recoverStuckAttempts: (tickEm, tickCtx) => recoverStuckAttempts(tickEm, tickCtx, { clock }),
        claimDueAttempts: (tickEm, tickCtx, input) => claimDueAttempts(tickEm, tickCtx, { ...input, clock }),
        executeClaimedAttempt: (tickEm, tickCtx, attempt, deps) =>
          executeClaimedAttempt(tickEm, tickCtx, attempt, { ...deps, clock }),
        transport,
      },
    )
    expect(result.claimed).toBe(2)
    expect(result.outcomes.map((o) => o.outcome)).toEqual(['accepted', 'accepted'])
    expect(transport.calls).toHaveLength(2)

    const rows = () => seedEm.table(GtmSendAttempt).filter((row) => fixture.attempts.some((a) => a.id === row.id))
    expect(rows().map((row) => row.state)).toEqual(['accepted', 'accepted'])

    // A later recovery pass (lease long expired) must find nothing to park.
    clock.set('2026-07-22T17:00:00.000Z')
    const recovered = await recoverStuckAttempts(seedEm.fork({ identityMap: true }), fixtureCtx, { clock })
    expect(recovered.ambiguous).toBe(0)
    expect(rows().map((row) => row.state)).toEqual(['accepted', 'accepted'])
    expect(rows().every((row) => row.rfcMessageId && row.acceptedAt)).toBe(true)
  })
})
