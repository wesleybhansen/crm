import { GtmAuditEvent, GtmCandidate, GtmCandidateMatch } from '../../data/entities'
import {
  isRescuableNearMiss,
  judgeRunOpportunities,
  NEAR_MISS_REASON,
  parseJudgeResponse,
  rescuePromotes,
} from '../research/judge'
import { rescueNearMissesEnabled, rescueWanted } from '../research/judge-runner'
import { gtmResearchRunsBodySchema } from '../../data/validators'
import { FakeEm } from './support/fake-em'
import { FakeModel } from './support/fake-model'
import { ORG, TENANT, seedPlay, seedRun } from './support/campaign-fixtures'

const MAPS = 'https://www.google.com/maps/place/?q=place_id:X'

const crit = (id: string, status: 'pass' | 'fail' | 'unknown') => ({ id, status, hard: true, expected: [], observed: [] })
const KEYWORD_MISS = [crit('account.industry', 'fail'), crit('account.keywords', 'fail'), crit('geography.location', 'pass')]

type Seed = {
  name: string
  status?: string
  rejectReason?: string | null
  criteria?: unknown[]
  urls?: string[]
  kind?: string
  judge?: Record<string, unknown>
}

async function seedListings(em: FakeEm, rows: Seed[]) {
  const play = await seedPlay(em)
  const run = await seedRun(em, play)
  const matches: GtmCandidateMatch[] = []
  for (const [index, row] of rows.entries()) {
    const candidate = em.create(GtmCandidate, {
      organizationId: ORG, tenantId: TENANT, researchRunId: run.id, workspaceId: run.workspaceId,
      entityKind: row.kind ?? 'company',
      identity: { name: row.name, industry: 'HVAC contractor', location: 'Denver, CO', urls: row.urls ?? [MAPS] },
      dedupeKey: `rescue-${run.id}-${index}`, fitStatus: row.status ?? 'rejected',
    })
    em.persist(candidate)
    const match = em.create(GtmCandidateMatch, {
      organizationId: ORG, tenantId: TENANT, workspaceId: run.workspaceId, playId: play.id, researchRunId: run.id,
      candidateId: candidate.id, fitStatus: row.status ?? 'rejected', fitScore: '60',
      rejectReason: row.rejectReason === undefined ? 'required_criterion_mismatch' : row.rejectReason,
      qualification: { reason: 'required_criterion_mismatch', criteria: row.criteria ?? KEYWORD_MISS, ...(row.judge ? { judge: row.judge } : {}) },
    })
    em.persist(match)
    matches.push(match)
  }
  await em.flush()
  return { play, run, matches }
}

const reply = (results: unknown) => new FakeModel(() => ({ text: JSON.stringify({ results }), model: 'fake-gemini', tokensIn: 300, tokensOut: 40 }))

