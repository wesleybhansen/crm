import { FakeEm } from './support/fake-em'
import { ORG, OTHER_ORG, TENANT, WORKSPACE, seedCandidate, seedPlay, seedRun } from './support/campaign-fixtures'
import {
  GTM_LIST_CAP,
  candidateEnrichment,
  listCampaigns,
  listResearchRuns,
} from '../listing'
import { GtmCampaign, GtmContactPoint, GtmEvidence, GtmResearchRun } from '../../data/entities'
import { gtmCampaignsBodySchema, gtmEnrichBodySchema, gtmResearchRunsBodySchema } from '../../data/validators'

/*
 * Read-side list helpers (lib/listing.ts) behind the campaigns/research-runs
 * 'list' ops and the candidates 'list' enrichment. Scoping (org isolation +
 * soft-delete), filters, cap + newest-first order, and the grouped rollup's
 * zero cases, all against the FakeEm slice.
 */

const ctx = { organizationId: ORG, tenantId: TENANT }
const OTHER_WORKSPACE = 'dddddddd-5555-4555-8555-555555555555'
const PLAY_A = 'eeeeeeee-6666-4666-8666-666666666666'
const PLAY_B = 'eeeeeeee-7777-4777-8777-777777777777'

let campaignSeq = 0

function seedCampaign(
  em: FakeEm,
  overrides: Partial<{
    organizationId: string
    workspaceId: string
    playId: string
    name: string
    createdAt: Date
    deletedAt: Date | null
    currentVersionId: string | null
  }> = {},
): GtmCampaign {
  campaignSeq += 1
  const campaign = em.create(GtmCampaign, {
    organizationId: overrides.organizationId ?? ORG,
    tenantId: TENANT,
    workspaceId: overrides.workspaceId ?? WORKSPACE,
    playId: overrides.playId ?? PLAY_A,
    name: overrides.name ?? `Fixture campaign ${campaignSeq}`,
    status: 'draft',
    currentVersionId: overrides.currentVersionId ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-07-01T00:00:00.000Z'),
    deletedAt: overrides.deletedAt ?? null,
  })
  em.persist(campaign)
  return campaign
}

let runSeq = 0

function seedRunRow(
  em: FakeEm,
  overrides: Partial<{
    organizationId: string
    workspaceId: string
    playId: string
    createdAt: Date
    deletedAt: Date | null
  }> = {},
): GtmResearchRun {
  runSeq += 1
  const run = em.create(GtmResearchRun, {
    organizationId: overrides.organizationId ?? ORG,
    tenantId: TENANT,
    workspaceId: overrides.workspaceId ?? WORKSPACE,
    playId: overrides.playId ?? PLAY_A,
    status: 'completed',
    estimatedCredits: `${runSeq}.5`,
    createdAt: overrides.createdAt ?? new Date('2026-07-01T00:00:00.000Z'),
    deletedAt: overrides.deletedAt ?? null,
  })
  em.persist(run)
  return run
}

describe('listCampaigns', () => {
  it('is org-isolated and excludes soft-deleted rows', async () => {
    const em = new FakeEm()
    const mine = seedCampaign(em)
    seedCampaign(em, { organizationId: OTHER_ORG, name: 'Foreign campaign' })
    seedCampaign(em, { deletedAt: new Date(), name: 'Deleted campaign' })
    await em.flush()

    const rows = await listCampaigns(em, ctx)
    expect(rows.map((row) => row.id)).toEqual([mine.id])
  })

  it('filters by workspaceId when given, returns all workspaces otherwise', async () => {
    const em = new FakeEm()
    const inWorkspace = seedCampaign(em)
    const elsewhere = seedCampaign(em, { workspaceId: OTHER_WORKSPACE })
    await em.flush()

    const filtered = await listCampaigns(em, ctx, { workspaceId: WORKSPACE })
    expect(filtered.map((row) => row.id)).toEqual([inWorkspace.id])

    const all = await listCampaigns(em, ctx)
    expect(all.map((row) => row.id).sort()).toEqual([inWorkspace.id, elsewhere.id].sort())
  })

  it('caps at 50 rows, newest first', async () => {
    const em = new FakeEm()
    for (let i = 0; i < GTM_LIST_CAP + 5; i += 1) {
      seedCampaign(em, { createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) })
    }
    await em.flush()

    const rows = await listCampaigns(em, ctx)
    expect(rows).toHaveLength(GTM_LIST_CAP)
    // Newest first: the 5 oldest rows fall off the end.
    expect(rows[0].createdAt.getTime()).toBeGreaterThan(rows[rows.length - 1].createdAt.getTime())
    const times = rows.map((row) => row.createdAt.getTime())
    expect(times).toEqual([...times].sort((a, b) => b - a))
    expect(Math.min(...times)).toBe(Date.UTC(2026, 0, 1, 0, 5))
  })
})

