import type { QueuedJob } from '@open-mercato/queue'
import type { GtmSendAttempt } from '../../data/entities'
import type { ClaimResult } from '../execute/claim'
import type { ExecutionEm } from '../execute/schedule'
import type { GtmSendTransport } from '../execute/transport'
import type { GtmExecutionTickJob } from '../execute/queue-contract'
import handle, {
  GTM_EXECUTION_TICK_QUEUE,
  metadata,
  processExecutionTick,
} from '../../workers/execution-tick'

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
})
