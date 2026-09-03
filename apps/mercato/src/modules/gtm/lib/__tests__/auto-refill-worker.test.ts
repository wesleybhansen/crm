import type { QueuedJob } from '@open-mercato/queue'
import type { GtmAutoRefillJob } from '../auto-refill/contract'
import handle, { GTM_AUTO_REFILL_QUEUE, metadata } from '../../workers/auto-refill'
import { FakeEm } from './support/fake-em'
import {
  GtmAuditEvent,
  GtmAutoRefillCycle,
  GtmAutoRefillPolicy,
} from '../../data/entities'

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const POLICY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NOLI_USER = '88888888-8888-4888-8888-888888888888'
const NOLI_ORG = '99999999-9999-4999-8999-999999999999'
const CRM_USER = '77777777-7777-4777-8777-777777777777'
const CLERK_USER = 'user_clerk_r38'

const processAutoRefillCycle = jest.fn()

jest.mock('@open-mercato/shared/lib/noli/core-client', () => ({
  findNoliUserById: jest.fn(async () => ({ id: NOLI_USER, clerk_user_id: CLERK_USER })),
  findPrimaryOrgIdForUser: jest.fn(async () => NOLI_ORG),
}))
jest.mock('@open-mercato/shared/lib/auth/clerk', () => ({
  resolveClerkUserToAuthContext: jest.fn(async () => ({
    userId: CRM_USER,
    orgId: ORG,
    tenantId: TENANT,
  })),
}))
jest.mock('../authorize', () => ({ hasGtmFeature: jest.fn(async () => true) }))
jest.mock('../adapters/registry', () => ({ sourceAdapterRegistry: jest.fn(() => ({})) }))
jest.mock('../credits/noli-core-ledger', () => ({ getLedger: jest.fn(() => ({})) }))
jest.mock('../auto-refill/cycle', () => ({
  processAutoRefillCycle: (...args: unknown[]) => processAutoRefillCycle(...args),
}))

function seedPolicy(em: FakeEm, overrides: Partial<GtmAutoRefillPolicy> = {}): GtmAutoRefillPolicy {
  const policy = em.create(GtmAutoRefillPolicy, {
    id: POLICY,
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: '33333333-3333-4333-8333-333333333333',
    playId: '44444444-4444-4444-8444-444444444444',
    campaignId: '55555555-5555-4555-8555-555555555555',
    campaignVersionId: '66666666-6666-4666-8666-666666666666',
    representedNoliUserId: NOLI_USER,
    noliOrganizationId: NOLI_ORG,
    requestedByUserId: CRM_USER,
    status: 'active',
    policyHash: 'a'.repeat(64),
    campaignContentHash: 'b'.repeat(64),
    planHash: 'c'.repeat(64),
    targetAcceptedPerDay: 5,
    maxRawCandidatesPerDay: 25,
    maxCreditsPerDay: 250_000,
    runHourLocal: 7,
    timezone: 'America/New_York',
    scheduledJobId: POLICY,
    fence: 1,
    lastCycleAt: null,
    ...overrides,
  })
  em.persist(policy)
  return policy
}

function contextFor(em: FakeEm) {
  return {
    jobId: 'job-r38',
    attemptNumber: 1,
    queueName: GTM_AUTO_REFILL_QUEUE,
    resolve: jest.fn(() => ({ fork: () => em })) as unknown as <T = unknown>(name: string) => T,
  }
}

function job(payload: unknown): QueuedJob<GtmAutoRefillJob> {
  return {
    id: 'job-r38',
    payload: payload as GtmAutoRefillJob,
    createdAt: '2026-08-24T15:00:00.000Z',
  }
}