describe('listResearchRuns', () => {
  it('is org-isolated, excludes soft-deleted rows, and filters by workspaceId/playId', async () => {
    const em = new FakeEm()
    const mineA = seedRunRow(em, { playId: PLAY_A })
    const mineB = seedRunRow(em, { playId: PLAY_B })
    seedRunRow(em, { organizationId: OTHER_ORG })
    seedRunRow(em, { deletedAt: new Date() })
    const elsewhere = seedRunRow(em, { workspaceId: OTHER_WORKSPACE, playId: PLAY_B })
    await em.flush()

    const all = await listResearchRuns(em, ctx)
    expect(all.map((row) => row.id).sort()).toEqual([mineA.id, mineB.id, elsewhere.id].sort())

    const byWorkspace = await listResearchRuns(em, ctx, { workspaceId: WORKSPACE })
    expect(byWorkspace.map((row) => row.id).sort()).toEqual([mineA.id, mineB.id].sort())

    const byPlay = await listResearchRuns(em, ctx, { playId: PLAY_B })
    expect(byPlay.map((row) => row.id).sort()).toEqual([mineB.id, elsewhere.id].sort())

    const both = await listResearchRuns(em, ctx, { workspaceId: WORKSPACE, playId: PLAY_B })
    expect(both.map((row) => row.id)).toEqual([mineB.id])
  })

  it('caps at 50 rows, newest first', async () => {
    const em = new FakeEm()
    for (let i = 0; i < GTM_LIST_CAP + 3; i += 1) {
      seedRunRow(em, { createdAt: new Date(Date.UTC(2026, 5, 1, 0, i)) })
    }
    await em.flush()

    const rows = await listResearchRuns(em, ctx)
    expect(rows).toHaveLength(GTM_LIST_CAP)
    const times = rows.map((row) => row.createdAt.getTime())
    expect(times).toEqual([...times].sort((a, b) => b - a))
    expect(Math.min(...times)).toBe(Date.UTC(2026, 5, 1, 0, 3))
  })
})

describe('candidateEnrichment', () => {
  it('flags verified email + counts evidence per candidate, with honest zero cases', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, await seedPlay(em))
    // Verified email + one evidence row (seed defaults).
    const verified = await seedCandidate(em, run)
    // Email exists but only 'found'; no evidence.
    const found = await seedCandidate(em, run, { verificationState: 'found', evidenceClaim: null })
    // Nothing at all.
    const bare = await seedCandidate(em, run, { email: null, evidenceClaim: null })
    // Second evidence row for the verified candidate.
    em.persist(
      em.create(GtmEvidence, {
        organizationId: ORG,
        tenantId: TENANT,
        candidateId: verified.id,
        claim: 'a second synthetic claim',
      }),
    )
    await em.flush()

    const rollup = await candidateEnrichment(em, ctx, [verified.id, found.id, bare.id])
    expect(rollup.get(verified.id)).toMatchObject({ hasVerifiedEmail: true, evidenceCount: 2 })
    expect(rollup.get(found.id)).toMatchObject({ hasVerifiedEmail: false, evidenceCount: 0 })
    expect(rollup.get(bare.id)).toMatchObject({ hasVerifiedEmail: false, evidenceCount: 0 })
  })

  it('a verified non-email channel does not count as a verified email', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, await seedPlay(em))
    const candidate = await seedCandidate(em, run, { email: null, evidenceClaim: null })
    em.persist(
      em.create(GtmContactPoint, {
        organizationId: ORG,
        tenantId: TENANT,
        candidateId: candidate.id,
        channel: 'linkedin',
        value: 'https://linkedin.example/synthetic',
        verificationState: 'verified',
      }),
    )
    await em.flush()

    const rollup = await candidateEnrichment(em, ctx, [candidate.id])
    expect(rollup.get(candidate.id)).toMatchObject({ hasVerifiedEmail: false, evidenceCount: 0 })
  })

  it('is org-isolated and ignores soft-deleted contact points and evidence', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, await seedPlay(em))
    const candidate = await seedCandidate(em, run, { email: null, evidenceClaim: null })
    // Foreign-org rows against the same candidate id never leak into the rollup.
    em.persist(
      em.create(GtmContactPoint, {
        organizationId: OTHER_ORG,
        tenantId: TENANT,
        candidateId: candidate.id,
        channel: 'email',
        value: 'foreign@fixture.example',
        verificationState: 'verified',
      }),
    )
    em.persist(
      em.create(GtmEvidence, {
        organizationId: OTHER_ORG,
        tenantId: TENANT,
        candidateId: candidate.id,
        claim: 'foreign claim',
      }),
    )
    // Soft-deleted rows in the caller org are excluded too.
    em.persist(
      em.create(GtmContactPoint, {
        organizationId: ORG,
        tenantId: TENANT,
        candidateId: candidate.id,
        channel: 'email',
        value: 'deleted@fixture.example',
        verificationState: 'verified',
        deletedAt: new Date(),
      }),
    )
    em.persist(
      em.create(GtmEvidence, {
        organizationId: ORG,
        tenantId: TENANT,
        candidateId: candidate.id,
        claim: 'deleted claim',
        deletedAt: new Date(),
      }),
    )
    await em.flush()

    const rollup = await candidateEnrichment(em, ctx, [candidate.id])
    expect(rollup.get(candidate.id)).toMatchObject({ hasVerifiedEmail: false, evidenceCount: 0 })
  })

  it('runs exactly one grouped query per table for a page (no N+1), and none for an empty page', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, await seedPlay(em))
    const a = await seedCandidate(em, run)
    const b = await seedCandidate(em, run)
    const baseFind = em.find.bind(em)
    let findCalls = 0
    em.find = (async (...args: Parameters<typeof baseFind>) => {
      findCalls += 1
      return baseFind(...args)
    }) as typeof em.find

    await candidateEnrichment(em, ctx, [a.id, b.id])
    expect(findCalls).toBe(2)

    findCalls = 0
    const empty = await candidateEnrichment(em, ctx, [])
    expect(findCalls).toBe(0)
    expect(empty.size).toBe(0)
  })
})

