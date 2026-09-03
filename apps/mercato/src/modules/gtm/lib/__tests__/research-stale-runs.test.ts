import { FakeEm } from './support/fake-em'
import { GtmAuditEvent, GtmProviderOperation, GtmResearchRun } from '../../data/entities'
import { failStaleResearchRuns } from '../research/stale-runs'

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const WORKSPACE = '33333333-3333-4333-8333-333333333333'
const PLAY_ID = '44444444-4444-4444-8444-444444444444'
const NOW = new Date('2026-09-02T12:00:00.000Z')

function seedRun(em: FakeEm, status: string, startedAt: Date, overrides: Partial<GtmResearchRun> = {}) {
  const run = em.create(GtmResearchRun, {
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    playId: PLAY_ID,
    status,
    startedAt,
    providerPlan: { execution: { status: 'running' } },
    ...overrides,
  })
  em.persist(run)
  return run
}

describe('failStaleResearchRuns (M3 minimum viable sweeper)', () => {
  it('fails runs stuck in running past the threshold and parks their started operations', async () => {
    const em = new FakeEm()
    const stale = seedRun(em, 'running', new Date(NOW.getTime() - 45 * 60_000))
    const fresh = seedRun(em, 'running', new Date(NOW.getTime() - 5 * 60_000))
    const finished = seedRun(em, 'completed', new Date(NOW.getTime() - 90 * 60_000))
    const foreign = seedRun(em, 'running', new Date(NOW.getTime() - 90 * 60_000), { tenantId: 'other-tenant' })
    const started = em.create(GtmProviderOperation, {
      organizationId: ORG,
      tenantId: TENANT,
      noliCoreOperationId: '99999999-9999-4999-8999-999999999999',
      researchRunId: stale.id,
      kind: 'source_search',
      provider: 'fixture-source',
      localStatusMirror: 'provider_started',
      receipt: { provider_request_id: 'req-1' },
    })
    const settled = em.create(GtmProviderOperation, {
      organizationId: ORG,
      tenantId: TENANT,
      noliCoreOperationId: '99999999-9999-4999-8999-999999999998',
      researchRunId: stale.id,
      kind: 'source_search',
      provider: 'fixture-source',
      localStatusMirror: 'charged',
    })
    em.persist(started)
    em.persist(settled)
    await em.flush()

    const result = await failStaleResearchRuns(em, { organizationId: ORG, tenantId: TENANT }, { now: () => NOW })

    expect(result).toMatchObject({ olderThanMinutes: 30, failedRunIds: [stale.id], parkedOperationIds: [started.id] })
    expect(stale.status).toBe('failed')
    expect(stale.completedAt).toEqual(NOW)
    expect((stale.providerPlan as Record<string, any>).execution).toMatchObject({
      status: 'failed',
      failure_reason: expect.stringContaining('30 minutes'),
      reconciliation_required: true,
    })
    // Local mirror only; the reservation stays escrowed for an operator.
    expect(started.localStatusMirror).toBe('reconciliation_required')
    expect(settled.localStatusMirror).toBe('charged')
    expect(fresh.status).toBe('running')
    expect(finished.status).toBe('completed')
    expect(foreign.status).toBe('running')
    expect(em.table(GtmAuditEvent)).toEqual([
      expect.objectContaining({ action: 'gtm.research_run.stale_failed', objectId: stale.id }),
    ])

    // Idempotent: a second sweep finds nothing.
    expect(await failStaleResearchRuns(em, { organizationId: ORG, tenantId: TENANT }, { now: () => NOW }))
      .toMatchObject({ failedRunIds: [], parkedOperationIds: [] })
  })

  it('never sweeps below a five minute threshold', async () => {
    const em = new FakeEm()
    const run = seedRun(em, 'running', new Date(NOW.getTime() - 3 * 60_000))
    await em.flush()
    const result = await failStaleResearchRuns(em, { organizationId: ORG, tenantId: TENANT }, { now: () => NOW, olderThanMinutes: 1 })
    expect(result.olderThanMinutes).toBe(5)
    expect(run.status).toBe('running')
  })
})
