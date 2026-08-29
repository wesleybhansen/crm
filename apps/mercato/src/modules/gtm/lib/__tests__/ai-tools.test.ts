import {
  aiTools,
  gtmGetOpportunityTool,
  gtmListOpportunitiesTool,
  gtmListWorkspacesTool,
  gtmReviewOpportunityTool,
} from '../../ai-tools'
import {
  GtmAuditEvent,
  GtmCandidate,
  GtmCandidateMatch,
  GtmEvidence,
  GtmPlay,
  GtmResearchRun,
  GtmWorkspace,
} from '../../data/entities'
import { FakeEm } from './support/fake-em'

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'

function context(
  em: FakeEm,
  overrides: Partial<{
    organizationId: string
    tenantId: string
    userId: string
  }> = {},
) {
  return {
    organizationId: overrides.organizationId ?? ORG,
    tenantId: overrides.tenantId ?? TENANT,
    userId: overrides.userId ?? USER,
    userFeatures: ['gtm.view', 'gtm.edit'],
    isSuperAdmin: false,
    container: {
      resolve: (name: string) => (name === 'em' ? { fork: () => em } : null),
    },
  } as never
}

async function seed(em: FakeEm) {
  const workspace = em.create(GtmWorkspace, {
    organizationId: ORG,
    tenantId: TENANT,
    name: 'Realtor growth',
    status: 'active',
  })
  em.persist(workspace)
  const play = em.create(GtmPlay, {
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: workspace.id,
    source: 'authored',
    marketType: 'b2c',
    audience: 'South Bay home buyers and sellers',
    signal: 'Public housing questions',
    signalKind: 'social_engagement',
    geography: 'South Bay, California',
    entityUnit: 'opportunities',
    executionEligibility: 'strategy_only',
    leadMode: 'consumer',
    researchEligibility: 'provider_runnable',
    outreachMode: 'manual_only',
  })
  em.persist(play)
  const run = em.create(GtmResearchRun, {
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: workspace.id,
    playId: play.id,
    status: 'completed',
  })
  em.persist(run)
  const candidate = em.create(GtmCandidate, {
    organizationId: ORG,
    tenantId: TENANT,
    researchRunId: run.id,
    workspaceId: workspace.id,
    entityKind: 'opportunity',
    identity: {
      name: 'South Bay first-home questions',
      opportunity_kind: 'community',
      platform: 'Reddit',
      intent_kind: 'buyer_intent',
      audience_description: 'People asking about buying a first home locally',
      urls: ['https://community.example/south-bay/first-home-questions'],
      recommended_action: 'Answer one current question helpfully.',
      provider_private_field: 'must never leave the server',
    },
    dedupeKey: 'fixture-dedupe',
    fitStatus: 'accepted',
    fitScore: '94',
  })
  em.persist(candidate)
  em.persist(
    em.create(GtmEvidence, {
      organizationId: ORG,
      tenantId: TENANT,
      candidateId: candidate.id,
      researchRunId: run.id,
      claim: 'Recent public first-home questions were observed',
      sourceUrl: 'https://community.example/south-bay/first-home-questions',
      observedAt: new Date('2026-08-26T12:00:00.000Z'),
      retrievedAt: new Date('2026-08-26T12:00:00.000Z'),
      confidence: '0.94',
      evidenceType: 'provider_observation',
    }),
  )
  await em.flush()
  return { workspace, play, run, candidate }
}