describe('candidate provenance rollup (privacy transparency)', () => {
  // Evidence rows carry where a record came from and when it was seen. The
  // rollup must summarize that WITHOUT adding queries, and must never invent a
  // source for a candidate that has none.
  const evidence = (
    em: FakeEm,
    candidateId: string,
    fields: {
      providerRef?: Record<string, unknown> | null
      sourceUrl?: string | null
      observedAt?: Date | null
      confidence?: string | null
    },
  ) =>
    em.persist(
      em.create(GtmEvidence, {
        organizationId: ORG,
        tenantId: TENANT,
        candidateId,
        claim: 'synthetic claim',
        ...fields,
      }),
    )

  it('summarizes distinct sources, observation window, and best confidence', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, await seedPlay(em))
    const candidate = await seedCandidate(em, run, { email: null, evidenceClaim: null })
    const earlier = new Date('2026-07-01T00:00:00.000Z')
    const later = new Date('2026-07-20T00:00:00.000Z')
    evidence(em, candidate.id, { providerRef: { provider: 'apify' }, observedAt: earlier, confidence: '0.400' })
    evidence(em, candidate.id, { providerRef: { provider: 'apify' }, observedAt: later, confidence: '0.900' })
    evidence(em, candidate.id, { sourceUrl: 'https://www.linkedin.com/posts/example', observedAt: later })
    await em.flush()

    const entry = (await candidateEnrichment(em, ctx, [candidate.id])).get(candidate.id)
    // Duplicate provider collapses; the URL contributes its bare hostname.
    expect(entry?.sources).toEqual(['apify', 'linkedin.com'])
    expect(entry?.sourcesExtra).toBe(0)
    expect(entry?.firstObservedAt).toEqual(earlier)
    expect(entry?.lastObservedAt).toEqual(later)
    expect(entry?.confidence).toBe(0.9)
    expect(entry?.evidenceCount).toBe(3)
  })

  it('caps the source list and counts the remainder rather than truncating silently', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, await seedPlay(em))
    const candidate = await seedCandidate(em, run, { email: null, evidenceClaim: null })
    for (const provider of ['one', 'two', 'three', 'four', 'five']) {
      evidence(em, candidate.id, { providerRef: { provider } })
    }
    await em.flush()

    const entry = (await candidateEnrichment(em, ctx, [candidate.id])).get(candidate.id)
    expect(entry?.sources).toEqual(['one', 'two', 'three'])
    expect(entry?.sourcesExtra).toBe(2)
  })

  it('reports no source rather than inventing one when evidence lacks provenance', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, await seedPlay(em))
    const withNothing = await seedCandidate(em, run, { email: null, evidenceClaim: null })
    const noEvidence = await seedCandidate(em, run, { email: null, evidenceClaim: null })
    // Evidence with neither a provider nor a parseable URL yields no label.
    evidence(em, withNothing.id, { providerRef: null, sourceUrl: 'not a url' })
    await em.flush()

    const rollup = await candidateEnrichment(em, ctx, [withNothing.id, noEvidence.id])
    expect(rollup.get(withNothing.id)).toMatchObject({
      sources: [],
      sourcesExtra: 0,
      firstObservedAt: null,
      confidence: null,
      evidenceCount: 1,
    })
    expect(rollup.get(noEvidence.id)).toMatchObject({
      sources: [],
      firstObservedAt: null,
      lastObservedAt: null,
      confidence: null,
      evidenceCount: 0,
    })
  })

  it('adds no queries: provenance comes from the evidence rows already fetched', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, await seedPlay(em))
    const candidate = await seedCandidate(em, run)
    evidence(em, candidate.id, { providerRef: { provider: 'apify' }, observedAt: new Date() })
    await em.flush()

    const baseFind = em.find.bind(em)
    let findCalls = 0
    em.find = (async (...args: Parameters<typeof baseFind>) => {
      findCalls += 1
      return baseFind(...args)
    }) as typeof em.find

    const entry = (await candidateEnrichment(em, ctx, [candidate.id])).get(candidate.id)
    // Still the same two grouped queries as before provenance existed.
    expect(findCalls).toBe(2)
    expect(entry?.sources).toEqual(['apify'])
  })
})

