import { GtmAuditEvent, GtmCandidate, GtmCandidateMatch } from '../../data/entities'
import { buildJudgeRequest, judgeRunOpportunities, parseJudgeResponse } from '../research/judge'
import { FakeEm } from './support/fake-em'
import { FakeModel } from './support/fake-model'
import { ORG, TENANT, seedPlay, seedRun } from './support/campaign-fixtures'

async function postLeads(em: FakeEm, posts: Array<{ text: string; status?: string; qualification?: Record<string, unknown> }>) {
  const play = await seedPlay(em)
  const run = await seedRun(em, play)
  const matches: GtmCandidateMatch[] = []
  for (const [index, post] of posts.entries()) {
    const candidate = em.create(GtmCandidate, {
      organizationId: ORG, tenantId: TENANT, researchRunId: run.id, workspaceId: run.workspaceId,
      entityKind: 'opportunity', identity: { name: post.text.slice(0, 40), audience_description: post.text, urls: [`https://reddit.com/p/${index}`] },
      dedupeKey: `judge-${run.id}-${index}`, fitStatus: post.status ?? 'accepted',
    })
    em.persist(candidate)
    const match = em.create(GtmCandidateMatch, {
      organizationId: ORG, tenantId: TENANT, workspaceId: run.workspaceId, playId: play.id, researchRunId: run.id,
      candidateId: candidate.id, fitStatus: post.status ?? 'accepted', fitScore: '98', qualification: post.qualification ?? { reason: 'meets_fit_rules' },
    })
    em.persist(match)
    matches.push(match)
  }
  await em.flush()
  return { run, matches }
}

const reply = (results: unknown) => new FakeModel(() => ({ text: JSON.stringify({ results }), model: 'fake-gemini', tokensIn: 400, tokensOut: 60 }))

describe('AI lead check', () => {
  test('rejects junk and competitors, keeps real asks, records why, and meters every call', async () => {
    const em = new FakeEm()
    const { run, matches } = await postLeads(em, [
      { text: 'We are selling our house in Torrance next spring. How do we pick a listing agent?' },
      { text: '[WTS] ASUS Zenbook for 4500 AED, DM me' },
      { text: 'Top producing agent here! Just listed a stunning 3 bed in Redondo, call me today', status: 'review' },
    ])
    const model = reply([
      { i: 1, keep: true, reason: 'kept', note: 'homeowner planning to sell' },
      { i: 2, keep: false, reason: 'seller_or_promotion', note: 'laptop for sale' },
      { i: 3, keep: false, reason: 'competitor', note: 'agent advertising a listing' },
    ])
    const metered: string[] = []
    const result = await judgeRunOpportunities({
      em, run, play: { audience: 'Homeowners in the South Bay planning to sell', geography: 'Torrance, CA' }, model,
      meter: async (usage) => { metered.push(`${usage.feature}:${usage.status}`) },
    })
    expect(result).toMatchObject({ checked: 3, rejected: 2, kept: 1, failed: false })
    const stored = await em.find(GtmCandidateMatch, { researchRunId: run.id })
    const byId = new Map(stored.map((row) => [row.id, row]))
    expect(byId.get(matches[0].id)?.fitStatus).toBe('accepted')
    expect(byId.get(matches[1].id)).toMatchObject({ fitStatus: 'rejected', rejectReason: 'ai_check_seller_or_promotion' })
    expect(byId.get(matches[2].id)).toMatchObject({ fitStatus: 'rejected', rejectReason: 'ai_check_competitor' })
    expect((byId.get(matches[0].id)?.qualification as Record<string, unknown>).judge).toMatchObject({ verdict: 'keep' })
    expect(metered).toEqual(['gtm-lead-check:succeeded'])
    expect(await em.find(GtmAuditEvent, { action: 'gtm.research_run.lead_check' })).toHaveLength(1)
  })

  test('the prompt protects homeowners selling their own home', () => {
    const request = buildJudgeRequest({ audience: 'Home sellers' }, [{ matchId: 'm', text: 'Selling our home by owner', url: null }])
    expect(request.system).toMatch(/THEIR OWN home/)
    expect(request.prompt).toContain('<posts>')
  })

  test('a malformed or partial answer keeps the rows; unknown reasons never reject', () => {
    expect(parseJudgeResponse('not json', 2).size).toBe(0)
    const parsed = parseJudgeResponse(JSON.stringify({ results: [{ i: 1, keep: false, reason: 'vibes' }, { i: 9, keep: false, reason: 'competitor' }] }), 2)
    expect(parsed.get(1)?.keep).toBe(true)
    expect(parsed.has(9)).toBe(false)
  })

  test('rows already checked or decided are never re-read, and a model failure changes nothing', async () => {
    const em = new FakeEm()
    const { run } = await postLeads(em, [
      { text: 'Already checked post', qualification: { judge: { verdict: 'keep' } } },
      { text: 'Rejected by the rules', status: 'rejected' },
    ])
    const model = reply([])
    const none = await judgeRunOpportunities({ em, run, play: {}, model })
    expect(none.checked).toBe(0)
    expect(model.calls).toHaveLength(0)

    const fresh = await postLeads(em, [{ text: 'How long does it take to sell a condo here?' }])
    const broken = new FakeModel(() => { throw new Error('provider down') })
    const failed = await judgeRunOpportunities({ em, run: fresh.run, play: {}, model: broken })
    expect(failed).toMatchObject({ checked: 0, failed: true })
    const [row] = await em.find(GtmCandidateMatch, { researchRunId: fresh.run.id })
    expect(row.fitStatus).toBe('accepted')
  })
  test('business listings get their own check: an association or university on an independent play is rejected', async () => {
    const em = new FakeEm()
    const play = await seedPlay(em)
    const run = await seedRun(em, play)
    const names = ['Uptown Dental', 'University of Minnesota School of Dentistry']
    for (const [index, name] of names.entries()) {
      const candidate = em.create(GtmCandidate, {
        organizationId: ORG, tenantId: TENANT, researchRunId: run.id, workspaceId: run.workspaceId, entityKind: 'company',
        identity: { name, industry: 'Dentist', location: '1406 W Lake St, Minneapolis, MN 55408', urls: ['https://www.google.com/maps/place/?q=place_id:X'] },
        dedupeKey: `biz-${index}`, fitStatus: 'accepted',
      })
      em.persist(candidate)
      em.persist(em.create(GtmCandidateMatch, {
        organizationId: ORG, tenantId: TENANT, workspaceId: run.workspaceId, playId: play.id, researchRunId: run.id,
        candidateId: candidate.id, fitStatus: 'accepted', fitScore: '90', qualification: {},
      }))
    }
    await em.flush()
    const model = reply([{ i: 1, keep: true, reason: 'kept' }, { i: 2, keep: false, reason: 'not_the_audience', note: 'university dental school' }])
    const result = await judgeRunOpportunities({ em, run, play: { audience: 'Independent dental clinics in the Twin Cities' }, model })
    expect(result).toMatchObject({ checked: 2, rejected: 1 })
    expect(model.calls[0].system).toMatch(/business listings/)
    expect(model.calls[0].prompt).toContain('category: Dentist')
    const rejected = (await em.find(GtmCandidateMatch, { researchRunId: run.id })).filter((row) => row.fitStatus === 'rejected')
    expect(rejected.map((row) => row.rejectReason)).toEqual(['ai_check_not_the_audience'])
  })
})