describe('R38 auto-refill worker gate', () => {
  const originalModuleGate = process.env.GTM_ENGINEER_ENABLED
  const originalAutoRefillGate = process.env.GTM_AUTO_REFILL_ENABLED

  afterEach(() => {
    processAutoRefillCycle.mockReset()
    if (originalModuleGate === undefined) delete process.env.GTM_ENGINEER_ENABLED
    else process.env.GTM_ENGINEER_ENABLED = originalModuleGate
    if (originalAutoRefillGate === undefined) delete process.env.GTM_AUTO_REFILL_ENABLED
    else process.env.GTM_AUTO_REFILL_ENABLED = originalAutoRefillGate
  })

  it('registers a single-concurrency platform queue target', () => {
    expect(GTM_AUTO_REFILL_QUEUE).toBe('gtm-auto-refill')
    expect(metadata).toEqual({
      queue: GTM_AUTO_REFILL_QUEUE,
      id: 'gtm:auto-refill',
      concurrency: 1,
    })
  })

  it.each([
    [undefined, undefined],
    ['true', undefined],
    [undefined, 'true'],
    ['false', 'true'],
    ['true', 'false'],
  ])('returns before payload and dependency access while either gate is dark', async (moduleGate, refillGate) => {
    if (moduleGate === undefined) delete process.env.GTM_ENGINEER_ENABLED
    else process.env.GTM_ENGINEER_ENABLED = moduleGate
    if (refillGate === undefined) delete process.env.GTM_AUTO_REFILL_ENABLED
    else process.env.GTM_AUTO_REFILL_ENABLED = refillGate
    const resolve = jest.fn(() => {
      throw new Error('must remain unreachable')
    })
    await expect(handle(job({ credentials: 'not-even-parsed' }), {
      jobId: 'job-r38',
      attemptNumber: 1,
      queueName: GTM_AUTO_REFILL_QUEUE,
      resolve,
    })).resolves.toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
  })

  // Review 2026-09-02 (H5 / workers M7): a post-claim exception was
  // swallowed, leaving the cycle, run, and escrow at 'running' forever.
  it('records, blocks, and rethrows when a claimed cycle fails to resolve', async () => {
    process.env.GTM_ENGINEER_ENABLED = 'true'
    process.env.GTM_AUTO_REFILL_ENABLED = 'true'
    const em = new FakeEm()
    const policy = seedPolicy(em)
    await em.flush()
    processAutoRefillCycle.mockImplementationOnce(async () => {
      // the cycle claim moved lastCycleAt, then the failure path itself threw
      policy.lastCycleAt = new Date('2026-08-24T15:00:00.000Z')
      throw new Error('connection reset inside failCycleAfterException')
    })

    await expect(handle(job({ policyId: POLICY, organizationId: ORG, tenantId: TENANT }), contextFor(em)))
      .rejects.toThrow('connection reset')

    expect(em.table(GtmAutoRefillPolicy)[0]).toEqual(expect.objectContaining({
      status: 'blocked',
      blockedReason: 'cycle_unresolved',
      fence: 2,
    }))
    const actions = em.table(GtmAuditEvent).map((event) => event.action)
    expect(actions).toContain('gtm.auto_refill.policy_blocked')
    expect(actions).toContain('gtm.auto_refill.cycle_unresolved')
    const unresolved = em.table(GtmAuditEvent).find((event) => event.action === 'gtm.auto_refill.cycle_unresolved')
    expect(unresolved?.metadata).toEqual(expect.objectContaining({
      failure_code: 'cycle_unresolved',
      job_id: 'job-r38',
      error: expect.stringContaining('connection reset'),
    }))
  })

  it('still blocks dependencies_unavailable without rethrowing when nothing was claimed', async () => {
    process.env.GTM_ENGINEER_ENABLED = 'true'
    process.env.GTM_AUTO_REFILL_ENABLED = 'true'
    const em = new FakeEm()
    seedPolicy(em)
    await em.flush()
    processAutoRefillCycle.mockImplementationOnce(async () => {
      throw new Error('registry construction failed before any claim')
    })

    await expect(handle(job({ policyId: POLICY, organizationId: ORG, tenantId: TENANT }), contextFor(em)))
      .resolves.toBeUndefined()

    expect(em.table(GtmAutoRefillPolicy)[0]).toEqual(expect.objectContaining({
      status: 'blocked',
      blockedReason: 'dependencies_unavailable',
    }))
  })

  it('sweeps a stale running cycle for this tenant before processing the delivery', async () => {
    process.env.GTM_ENGINEER_ENABLED = 'true'
    process.env.GTM_AUTO_REFILL_ENABLED = 'true'
    const em = new FakeEm()
    const policy = seedPolicy(em)
    const stale = em.create(GtmAutoRefillCycle, {
      organizationId: ORG,
      tenantId: TENANT,
      policyId: POLICY,
      campaignId: policy.campaignId,
      campaignVersionId: policy.campaignVersionId,
      playId: policy.playId,
      researchRunId: null,
      localDate: '2026-08-21',
      policyHash: policy.policyHash,
      campaignContentHash: policy.campaignContentHash,
      planHash: policy.planHash,
      status: 'running',
      failureCode: null,
      result: null,
      startedAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
      completedAt: null,
    })
    em.persist(stale)
    await em.flush()
    processAutoRefillCycle.mockImplementationOnce(async () => ({ outcome: 'inactive', cycle: null, researchRun: null }))

    await handle(job({ policyId: POLICY, organizationId: ORG, tenantId: TENANT }), contextFor(em))

    expect(em.table(GtmAutoRefillCycle)[0]).toEqual(expect.objectContaining({
      status: 'reconciliation_required',
      failureCode: 'stale_running_cycle',
    }))
    // the policy was blocked by the sweep, so the delivery never reached the cycle
    expect(em.table(GtmAutoRefillPolicy)[0].status).toBe('blocked')
    expect(processAutoRefillCycle).not.toHaveBeenCalled()
  })

  it('validates an enabled payload before resolving the ORM', async () => {
    process.env.GTM_ENGINEER_ENABLED = 'true'
    process.env.GTM_AUTO_REFILL_ENABLED = 'true'
    const resolve = jest.fn()
    await expect(handle(job({ policyId: 'not-a-uuid' }), {
      jobId: 'job-r38',
      attemptNumber: 1,
      queueName: GTM_AUTO_REFILL_QUEUE,
      resolve,
    })).rejects.toThrow()
    expect(resolve).not.toHaveBeenCalled()
  })
})