describe('list op validators (additive union branches)', () => {
  it('campaigns accepts list with and without workspaceId', () => {
    expect(gtmCampaignsBodySchema.safeParse({ op: 'list', noliUserId: 'u1' }).success).toBe(true)
    expect(
      gtmCampaignsBodySchema.safeParse({ op: 'list', noliUserId: 'u1', workspaceId: WORKSPACE })
        .success,
    ).toBe(true)
  })

  it('requires the reviewed content hash for campaign approval', () => {
    expect(
      gtmCampaignsBodySchema.safeParse({
        op: 'approve',
        noliUserId: 'u1',
        campaignId: 'campaign-1',
      }).success,
    ).toBe(false)
    expect(
      gtmCampaignsBodySchema.safeParse({
        op: 'approve',
        noliUserId: 'u1',
        campaignId: 'campaign-1',
        expected_content_hash: 'a'.repeat(64),
      }).success,
    ).toBe(true)
  })

  it('research-runs accepts list with optional workspaceId/playId and still parses existing ops', () => {
    expect(gtmResearchRunsBodySchema.safeParse({ op: 'list', noliUserId: 'u1' }).success).toBe(true)
    expect(
      gtmResearchRunsBodySchema.safeParse({
        op: 'list',
        noliUserId: 'u1',
        workspaceId: WORKSPACE,
        playId: PLAY_A,
      }).success,
    ).toBe(true)
    expect(
      gtmResearchRunsBodySchema.safeParse({ op: 'status', noliUserId: 'u1', runId: 'r1' }).success,
    ).toBe(true)
  })

  it('requires the exact immutable quote hash for provider-running operations', () => {
    const hash = 'a'.repeat(64)
    expect(gtmResearchRunsBodySchema.safeParse({
      op: 'create', noliUserId: 'u1', playId: PLAY_A,
    }).success).toBe(false)
    expect(gtmResearchRunsBodySchema.safeParse({
      op: 'create', noliUserId: 'u1', playId: PLAY_A, expectedPlanHash: hash,
    }).success).toBe(true)
    expect(gtmResearchRunsBodySchema.safeParse({
      op: 'execute', noliUserId: 'u1', runId: 'r1', expectedPlanHash: hash,
    }).success).toBe(true)
    expect(gtmEnrichBodySchema.safeParse({
      op: 'plan', noliUserId: 'u1', workspaceId: WORKSPACE,
    }).success).toBe(true)
    expect(gtmEnrichBodySchema.safeParse({
      op: 'run', noliUserId: 'u1', workspaceId: WORKSPACE,
    }).success).toBe(false)
    expect(gtmEnrichBodySchema.safeParse({
      op: 'run', noliUserId: 'u1', workspaceId: WORKSPACE, expectedPlanHash: hash,
    }).success).toBe(true)
  })
})
