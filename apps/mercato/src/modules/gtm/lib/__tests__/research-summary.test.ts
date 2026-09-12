import { FakeEm } from './support/fake-em'
import { GtmCandidateMatch, GtmPlay, GtmResearchRun } from '../../data/entities'
import { researchFeatureForOp } from '../authorize'
import { gtmResearchRunsBodySchema } from '../../data/validators'
import {
  centsFromCredits,
  fitReasonLabel,
  sourcesSearchedFromPlan,
  summarizeResearchRun,
} from '../research/summary'

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '11111111-9999-4999-8999-999999999999'
const TENANT = '22222222-2222-4222-8222-222222222222'
const WORKSPACE = '33333333-3333-4333-8333-333333333333'
const NOLI_USER = '55555555-5555-4555-8555-555555555555'
const ctx = { organizationId: ORG, tenantId: TENANT }

function seedPlay(em: FakeEm, overrides: Partial<GtmPlay> = {}): GtmPlay {
  const play = em.create(GtmPlay, {
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    source: 'imported',
    name: 'Fresno HVAC owners hiring',
    audience: 'HVAC owners in Fresno',
    marketType: 'b2b',
    executionEligibility: 'executable',
    ...overrides,
  })
  em.persist(play)
  return play
}

function seedRun(em: FakeEm, play: GtmPlay, overrides: Partial<GtmResearchRun> = {}): GtmResearchRun {
  const run = em.create(GtmResearchRun, {
    organizationId: play.organizationId,
    tenantId: play.tenantId,
    workspaceId: play.workspaceId,
    playId: play.id,
    status: 'completed',
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    ...overrides,
  })
  em.persist(run)
  return run
}

function seedMatch(
  em: FakeEm,
  run: GtmResearchRun,
  fitStatus: string,
  rejectReason: string | null = null,
  qualification: Record<string, unknown> | null = null,
): GtmCandidateMatch {
  const match = em.create(GtmCandidateMatch, {
    organizationId: run.organizationId,
    tenantId: run.tenantId,
    workspaceId: run.workspaceId,
    playId: run.playId,
    researchRunId: run.id,
    candidateId: `cand-${Math.random().toString(16).slice(2)}`,
    fitStatus,
    rejectReason,
    qualification,
  })
  em.persist(match)
  return match
}

const EXECUTED_PLAN = {
  adapterPlan: [{ adapter_id: 'fixture-source' }, { adapter_id: 'apify-reddit' }],
  execution: {
    status: 'completed',
    funnel: { raw_candidates_found: 10, accepted: 2, review: 1, rejected: 4 },
    batches: [
      {
        adapter_id: 'fixture-source',
        outcome: 'ok',
        raw_candidates_found: 8,
        charged_credits: 5000,
        ledger_status: 'charged',
      },
      {
        adapter_id: 'fixture-source',
        outcome: 'partial',
        raw_candidates_found: 2,
        charged_credits: 2500,
        ledger_status: 'partially_charged',
      },
      {
        adapter_id: 'apify-reddit',
        outcome: 'skipped_max_credits',
        raw_candidates_found: 0,
        charged_credits: 0,
        ledger_status: null,
      },
    ],
  },
}

