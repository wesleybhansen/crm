import { harness, internalRequest, readJson, resetHarness } from './support/route-harness'
import { HARNESS_NOLI_USER, HARNESS_ORG, HARNESS_TENANT } from './support/route-harness'
import {
  GtmAuditEvent,
  GtmCandidate,
  GtmCandidateMatch,
  GtmContactPoint,
  GtmEvidence,
  GtmPlay,
  GtmResearchRun,
  GtmWorkspace,
} from '../../data/entities'

jest.mock('@open-mercato/shared/lib/noli/core-client', () =>
  require('./support/route-harness').coreClientMock,
)
jest.mock('@open-mercato/shared/lib/auth/clerk', () => require('./support/route-harness').clerkMock)
jest.mock('@open-mercato/shared/lib/di/container', () =>
  require('./support/route-harness').containerMock,
)

const buildReviewedLeadExport = jest.fn()
const auditReviewedLeadExport = jest.fn()
jest.mock('../candidate-export', () => ({
  ...jest.requireActual('../candidate-export'),
  buildReviewedLeadExport: (...args: unknown[]) => buildReviewedLeadExport(...args),
  auditReviewedLeadExport: (...args: unknown[]) => auditReviewedLeadExport(...args),
}))

const WORKSPACE = '33333333-3333-4333-8333-333333333333'

async function seedPlayCandidate(outreachMode: 'automated_email' | 'manual_only') {
  const em = harness.em
  em.persist(
    em.create(GtmWorkspace, {
      id: WORKSPACE,
      organizationId: HARNESS_ORG,
      tenantId: HARNESS_TENANT,
      name: 'Fixture workspace',
      status: 'active',
    }),
  )
  const play = em.create(GtmPlay, {
    organizationId: HARNESS_ORG,
    tenantId: HARNESS_TENANT,
    workspaceId: WORKSPACE,
    source: 'authored',
    marketType: outreachMode === 'automated_email' ? 'b2b' : 'b2c',
    audience: 'Synthetic audience',
    executionEligibility: outreachMode === 'automated_email' ? 'executable' : 'strategy_only',
    leadMode: outreachMode === 'automated_email' ? 'business' : 'consumer',
    outreachMode,
  })
  em.persist(play)
  const run = em.create(GtmResearchRun, {
    organizationId: HARNESS_ORG,
    tenantId: HARNESS_TENANT,
    workspaceId: WORKSPACE,
    playId: play.id,
    status: 'completed',
  })
  em.persist(run)
  const candidate = em.create(GtmCandidate, {
    organizationId: HARNESS_ORG,
    tenantId: HARNESS_TENANT,
    researchRunId: run.id,
    workspaceId: WORKSPACE,
    entityKind: 'person',
    identity: { name: 'Synthetic Shared Person' },
    dedupeKey: `shared-${outreachMode}`,
    fitStatus: 'accepted',
    fitScore: '80',
  })
  em.persist(candidate)
  const match = em.create(GtmCandidateMatch, {
    organizationId: HARNESS_ORG,
    tenantId: HARNESS_TENANT,
    workspaceId: WORKSPACE,
    playId: play.id,
    researchRunId: run.id,
    candidateId: candidate.id,
    fitStatus: 'accepted',
    fitScore: '80',
  })
  em.persist(match)
  em.persist(
    em.create(GtmContactPoint, {
      organizationId: HARNESS_ORG,
      tenantId: HARNESS_TENANT,
      candidateId: candidate.id,
      channel: 'email',
      value: 'shared@fixture.example',
      verificationState: 'verified',
    }),
  )
  em.persist(
    em.create(GtmContactPoint, {
      organizationId: HARNESS_ORG,
      tenantId: HARNESS_TENANT,
      candidateId: candidate.id,
      channel: 'linkedin',
      value: 'https://profile.example/shared',
      verificationState: 'found',
    }),
  )
  em.persist(
    em.create(GtmEvidence, {
      organizationId: HARNESS_ORG,
      tenantId: HARNESS_TENANT,
      candidateId: candidate.id,
      researchRunId: run.id,
      claim: 'synthetic claim',
      confidence: '0.9',
    }),
  )
  await em.flush()
  return { play, run, candidate, match }
}