describe('lead check fit rating', () => {
  test('a kept row carries its fit; a malformed or missing fit is null and changes nothing', () => {
    const parsed = parseJudgeResponse(JSON.stringify({ results: [
      { i: 1, keep: true, reason: 'kept', fit: 'strong' },
      { i: 2, keep: true, reason: 'kept', fit: 'amazing' },
      { i: 3, keep: true, reason: 'kept' },
      { i: 4, keep: false, reason: 'not_the_audience', fit: 'strong' },
    ] }), 4)
    expect(parsed.get(1)).toMatchObject({ keep: true, fit: 'strong' })
    expect(parsed.get(2)).toMatchObject({ keep: true, fit: null })
    expect(parsed.get(3)).toMatchObject({ keep: true, fit: null })
    // A reject never carries a fit.
    expect(parsed.get(4)).toMatchObject({ keep: false, fit: null })
  })

  test('only a strong or likely keep promotes', () => {
    expect(rescuePromotes({ keep: true, fit: 'strong' })).toBe(true)
    expect(rescuePromotes({ keep: true, fit: 'likely' })).toBe(true)
    expect(rescuePromotes({ keep: true, fit: 'possible' })).toBe(false)
    expect(rescuePromotes({ keep: true, fit: null })).toBe(false)
    expect(rescuePromotes({ keep: false, fit: 'strong' })).toBe(false)
  })

  test('the explicit rescue op forces the rescue; otherwise only the run limits decide', () => {
    expect(rescueWanted(true, undefined)).toBe(true)
    expect(rescueWanted(true, { rescueNearMisses: false })).toBe(true)
    expect(rescueWanted(undefined, { rescueNearMisses: true })).toBe(true)
    for (const forced of [undefined, false, 'true', 1]) expect(rescueWanted(forced, {})).toBe(false)
  })

  test('the rescue op takes a run id and nothing that could widen it', () => {
    expect(gtmResearchRunsBodySchema.safeParse({ op: 'rescue', noliUserId: 'u1', runId: 'r1' }).success).toBe(true)
    expect(gtmResearchRunsBodySchema.safeParse({ op: 'rescue', noliUserId: 'u1' }).success).toBe(false)
    const parsed = gtmResearchRunsBodySchema.safeParse({ op: 'rescue', noliUserId: 'u1', runId: 'r1', limits: { rescueNearMisses: true } })
    expect(parsed.success && 'limits' in parsed.data).toBe(false)
  })

  test('the rescue flag is read only as an explicit true on the run limits', () => {
    expect(rescueNearMissesEnabled({ rescueNearMisses: true })).toBe(true)
    for (const value of [undefined, null, {}, { rescueNearMisses: 'true' }, { rescueNearMisses: 1 }, { rescueNearMisses: false }]) {
      expect(rescueNearMissesEnabled(value)).toBe(false)
    }
  })
})

describe('near-miss eligibility (hostile inputs, both directions)', () => {
  const base = { rejectReason: 'required_criterion_mismatch', criteria: KEYWORD_MISS, urls: [MAPS] }
  test.each([
    ['keyword only', [crit('account.keywords', 'fail')]],
    ['industry only', [crit('account.industry', 'fail')]],
    ['both, with an unknown geography', [...KEYWORD_MISS.slice(0, 2), crit('geography.location', 'unknown')]],
  ])('rescuable: %s', (_label, criteria) => {
    expect(isRescuableNearMiss({ ...base, criteria })).toBe(true)
  })
  test.each([
    ['an exclusion failure', [...KEYWORD_MISS, crit('exclusion.industry', 'fail')]],
    ['a geography failure', [crit('account.keywords', 'fail'), crit('geography.location', 'fail')]],
    ['a recency failure', [crit('account.keywords', 'fail'), crit('signal.recency', 'fail')]],
    ['a size failure', [crit('account.keywords', 'fail'), crit('account.employee_range', 'fail')]],
    ['no failing criterion', [crit('account.keywords', 'pass')]],
    ['criteria missing', null],
  ])('never rescued: %s', (_label, criteria) => {
    expect(isRescuableNearMiss({ ...base, criteria })).toBe(false)
  })
  test.each([
    ['an exclusion reject', { rejectReason: 'matches_exclusion_criterion' }],
    ['a geography reject', { rejectReason: 'outside_play_geography' }],
    ['a stale reject', { rejectReason: 'outside_signal_recency_window' }],
    ['an AI-check reject', { rejectReason: 'ai_check_not_the_audience' }],
    ['a non-Maps row', { urls: ['https://example.com/about'] }],
    ['a row with no urls', { urls: undefined }],
  ])('never rescued: %s', (_label, change) => {
    expect(isRescuableNearMiss({ ...base, ...change })).toBe(false)
  })
})

