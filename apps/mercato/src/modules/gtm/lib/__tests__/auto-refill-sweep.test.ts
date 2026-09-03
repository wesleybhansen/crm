import { FakeEm } from './support/fake-em'
import {
  GtmAuditEvent,
  GtmAutoRefillCycle,
  GtmAutoRefillPolicy,
  GtmResearchRun,
} from '../../data/entities'
import { AUTO_REFILL_STALE_CYCLE_MS } from '../auto-refill/contract'
import { sweepStaleAutoRefillCycles } from '../auto-refill/sweep'

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const OTHER_ORG = '11111111-1111-4111-8111-222222222222'
const NOW = new Date('2026-08-24T15:00:00.000Z')

function seedPolicy(em: FakeEm, organizationId = ORG, id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
  const policy = em.create(GtmAutoRefillPolicy, {
    id,
    organizationId,
    tenantId: TENANT,
    workspaceId: '33333333-3333-4333-8333-333333333333',
    playId: '44444444-4444-4444-8444-444444444444',
    campaignId: '55555555-5555-4555-8555-555555555555',
    campaignVersionId: '66666666-6666-4666-8666-666666666666',
    representedNoliUserId: '88888888-8888-4888-8888-888888888888',
    noliOrganizationId: '99999999-9999-4999-8999-999999999999',
    requestedByUserId: '77777777-7777-4777-8777-777777777777',
    status: 'active',
    policyHash: 'a'.repeat(64),
    campaignContentHash: 'b'.repeat(64),
    planHash: 'c'.repeat(64),
    targetAcceptedPerDay: 5,
    maxRawCandidatesPerDay: 25,
    maxCreditsPerDay: 250_000,
    runHourLocal: 7,
    timezone: 'America/New_York',
    scheduledJobId: id,
    fence: 1,
  })
  em.persist(policy)
  return policy
}

function seedCycle(
  em: FakeEm,
  policy: GtmAutoRefillPolicy,
  startedAt: Date,
  localDate: string,
  status = 'running',
) {
  const run = em.create(GtmResearchRun, {
    organizationId: policy.organizationId,
    tenantId: policy.tenantId,
    workspaceId: policy.workspaceId,
    playId: policy.playId,
    status: 'running',
    inputSnapshot: {},
    providerPlan: {},
    limits: {},
    estimatedCredits: '0',
    startedAt,
  })
  const cycle = em.create(GtmAutoRefillCycle, {
    organizationId: policy.organizationId,
    tenantId: policy.tenantId,
    policyId: policy.id,
    campaignId: policy.campaignId,
    campaignVersionId: policy.campaignVersionId,
    playId: policy.playId,
    researchRunId: run.id,
    localDate,
    policyHash: policy.policyHash,
    campaignContentHash: policy.campaignContentHash,
    planHash: policy.planHash,
    status,
    failureCode: null,
    result: null,
    startedAt,
    completedAt: null,
  })
  em.persist(run)
  em.persist(cycle)
  return { run, cycle }
}

describe('auto-refill stale cycle sweep (H5)', () => {
  it('parks a running cycle older than the stale window, fails its run, blocks the policy, and audits', async () => {
    const em = new FakeEm()
    const policy = seedPolicy(em)
    const stale = seedCycle(em, policy, new Date(NOW.getTime() - AUTO_REFILL_STALE_CYCLE_MS - 1), '2026-08-21')
    const fresh = seedCycle(em, policy, new Date(NOW.getTime() - 60 * 60 * 1000), '2026-08-24')
    await em.flush()

    const result = await sweepStaleAutoRefillCycles(em, { organizationId: ORG, tenantId: TENANT, now: NOW })

    expect(result.swept).toEqual([
      { cycleId: stale.cycle.id, policyId: policy.id, researchRunId: stale.run.id },
    ])
    expect(stale.cycle).toEqual(expect.objectContaining({
      status: 'reconciliation_required',
      failureCode: 'stale_running_cycle',
      completedAt: NOW,
    }))
    expect(stale.run.status).toBe('failed')
    expect(fresh.cycle.status).toBe('running')
    expect(fresh.run.status).toBe('running')
    expect(policy).toEqual(expect.objectContaining({
      status: 'blocked',
      blockedReason: 'reconciliation_required',
      fence: 2,
    }))
    const audit = em.table(GtmAuditEvent).find((event) => event.action === 'gtm.auto_refill.cycle_stale')
    expect(audit).toEqual(expect.objectContaining({
      organizationId: ORG,
      tenantId: TENANT,
      objectId: stale.cycle.id,
      metadata: expect.objectContaining({
        policy_id: policy.id,
        research_run_id: stale.run.id,
        status: 'reconciliation_required',
        policy_blocked: true,
      }),
    }))
    expect(JSON.stringify(audit?.metadata)).not.toContain('synthetic')
  })

  it('is tenant scoped and leaves finished cycles alone', async () => {
    const em = new FakeEm()
    const mine = seedPolicy(em)
    const theirs = seedPolicy(em, OTHER_ORG, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    const old = new Date(NOW.getTime() - 2 * AUTO_REFILL_STALE_CYCLE_MS)
    const foreign = seedCycle(em, theirs, old, '2026-08-20')
    const completed = seedCycle(em, mine, old, '2026-08-19', 'completed')
    await em.flush()

    const result = await sweepStaleAutoRefillCycles(em, { organizationId: ORG, tenantId: TENANT, now: NOW })

    expect(result.swept).toEqual([])
    expect(foreign.cycle.status).toBe('running')
    expect(theirs.status).toBe('active')
    expect(completed.cycle.status).toBe('completed')
    expect(em.table(GtmAuditEvent)).toHaveLength(0)
  })

  it('is idempotent: a second sweep finds nothing to do', async () => {
    const em = new FakeEm()
    const policy = seedPolicy(em)
    seedCycle(em, policy, new Date(NOW.getTime() - 2 * AUTO_REFILL_STALE_CYCLE_MS), '2026-08-20')
    await em.flush()
    expect((await sweepStaleAutoRefillCycles(em, { organizationId: ORG, tenantId: TENANT, now: NOW })).swept).toHaveLength(1)
    expect((await sweepStaleAutoRefillCycles(em, { organizationId: ORG, tenantId: TENANT, now: NOW })).swept).toHaveLength(0)
    expect(em.table(GtmAuditEvent).filter((event) => event.action === 'gtm.auto_refill.cycle_stale')).toHaveLength(1)
    expect(policy.fence).toBe(2)
  })
})