describe('GTM MCP tools', () => {
  it('registers only bounded scoped discovery and review tools under GTM feature gates', () => {
    expect(aiTools.map((tool) => tool.name)).toEqual([
      'gtm_list_workspaces',
      'gtm_list_opportunities',
      'gtm_get_opportunity',
      'gtm_review_opportunity',
    ])
    expect(aiTools.map((tool) => tool.requiredFeatures)).toEqual([
      ['gtm.view'],
      ['gtm.view'],
      ['gtm.view'],
      ['gtm.edit'],
    ])
    for (const tool of aiTools) expect(tool.inputSchema).toBeDefined()
    expect(aiTools.map((tool) => tool.name).join(' ')).not.toMatch(/execute|send|launch|enrich|provider/)
  })

  it('lists the scoped workspace, play, and demand opportunity without leaking provider-only identity fields', async () => {
    const em = new FakeEm()
    const rows = await seed(em)
    const workspaces = (await gtmListWorkspacesTool.handler({}, context(em))) as any
    expect(workspaces.workspaces[0]).toEqual(
      expect.objectContaining({
        id: rows.workspace.id,
        plays: [
          expect.objectContaining({
            id: rows.play.id,
            entityUnit: 'opportunities',
          }),
        ],
      }),
    )

    const opportunities = (await gtmListOpportunitiesTool.handler(
      {
        workspaceId: rows.workspace.id,
        entityKind: 'opportunity',
        intentKind: 'buyer_intent',
      },
      context(em),
    )) as any
    expect(opportunities.results).toHaveLength(1)
    expect(opportunities.results[0].identity).toEqual(
      expect.objectContaining({
        opportunity_kind: 'community',
        intent_kind: 'buyer_intent',
      }),
    )
    expect(opportunities.results[0].identity.provider_private_field).toBeUndefined()
  })

  it('returns retained evidence and records only a human review audit', async () => {
    const em = new FakeEm()
    const { candidate } = await seed(em)
    const detail = (await gtmGetOpportunityTool.handler({ candidateId: candidate.id }, context(em))) as any
    expect(detail.evidence).toEqual([
      expect.objectContaining({
        sourceUrl: 'https://community.example/south-bay/first-home-questions',
        confidence: 0.94,
      }),
    ])

    const reviewed = (await gtmReviewOpportunityTool.handler(
      {
        candidateId: candidate.id,
        verdict: 'rejected',
        reason: 'Not relevant to this campaign',
      },
      context(em),
    )) as any
    expect(reviewed.result.fitStatus).toBe('rejected')
    expect(em.table(GtmAuditEvent)).toHaveLength(1)
  })

  it('projects the newest play match instead of a stale accepted candidate root', async () => {
    const em = new FakeEm()
    const rows = await seed(em)
    const newerRun = em.create(GtmResearchRun, {
      organizationId: ORG,
      tenantId: TENANT,
      workspaceId: rows.workspace.id,
      playId: rows.play.id,
      status: 'completed',
      createdAt: new Date('2026-08-29T12:00:00.000Z'),
    })
    const match = em.create(GtmCandidateMatch, {
      organizationId: ORG,
      tenantId: TENANT,
      workspaceId: rows.workspace.id,
      playId: rows.play.id,
      researchRunId: newerRun.id,
      candidateId: rows.candidate.id,
      fitStatus: 'review',
      fitScore: '69',
      rejectReason: 'required_criterion_unknown',
      qualificationVersion: 'fit-v7-quality-v20',
      createdAt: new Date('2026-08-29T12:01:00.000Z'),
    })
    em.persist(newerRun)
    em.persist(match)
    await em.flush()

    const listed = (await gtmListOpportunitiesTool.handler(
      { workspaceId: rows.workspace.id, entityKind: 'opportunity' },
      context(em),
    )) as any
    expect(listed.results).toEqual([
      expect.objectContaining({
        id: rows.candidate.id,
        matchId: match.id,
        playId: rows.play.id,
        fitStatus: 'review',
        fitScore: 69,
        rejectReason: 'required_criterion_unknown',
      }),
    ])
    const staleAccepted = (await gtmListOpportunitiesTool.handler(
      { workspaceId: rows.workspace.id, fitStatus: 'accepted' },
      context(em),
    )) as any
    expect(staleAccepted.results).toEqual([])

    const detail = (await gtmGetOpportunityTool.handler(
      { candidateId: rows.candidate.id },
      context(em),
    )) as any
    expect(detail.result).toEqual(expect.objectContaining({ matchId: match.id, fitStatus: 'review' }))

    const reviewed = (await gtmReviewOpportunityTool.handler(
      { candidateId: rows.candidate.id, verdict: 'rejected', reason: 'Human rejected current match' },
      context(em),
    )) as any
    expect(reviewed.result).toEqual(expect.objectContaining({ matchId: match.id, fitStatus: 'rejected' }))
    expect(rows.candidate.fitStatus).toBe('accepted')
    expect(match.fitStatus).toBe('rejected')
  })

  it('keeps foreign-tenant results opaque', async () => {
    const em = new FakeEm()
    const { candidate } = await seed(em)
    await expect(
      gtmGetOpportunityTool.handler(
        { candidateId: candidate.id },
        context(em, { tenantId: '44444444-4444-4444-8444-444444444444' }),
      ),
    ).rejects.toThrow('GTM result not found')
  })
})