describe('near-miss rescue in the lead check', () => {
  test('flag off: no near-miss query, no model call, rule verdicts untouched', async () => {
    const em = new FakeEm()
    const { run, matches } = await seedListings(em, [{ name: 'Peak Mechanical' }])
    const find = jest.spyOn(em, 'find')
    const model = reply([])
    const result = await judgeRunOpportunities({ em, run, play: {}, model })
    expect(result).toMatchObject({ checked: 0, rescued: 0 })
    expect(model.calls).toHaveLength(0)
    const rejectedQueries = find.mock.calls.filter(([, where]) => (where as Record<string, unknown>).fitStatus === 'rejected')
    expect(rejectedQueries).toHaveLength(0)
    expect(matches[0].fitStatus).toBe('rejected')
  })

  test('flag on: strong/likely keeps move to review, possible and rejects stay rejected, ineligible rows are never read', async () => {
    const em = new FakeEm()
    const { run, matches } = await seedListings(em, [
      { name: 'Commercial Mechanical Co' }, // strong
      { name: 'Front Range HVAC' }, // likely
      { name: 'Denver Air Pros' }, // possible
      { name: 'Colorado HVAC Association' }, // reject
      { name: 'Excluded Handyman', criteria: [...KEYWORD_MISS, crit('exclusion.keyword', 'fail')] },
      { name: 'Out Of State', rejectReason: 'outside_play_geography' },
      { name: 'Web Mention', urls: ['https://example.com/a'] },
      { name: 'Already judged', judge: { verdict: 'reject' } },
    ])
    const model = reply([
      { i: 1, keep: true, reason: 'kept', fit: 'strong', note: 'commercial mechanical subcontractor' },
      { i: 2, keep: true, reason: 'kept', fit: 'likely', note: 'hvac contractor' },
      { i: 3, keep: true, reason: 'kept', fit: 'possible', note: 'likely residential' },
      { i: 4, keep: false, reason: 'not_the_audience', note: 'trade association' },
    ])
    const result = await judgeRunOpportunities({ em, run, play: { audience: 'Commercial specialty subcontractors' }, model, rescueNearMisses: true })
    expect(result).toMatchObject({ rescued: 2, checked: 4, failed: false })
    expect(model.calls).toHaveLength(1)
    expect(model.calls[0].system).toMatch(/business listings/)
    expect(model.calls[0].prompt).not.toMatch(/Excluded Handyman|Out Of State|Web Mention|Already judged/)
    const [strong, likely, possible, association, ...rest] = matches
    for (const promoted of [strong, likely]) {
      expect(promoted).toMatchObject({ fitStatus: 'review', rejectReason: NEAR_MISS_REASON })
      expect((promoted.qualification as Record<string, any>).judge).toMatchObject({ verdict: 'keep', rescued: true })
      expect((promoted.qualification as Record<string, any>).rescued_from).toBe('required_criterion_mismatch')
    }
    expect(possible).toMatchObject({ fitStatus: 'rejected', rejectReason: 'required_criterion_mismatch' })
    expect((possible.qualification as Record<string, any>).judge).toMatchObject({ fit: 'possible', rescued: false })
    expect(association).toMatchObject({ fitStatus: 'rejected', rejectReason: 'required_criterion_mismatch' })
    for (const row of rest) expect(row.fitStatus).toBe('rejected')
    const [audit] = await em.find(GtmAuditEvent, { action: 'gtm.research_run.lead_check' })
    expect(audit.metadata).toMatchObject({ rescued: 2, rescue_enabled: true })
  })

  test('a row a human already decided is never rescued', async () => {
    const em = new FakeEm()
    const { run, matches } = await seedListings(em, [{ name: 'Owner said no' }])
    em.persist(em.create(GtmAuditEvent, {
      organizationId: ORG, tenantId: TENANT, actor: 'user_id', action: 'gtm.candidate_match.review_override',
      objectType: 'gtm_candidate_match', objectId: matches[0].id,
    }))
    await em.flush()
    const model = reply([{ i: 1, keep: true, reason: 'kept', fit: 'strong' }])
    const result = await judgeRunOpportunities({ em, run, play: {}, model, rescueNearMisses: true })
    expect(result.rescued).toBe(0)
    expect(model.calls).toHaveLength(0)
    expect(matches[0].fitStatus).toBe('rejected')
  })

  test('a model failure on the rescue batch leaves every near miss rejected', async () => {
    const em = new FakeEm()
    const { run, matches } = await seedListings(em, [{ name: 'Peak Mechanical' }])
    const broken = new FakeModel(() => { throw new Error('down') })
    const result = await judgeRunOpportunities({ em, run, play: {}, model: broken, rescueNearMisses: true })
    expect(result).toMatchObject({ rescued: 0, failed: true })
    expect(matches[0].fitStatus).toBe('rejected')
  })
})