describe('summarizeResearchRun (internal research-runs op summary)', () => {
  it('summarises a completed run: sources, funnel, cents, rate, and labelled top filters', async () => {
    const em = new FakeEm()
    const play = seedPlay(em)
    const run = seedRun(em, play, {
      providerPlan: EXECUTED_PLAN,
      estimatedCredits: '12500',
      reconciledCredits: '7500',
      startedAt: new Date('2026-09-01T10:00:00.000Z'),
      completedAt: new Date('2026-09-01T10:02:30.000Z'),
    })
    seedMatch(em, run, 'accepted', null, { reason: 'meets_fit_rules' })
    seedMatch(em, run, 'accepted', null, { reason: 'accepted_size_unconfirmed' })
    seedMatch(em, run, 'review', 'insufficient_decisive_fit_data')
    seedMatch(em, run, 'rejected', 'public_destination_inaccessible')
    seedMatch(em, run, 'rejected', 'public_destination_inaccessible')
    seedMatch(em, run, 'rejected', 'outside_signal_recency_window')
    seedMatch(em, run, 'rejected', 'some_new_code')
    await em.flush()

    const summary = await summarizeResearchRun(em, ctx, { runId: run.id })
    expect(summary).not.toBeNull()
    expect(summary).toMatchObject({
      run_id: run.id,
      play_id: play.id,
      play_name: 'Fresno HVAC owners hiring',
      status: 'completed',
      elapsed_ms: 150_000,
      found: 10,
      accepted: 2,
      needs_review: 1,
      filtered_out: 4,
      size_unconfirmed: 1,
      // 12500 credits at 2500 credits per cent = 5 cents quoted
      projected_cost_cents: 5,
      // per-operation ceil: 5000 -> 2, 2500 -> 1
      spent_cents: 3,
      cost_per_accepted_cents: 2,
      qualification_rate: 0.2,
    })
    expect(summary!.started_at).toEqual(new Date('2026-09-01T10:00:00.000Z'))
    expect(summary!.finished_at).toEqual(new Date('2026-09-01T10:02:30.000Z'))
    expect(summary!.sources_searched).toEqual([
      { source: 'fixture-source', searched: true, found: 10 },
      { source: 'apify-reddit', searched: false, found: 0 },
    ])
    expect(summary!.top_filters).toEqual([
      { reason: 'public_destination_inaccessible', label: 'Public link could not be reached', count: 2 },
      { reason: 'outside_signal_recency_window', label: 'Signal is older than the recency window', count: 1 },
      { reason: 'some_new_code', label: 'Some new code', count: 1 },
    ])
  })

  it('caps top_filters at six reasons, largest first', async () => {
    const em = new FakeEm()
    const run = seedRun(em, seedPlay(em), { providerPlan: EXECUTED_PLAN })
    for (let i = 0; i < 8; i += 1) {
      for (let n = 0; n <= i; n += 1) seedMatch(em, run, 'rejected', `reason_${i}`)
    }
    await em.flush()
    const summary = await summarizeResearchRun(em, ctx, { runId: run.id })
    expect(summary!.top_filters.map((row) => row.count)).toEqual([8, 7, 6, 5, 4, 3])
    expect(summary!.top_filters[0]).toEqual({ reason: 'reason_7', label: 'Reason 7', count: 8 })
  })

  it('returns null found-rate and no spend for a priced run with nothing found', async () => {
    const em = new FakeEm()
    const run = seedRun(em, seedPlay(em), {
      status: 'priced',
      providerPlan: { adapterPlan: [{ adapter_id: 'fixture-source' }] },
      estimatedCredits: '2500',
      reconciledCredits: null,
      startedAt: null,
      completedAt: null,
    })
    await em.flush()
    const summary = await summarizeResearchRun(em, ctx, { runId: run.id })
    expect(summary).toMatchObject({
      status: 'priced',
      found: 0,
      accepted: 0,
      needs_review: 0,
      filtered_out: 0,
      size_unconfirmed: 0,
      elapsed_ms: null,
      projected_cost_cents: 1,
      spent_cents: null,
      cost_per_accepted_cents: null,
      qualification_rate: null,
      top_filters: [],
      sources_searched: [{ source: 'fixture-source', searched: false, found: 0 }],
    })
  })

  it('cost_per_accepted_cents is null when nothing was accepted even though credits were spent', async () => {
    const em = new FakeEm()
    const run = seedRun(em, seedPlay(em), {
      providerPlan: EXECUTED_PLAN,
      estimatedCredits: '12500',
      reconciledCredits: '7500',
    })
    seedMatch(em, run, 'rejected', 'below_fit_threshold')
    await em.flush()
    const summary = await summarizeResearchRun(em, ctx, { runId: run.id })
    expect(summary).toMatchObject({
      found: 10,
      accepted: 0,
      spent_cents: 3,
      cost_per_accepted_cents: null,
      qualification_rate: 0,
    })
  })

  it('playId resolves to the most recent run for that play', async () => {
    const em = new FakeEm()
    const play = seedPlay(em)
    seedRun(em, play, { createdAt: new Date('2026-08-01T00:00:00.000Z') })
    const newest = seedRun(em, play, { createdAt: new Date('2026-09-05T00:00:00.000Z') })
    seedRun(em, play, { createdAt: new Date('2026-08-15T00:00:00.000Z') })
    await em.flush()
    const summary = await summarizeResearchRun(em, ctx, { playId: play.id })
    expect(summary!.run_id).toBe(newest.id)
  })

  it('is tenant scoped: a foreign run, a foreign play, a deleted run, and a run/play mismatch all resolve to nothing', async () => {
    const em = new FakeEm()
    const ownPlay = seedPlay(em)
    const ownRun = seedRun(em, ownPlay)
    const foreignPlay = seedPlay(em, { organizationId: OTHER_ORG })
    const foreignRun = seedRun(em, foreignPlay)
    const deleted = seedRun(em, ownPlay, { deletedAt: new Date() })
    await em.flush()

    expect(await summarizeResearchRun(em, ctx, { runId: foreignRun.id })).toBeNull()
    expect(await summarizeResearchRun(em, ctx, { playId: foreignPlay.id })).toBeNull()
    expect(await summarizeResearchRun(em, ctx, { runId: deleted.id })).toBeNull()
    expect(await summarizeResearchRun(em, ctx, { runId: ownRun.id, playId: foreignPlay.id })).toBeNull()
    expect(await summarizeResearchRun(em, ctx, { runId: ownRun.id })).not.toBeNull()
    expect(await summarizeResearchRun(em, ctx, {})).toBeNull()
  })

  it('falls back to candidate rows when a legacy run has no match rows', async () => {
    const em = new FakeEm()
    const run = seedRun(em, seedPlay(em))
    const { GtmCandidate } = await import('../../data/entities')
    for (const [fitStatus, rejectReason] of [
      ['accepted', null],
      ['rejected', 'no_domain'],
    ] as const) {
      em.persist(
        em.create(GtmCandidate, {
          organizationId: ORG,
          tenantId: TENANT,
          workspaceId: WORKSPACE,
          researchRunId: run.id,
          entityKind: 'company',
          identity: { name: 'Legacy Co' },
          dedupeKey: `legacy-${fitStatus}`,
          fitStatus,
          rejectReason,
        }),
      )
    }
    await em.flush()
    const summary = await summarizeResearchRun(em, ctx, { runId: run.id })
    expect(summary).toMatchObject({
      found: 2,
      accepted: 1,
      filtered_out: 1,
      qualification_rate: 0.5,
      top_filters: [{ reason: 'no_domain', label: 'No company domain found', count: 1 }],
    })
  })

  it('helpers: labels, cents rounding, and planned-vs-searched sources', () => {
    expect(fitReasonLabel('size_unknown')).toBe('Team size unknown')
    expect(fitReasonLabel('opportunity_intent_mismatch')).toBe('No buying intent in the conversation')
    expect(fitReasonLabel('brand_new:reason-code')).toBe('Brand new reason code')
    expect(fitReasonLabel('')).toBe('No reason recorded')
    expect(centsFromCredits(0)).toBe(0)
    expect(centsFromCredits(1)).toBe(1)
    expect(centsFromCredits(2500)).toBe(1)
    expect(centsFromCredits(2501)).toBe(2)
    expect(sourcesSearchedFromPlan(null)).toEqual([])
    expect(
      sourcesSearchedFromPlan({
        execution: {
          batches: [
            { adapter_id: 'x', outcome: 'blocked_insufficient_credits', raw_candidates_found: 0 },
            { adapter_id: 'y', outcome: 'no_result', raw_candidates_found: 0 },
          ],
        },
      }),
    ).toEqual([
      { source: 'x', searched: false, found: 0 },
      { source: 'y', searched: true, found: 0 },
    ])
  })

  it('is a read op on the route contract', () => {
    expect(researchFeatureForOp('summary')).toBe('gtm.view')
    expect(
      gtmResearchRunsBodySchema.safeParse({ op: 'summary', noliUserId: NOLI_USER, playId: WORKSPACE }).success,
    ).toBe(true)
    expect(
      gtmResearchRunsBodySchema.safeParse({ op: 'summary', noliUserId: NOLI_USER }).success,
    ).toBe(true)
  })
})