describe('POST /internal/gtm/candidates', () => {
  beforeEach(() => {
    resetHarness({ features: ['gtm.view', 'gtm.edit'] })
    buildReviewedLeadExport.mockReset()
    auditReviewedLeadExport.mockReset()
  })

  it('hides email contact points and verified-email facts when the resolving play is manual-only (research M17)', async () => {
    const { POST } = await import('../../api/internal/candidates/route')
    const { candidate, run, match } = await seedPlayCandidate('manual_only')

    const detail = await readJson(
      await POST(internalRequest({ op: 'detail', noliUserId: HARNESS_NOLI_USER, candidateId: candidate.id, matchId: match.id })),
    )
    const points = detail.contact_points as Array<Record<string, unknown>>
    expect(points.map((point) => point.channel)).toEqual(['linkedin'])
    expect(JSON.stringify(detail)).not.toContain('shared@fixture.example')

    const list = await readJson(
      await POST(internalRequest({ op: 'list', noliUserId: HARNESS_NOLI_USER, runId: run.id })),
    )
    const rows = list.candidates as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      has_verified_email: false,
      email_verification_state: null,
      email_contact_count: 0,
    })
  })

  it('keeps email contact points visible under an automated-email play', async () => {
    const { POST } = await import('../../api/internal/candidates/route')
    const { candidate, run, match } = await seedPlayCandidate('automated_email')
    const detail = await readJson(
      await POST(internalRequest({ op: 'detail', noliUserId: HARNESS_NOLI_USER, candidateId: candidate.id, matchId: match.id })),
    )
    const points = detail.contact_points as Array<Record<string, unknown>>
    expect(points.map((point) => point.channel).sort()).toEqual(['email', 'linkedin'])
    const list = await readJson(
      await POST(internalRequest({ op: 'list', noliUserId: HARNESS_NOLI_USER, runId: run.id })),
    )
    expect((list.candidates as Array<Record<string, unknown>>)[0]).toMatchObject({
      has_verified_email: true,
      email_contact_count: 1,
    })
  })

  it('takes the export idempotency key from the header, never from the body (L5)', async () => {
    const { POST } = await import('../../api/internal/candidates/route')
    const { play } = await seedPlayCandidate('automated_email')
    buildReviewedLeadExport.mockResolvedValue({
      schema_version: 'v1',
      considered: 0,
      exported: 0,
      skipped_by_reason: {},
      truncated: false,
      rows: [],
    })
    auditReviewedLeadExport.mockResolvedValue(undefined)

    const withHeader = await POST(
      internalRequest(
        {
          op: 'export',
          noliUserId: HARNESS_NOLI_USER,
          workspaceId: WORKSPACE,
          playId: play.id,
          idempotency_key: 'body-supplied-key',
        },
        { authorization: `Bearer ${process.env.NOLI_INTERNAL_SERVICE_SECRET}`, 'idempotency-key': 'header-key-1' },
      ),
    )
    expect(withHeader.status).toBe(200)
    expect(auditReviewedLeadExport).toHaveBeenCalledTimes(1)
    expect(auditReviewedLeadExport.mock.calls[0][2]).toMatchObject({ idempotencyKey: 'header-key-1' })

    // A body key with no header is not an idempotency key at all: the export
    // is refused before any audited work happens.
    const bodyOnly = await POST(
      internalRequest({
        op: 'export',
        noliUserId: HARNESS_NOLI_USER,
        workspaceId: WORKSPACE,
        playId: play.id,
        idempotency_key: 'body-supplied-key',
      }),
    )
    expect(bodyOnly.status).toBe(400)
    expect(auditReviewedLeadExport).toHaveBeenCalledTimes(1)
    expect(harness.em.table(GtmAuditEvent)).toHaveLength(0)
  })
})
