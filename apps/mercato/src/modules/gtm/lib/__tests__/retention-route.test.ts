import { FakeEm } from './support/fake-em'
import { harness, internalRequest, readJson, resetHarness } from './support/route-harness'
import { GtmCandidate, GtmContactPoint, GtmEvidence } from '../../data/entities'

jest.mock('@open-mercato/shared/lib/di/container', () =>
  require('./support/route-harness').containerMock,
)

/*
 * The scheduled retention route (review H7c): shared process secret in,
 * sweep out. The line that schedules it lives in RETENTION_SCHEDULE.md.
 */

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const PAST = new Date('2026-07-01T00:00:00.000Z')

async function seedExpired(em: FakeEm): Promise<GtmCandidate> {
  const candidate = em.create(GtmCandidate, {
    organizationId: ORG,
    tenantId: TENANT,
    researchRunId: '44444444-4444-4444-8444-444444444444',
    workspaceId: '33333333-3333-4333-8333-333333333333',
    entityKind: 'person',
    identity: { name: 'Synthetic Expired' },
    dedupeKey: 'expired-1',
    fitStatus: 'accepted',
    retentionExpiresAt: PAST,
    promotedContactId: null,
  })
  em.persist(candidate)
  em.persist(
    em.create(GtmEvidence, {
      organizationId: ORG,
      tenantId: TENANT,
      candidateId: candidate.id,
      claim: 'synthetic claim',
      confidence: '0.8',
    }),
  )
  em.persist(
    em.create(GtmContactPoint, {
      organizationId: ORG,
      tenantId: TENANT,
      candidateId: candidate.id,
      channel: 'email',
      value: 'expired@retention.example',
      verificationState: 'found',
    }),
  )
  await em.flush()
  return candidate
}

describe('POST /internal/gtm/retention', () => {
  beforeEach(() => {
    resetHarness()
  })

  it('refuses a missing, wrong, or same-length multibyte bearer and never runs the sweep', async () => {
    const { POST } = await import('../../api/internal/retention/route')
    await seedExpired(harness.em)
    for (const headers of [
      {},
      { authorization: 'Bearer nope' },
      { authorization: `Bearer ${'é'.repeat(process.env.NOLI_INTERNAL_SERVICE_SECRET!.length)}` },
    ]) {
      const response = await POST(internalRequest({}, headers, '/api/internal/gtm/retention'))
      expect(response.status).toBe(401)
    }
    expect(harness.em.table(GtmCandidate)).toHaveLength(1)
  })

  it('fails closed when the process secret is unset', async () => {
    const { POST } = await import('../../api/internal/retention/route')
    delete process.env.NOLI_INTERNAL_SERVICE_SECRET
    const response = await POST(
      internalRequest({}, { authorization: 'Bearer ' }, '/api/internal/gtm/retention'),
    )
    expect(response.status).toBe(500)
  })

  it('accepts the process secret, runs the global sweep, and returns its counts', async () => {
    const { POST } = await import('../../api/internal/retention/route')
    await seedExpired(harness.em)
    const response = await POST(
      internalRequest(
        // The body is ignored: the sweep is global and never caller-scoped.
        { orgId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', now: '1999-01-01T00:00:00.000Z' },
        { authorization: `Bearer ${process.env.NOLI_INTERNAL_SERVICE_SECRET}` },
        '/api/internal/gtm/retention',
      ),
    )
    expect(response.status).toBe(200)
    const json = await readJson(response)
    expect(json.ok).toBe(true)
    expect(json.sweep).toMatchObject({ candidatesDeleted: 1, evidenceDeleted: 1, contactPointsDeleted: 1 })
    expect(harness.em.table(GtmCandidate)).toHaveLength(0)
  })
})
