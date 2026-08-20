import {
  GtmProviderOperation,
  GtmProviderReconciliationAction,
} from '../../data/entities'
import { getProviderHistoryDiagnostics } from '../diagnostics/provider-history'
import { FakeEm } from './support/fake-em'

const ORG = '00000000-0000-4000-8000-000000000001'
const TENANT = '00000000-0000-4000-8000-000000000002'

describe('provider history diagnostics', () => {
  it('returns tenant-scoped counts without provider receipts or evidence', async () => {
    const em = new FakeEm()
    const ambiguous = em.create(GtmProviderOperation, {
      organizationId: ORG,
      tenantId: TENANT,
      noliCoreOperationId: '00000000-0000-4000-8000-000000000010',
      researchRunId: '00000000-0000-4000-8000-000000000011',
      candidateId: null,
      kind: 'source',
      provider: 'leadmagic',
      localStatusMirror: 'reconciliation_required',
      receipt: { secret: 'must-not-return' },
      requestedAt: new Date('2026-08-17T19:00:00.000Z'),
    })
    const settled = em.create(GtmProviderOperation, {
      organizationId: ORG,
      tenantId: TENANT,
      noliCoreOperationId: '00000000-0000-4000-8000-000000000012',
      researchRunId: '00000000-0000-4000-8000-000000000011',
      candidateId: '00000000-0000-4000-8000-000000000013',
      kind: 'source',
      provider: 'leadmagic',
      localStatusMirror: 'charged',
      settledAt: new Date('2026-08-17T20:00:00.000Z'),
    })
    const secondProvider = em.create(GtmProviderOperation, {
      organizationId: ORG,
      tenantId: TENANT,
      noliCoreOperationId: '00000000-0000-4000-8000-000000000015',
      researchRunId: '00000000-0000-4000-8000-000000000011',
      candidateId: '00000000-0000-4000-8000-000000000013',
      kind: 'verify',
      provider: 'bouncer',
      localStatusMirror: 'reserved',
    })
    const foreign = em.create(GtmProviderOperation, {
      organizationId: ORG,
      tenantId: '00000000-0000-4000-8000-000000000099',
      noliCoreOperationId: '00000000-0000-4000-8000-000000000014',
      kind: 'verify',
      provider: 'bouncer',
      localStatusMirror: 'charged',
    })
    em.persist(ambiguous)
    em.persist(settled)
    em.persist(secondProvider)
    em.persist(foreign)
    em.persist(em.create(GtmProviderReconciliationAction, {
      organizationId: ORG,
      tenantId: TENANT,
      providerOperationId: ambiguous.id,
      idempotencyKey: 'reconcile:1',
      decision: 'charged',
      expectedStatus: 'charged',
      evidenceHash: 'hash',
      evidenceRedacted: { source: 'dashboard' },
      actorUserId: '00000000-0000-4000-8000-000000000020',
      status: 'pending',
    }))
    await em.flush()

    const result = await getProviderHistoryDiagnostics(em, {
      organizationId: ORG,
      tenantId: TENANT,
      userId: '00000000-0000-4000-8000-000000000020',
      requestId: null,
    })
    expect(result.totals).toMatchObject({
      operations: 3,
      ambiguous: 1,
      settled: 1,
      reconciliationActions: 1,
      pendingActions: 1,
      distinctResearchRuns: 1,
      distinctCandidates: 1,
    })
    expect(result.providers).toHaveLength(2)
    expect(result.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'leadmagic', kind: 'source' }),
      expect.objectContaining({ provider: 'bouncer', kind: 'verify' }),
    ]))
    expect(result.window).toEqual({ operationCap: 2000, actionCap: 5000, truncated: false })
    expect(JSON.stringify(result)).not.toContain('must-not-return')
    expect(JSON.stringify(result)).not.toContain('dashboard')
  })
})
