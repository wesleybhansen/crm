import { fixtureConsumerSourceAdapter } from '../adapters/fixture-consumer'
import { createCampaign } from '../campaign/build'
import { FixtureLedger } from '../credits/ledger'
import {
  draftManualOutreachMessage,
  markManualOutreachDraft,
  prepareManualOutreachDraft,
  storeManualOutreachDraft,
} from '../manual-outreach'
import { executeResearchRun } from '../research/execute'
import { buildSourcePlan } from '../research/plan'
import {
  GtmCampaign,
  GtmCandidate,
  GtmCandidateMatch,
  GtmEvidence,
  GtmManualOutreachDraft,
  GtmResearchRun,
  GtmSendAttempt,
} from '../../data/entities'
import { FakeEm } from './support/fake-em'
import { FakeModel } from './support/fake-model'
import { ORG, TENANT, USER, WORKSPACE, ctx, seedPlay } from './support/campaign-fixtures'

describe('consumer lead lifecycle regression', () => {
  it('sources and qualifies named leads, prepares a grounded draft, and never enters automated execution', async () => {
    const em = new FakeEm()
    const play = await seedPlay(em, { marketType: 'b2c', geography: 'California, US' })
    play.entityUnit = 'people'
    play.signalKind = 'social_engagement'
    play.signal = 'Public workshop information request'
    play.audience = 'Adults who publicly requested a local home-design workshop follow-up'
    play.executionEligibility = 'strategy_only'

    const plan = buildSourcePlan(play, [fixtureConsumerSourceAdapter], {
      targetAccepted: 2,
      maxRawCandidates: 2,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) throw new Error(plan.reason)

    const run = em.create(GtmResearchRun, {
      organizationId: ORG,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      playId: play.id,
      status: 'running',
      providerPlan: {
        schemaVersion: plan.schemaVersion,
        planHash: plan.planHash,
        adapterPlan: plan.adapterPlan,
        policy: plan.policy,
        query: plan.query,
      },
      limits: plan.limits,
      estimatedCredits: String(plan.estimatedCredits),
    })
    em.persist(run)
    await em.flush()

    const result = await executeResearchRun({
      em,
      ledger: new FixtureLedger({ poolBalance: 100 }),
      adapters: { [fixtureConsumerSourceAdapter.descriptor.adapter_id]: fixtureConsumerSourceAdapter },
      run,
      play,
      noliOrgId: '77777777-7777-4777-8777-777777777777',
      noliUserId: USER,
      markupMultiplier: 2,
      now: () => new Date('2026-08-26T12:00:00.000Z'),
      scorer: {
        score: () => ({
          fitScore: 95,
          verdict: 'accepted',
          reason: 'public_request_matches_play',
          version: 'fit-v6',
          breakdown: { identity: 20, account: 0, persona: 25, geography: 20, evidence: 30 },
          unknowns: [],
          contradictions: [],
        }),
      },
    })

    expect(result).toEqual(expect.objectContaining({
      status: 'completed',
      candidatesInserted: 2,
      candidateMatchesCreated: 2,
      evidenceInserted: 2,
    }))
    expect(plan.policy).toEqual(expect.objectContaining({
      lead_mode: 'consumer',
      research_eligibility: 'provider_runnable',
      outreach_mode: 'manual_only',
      execution_eligibility: 'strategy_only',
    }))

    const candidate = em.table(GtmCandidate)[0]
    const match = em.table(GtmCandidateMatch).find((row) => row.candidateId === candidate.id)!
    const evidence = em.table(GtmEvidence).filter((row) => row.candidateId === candidate.id)
    expect(candidate).toMatchObject({ entityKind: 'person', fitStatus: 'accepted' })
    expect(candidate.identity).toEqual(expect.objectContaining({
      name: expect.any(String),
      urls: [expect.stringMatching(/^https:\/\/www\.linkedin\.com\/in\//)],
    }))
    expect(evidence[0].license).toEqual(expect.objectContaining({
      customer_display: true,
      export: true,
      manual_outreach_allowed: true,
      automated_email_allowed: false,
    }))

    const prepared = await prepareManualOutreachDraft(em, ctx, {
      workspaceId: WORKSPACE,
      playId: play.id,
      candidateId: candidate.id,
      matchId: match.id,
      channel: 'linkedin',
      idempotencyKey: 'consumer-lifecycle-draft-1',
    })
    const drafted = await draftManualOutreachMessage({
      model: new FakeModel(() => ({
        text: JSON.stringify({
          body: 'Hi Avery, I saw your public request for more information after the neighborhood home-design workshop. I have a concise local planning guide that may help. Would it be useful if I shared it here? No problem if the timing is not right.',
        }),
        model: 'fixture-model',
        tokensIn: 100,
        tokensOut: 48,
      })),
    }, prepared)
    const stored = await storeManualOutreachDraft(em, ctx, prepared, drafted)
    await markManualOutreachDraft(em, ctx, { draftId: stored.draft.id, action: 'copied' })
    await markManualOutreachDraft(em, ctx, { draftId: stored.draft.id, action: 'opened' })

    expect(em.table(GtmManualOutreachDraft)).toHaveLength(1)
    expect(em.table(GtmManualOutreachDraft)[0]).toMatchObject({
      status: 'opened',
      channel: 'linkedin',
    })
    await expect(createCampaign(em, ctx, {
      workspaceId: WORKSPACE,
      playId: play.id,
      name: 'Consumer campaign must not exist',
    })).rejects.toMatchObject({ code: 'play_not_executable' })
    expect(em.table(GtmCampaign)).toHaveLength(0)
    expect(em.table(GtmSendAttempt)).toHaveLength(0)
  })
})
