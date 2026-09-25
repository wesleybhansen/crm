import { harness, internalRequest, readJson, resetHarness } from './support/route-harness'
import { HARNESS_NOLI_USER, HARNESS_ORG, HARNESS_TENANT } from './support/route-harness'
import {
  GtmCandidate,
  GtmCandidateMatch,
  GtmContactPoint,
  GtmPlay,
  GtmResearchRun,
  GtmWorkspace,
} from '../../data/entities'

/*
 * TC-TENANT-001 at handler level (2026-09-25 review, H3). The Playwright spec
 * uses password signup for its second tenant; the Clerk path with
 * CRM_TENANT_PER_CUSTOMER=1 cannot be switched on for one spec of a shared
 * ephemeral app. Here the internal endpoints are driven exactly as the hub
 * calls them (noliUserId -> Clerk -> auth context), once as customer A and
 * once as customer B, each in its own tenant, against one store holding both
 * customers' rows. B must never see or touch A's rows, and each customer
 * keeps seeing its own. The Clerk provisioning itself (own tenant per Noli
 * org) is covered by auth/lib/__tests__/provision-tenant.pg.test.ts.
 */

jest.mock('@open-mercato/shared/lib/noli/core-client', () =>
  require('./support/route-harness').coreClientMock,
)
jest.mock('@open-mercato/shared/lib/auth/clerk', () => require('./support/route-harness').clerkMock)
jest.mock('@open-mercato/shared/lib/di/container', () =>
  require('./support/route-harness').containerMock,
)

const A = { userId: 'cccccccc-3333-4333-8333-333333333333', orgId: HARNESS_ORG, tenantId: HARNESS_TENANT }
const B = {
  userId: 'dddddddd-4444-4444-8444-444444444444',
  orgId: 'eeeeeeee-5555-4555-8555-555555555555',
  tenantId: 'ffffffff-6666-4666-8666-666666666666',
}

async function seedCustomer(scope: typeof A, label: string) {
  const em = harness.em
  const workspace = em.create(GtmWorkspace, {
    organizationId: scope.orgId,
    tenantId: scope.tenantId,
    name: `${label} workspace`,
    status: 'active',
  })
  em.persist(workspace)
  const play = em.create(GtmPlay, {
    organizationId: scope.orgId,
    tenantId: scope.tenantId,
    workspaceId: workspace.id,
    source: 'authored',
    marketType: 'b2b',
    audience: `${label} audience`,
    executionEligibility: 'executable',
    leadMode: 'business',
    outreachMode: 'automated_email',
  })
  em.persist(play)
  const run = em.create(GtmResearchRun, {
    organizationId: scope.orgId,
    tenantId: scope.tenantId,
    workspaceId: workspace.id,
    playId: play.id,
    status: 'completed',
  })
  em.persist(run)
  const candidate = em.create(GtmCandidate, {
    organizationId: scope.orgId,
    tenantId: scope.tenantId,
    researchRunId: run.id,
    workspaceId: workspace.id,
    entityKind: 'person',
    identity: { name: `${label} Person` },
    dedupeKey: `${label}-person`,
    fitStatus: 'accepted',
    fitScore: '80',
  })
  em.persist(candidate)
  const match = em.create(GtmCandidateMatch, {
    organizationId: scope.orgId,
    tenantId: scope.tenantId,
    workspaceId: workspace.id,
    playId: play.id,
    researchRunId: run.id,
    candidateId: candidate.id,
    fitStatus: 'accepted',
    fitScore: '80',
  })
  em.persist(match)
  em.persist(
    em.create(GtmContactPoint, {
      organizationId: scope.orgId,
      tenantId: scope.tenantId,
      candidateId: candidate.id,
      channel: 'email',
      value: `${label.toLowerCase()}@fixture.example`,
      verificationState: 'verified',
    }),
  )
  await em.flush()
  return { workspace, play, run, candidate, match }
}

function actAs(scope: typeof A) {
  harness.auth = { ...scope }
}

describe('two customers, two tenants: internal GTM endpoints', () => {
  beforeEach(() => {
    resetHarness({ features: ['gtm.view', 'gtm.edit'] })
  })

  it('candidates list/detail/shortlist: each customer sees only its own rows', async () => {
    const { POST } = await import('../../api/internal/candidates/route')
    const a = await seedCustomer(A, 'Alpha')
    const b = await seedCustomer(B, 'Bravo')

    actAs(B)
    const listForeign = await POST(internalRequest({ op: 'list', noliUserId: HARNESS_NOLI_USER, runId: a.run.id }))
    const listForeignBody = await readJson(listForeign)
    expect([200, 403, 404]).toContain(listForeign.status)
    expect((listForeignBody.candidates as unknown[] | undefined) ?? []).toHaveLength(0)
    expect(JSON.stringify(listForeignBody)).not.toContain('Alpha')

    const detailForeign = await POST(
      internalRequest({ op: 'detail', noliUserId: HARNESS_NOLI_USER, candidateId: a.candidate.id, matchId: a.match.id }),
    )
    expect([403, 404]).toContain(detailForeign.status)
    expect(JSON.stringify(await readJson(detailForeign))).not.toContain('alpha@fixture.example')

    const shortlistForeign = await readJson(
      await POST(internalRequest({ op: 'shortlist', noliUserId: HARNESS_NOLI_USER, runIds: [a.run.id] })),
    )
    expect(JSON.stringify(shortlistForeign)).not.toContain('Alpha Person')
    expect((shortlistForeign.shortlist as unknown[] | undefined) ?? []).toHaveLength(0)

    // B's own rows are there.
    const own = await POST(internalRequest({ op: 'list', noliUserId: HARNESS_NOLI_USER, runId: b.run.id }))
    expect(own.status).toBe(200)
    const ownRows = (await readJson(own)).candidates as Array<Record<string, unknown>>
    expect(ownRows).toHaveLength(1)

    // And A still sees its own, and never B's.
    actAs(A)
    const ownA = await POST(internalRequest({ op: 'list', noliUserId: HARNESS_NOLI_USER, runId: a.run.id }))
    expect(ownA.status).toBe(200)
    expect((await readJson(ownA)).candidates as unknown[]).toHaveLength(1)
    const detailB = await POST(
      internalRequest({ op: 'detail', noliUserId: HARNESS_NOLI_USER, candidateId: b.candidate.id, matchId: b.match.id }),
    )
    expect([403, 404]).toContain(detailB.status)
  })

  it('B cannot review (accept/reject) A\'s candidate; A can', async () => {
    const { POST } = await import('../../api/internal/candidates/route')
    const a = await seedCustomer(A, 'Alpha')
    const review = () =>
      POST(
        internalRequest({
          op: 'review',
          noliUserId: HARNESS_NOLI_USER,
          candidateId: a.candidate.id,
          matchId: a.match.id,
          verdict: 'rejected',
        }),
      )
    actAs(B)
    const foreign = await review()
    expect(foreign.status).toBe(404)
    expect((await harness.em.findOne(GtmCandidateMatch, { id: a.match.id }))?.fitStatus).toBe('accepted')

    // Control: the same request as the owner goes through.
    actAs(A)
    const own = await review()
    expect(own.status).toBe(200)
    expect((await harness.em.findOne(GtmCandidateMatch, { id: a.match.id }))?.fitStatus).toBe('rejected')
  })
})
