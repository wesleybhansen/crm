import {
  isUuid,
  shapePlaySummary,
  shapePlayDetail,
  buildPlayCounts,
  deriveEstimatedReach,
  reachConfidence,
  type GtmPlayRowLike,
} from '../play-shape'

const fullRow: GtmPlayRowLike = {
  id: '11111111-2222-4333-8444-555555555555',
  workspaceId: '99999999-8888-4777-8666-555555555555',
  source: 'imported',
  name: 'Seed-stage US SaaS founders',
  marketType: 'b2b',
  audience: 'US B2B SaaS founders who just raised a seed round',
  signal: 'Recent seed announcement',
  sourceHint: 'Crunchbase-style funding feeds',
  geography: 'United States',
  recencyWindow: '90 days',
  whyNow: 'New budget lands right after a raise',
  recommendedAngle: 'Congratulate, then offer the ops teardown',
  supportedChannels: ['email', 'linkedin'],
  estimatedSize: { label: '500-1000', low: 500, high: 1000 },
  entityUnit: 'companies',
  estimateMethod: 'source volume sampling',
  estimateBasis: 'sampled',
  confidence: 'medium',
  confidenceRationale: 'Funding feeds are dense but noisy',
  likelyBuyer: 'Founder or head of ops',
  executionEligibility: 'executable',
  eligibilityReason: 'US B2B audience with a findable source. Eligible for automated execution.',
  eligibilityEvaluatedAt: new Date('2026-07-23T10:00:00.000Z'),
  leadMode: 'business',
  researchEligibility: 'provider_runnable',
  researchEligibilityReason: 'Approved business source required.',
  outreachMode: 'automated_email',
  outreachPolicyReason: 'Governed B2B email is available.',
  policyFlags: [],
  policyEvaluatedAt: new Date('2026-08-26T10:00:00.000Z'),
  createdAt: new Date('2026-07-23T09:00:00.000Z'),
  updatedAt: new Date('2026-07-23T09:30:00.000Z'),
}

describe('isUuid', () => {
  it('accepts canonical uuids in either case', () => {
    expect(isUuid('11111111-2222-4333-8444-555555555555')).toBe(true)
    expect(isUuid('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE')).toBe(true)
  })

  it('rejects non-uuid strings', () => {
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid('')).toBe(false)
    expect(isUuid('11111111222243338444555555555555')).toBe(false)
    expect(isUuid("'; drop table gtm_plays; --")).toBe(false)
  })
})

describe('shapePlaySummary', () => {
  it('maps entity properties onto the SPEC snake_case summary shape', () => {
    expect(shapePlaySummary(fullRow)).toEqual({
      id: fullRow.id,
      source: 'imported',
      name: 'Seed-stage US SaaS founders',
      market_type: 'b2b',
      audience: fullRow.audience,
      signal: fullRow.signal,
      source_hint: fullRow.sourceHint,
      geography: 'United States',
      confidence: 'medium',
      likely_buyer: 'Founder or head of ops',
      why_now: 'New budget lands right after a raise',
      estimated_reach: {
        low: 500,
        high: 1000,
        unit: 'companies',
        confidence: 'fair',
        method: 'source volume sampling',
      },
      execution_eligibility: 'executable',
      eligibility_reason: fullRow.eligibilityReason,
      lead_mode: 'business',
      research_eligibility: 'provider_runnable',
      research_eligibility_reason: fullRow.researchEligibilityReason,
      outreach_mode: 'automated_email',
      outreach_policy_reason: fullRow.outreachPolicyReason,
      policy_flags: [],
      size_confirm_later: false,
      created_at: '2026-07-23T09:00:00.000Z',
    })
  })

  it('reports the per-play team-size setting from provider_query', () => {
    expect(shapePlaySummary({ ...fullRow, providerQuery: { size_confirm_later: true } }).size_confirm_later)
      .toBe(true)
    expect(shapePlaySummary({ ...fullRow, providerQuery: { size_confirm_later: 'true' } }).size_confirm_later)
      .toBe(true)
    expect(shapePlaySummary({ ...fullRow, providerQuery: { employee_ranges: ['2 to 50'] } }).size_confirm_later)
      .toBe(false)
    expect(shapePlaySummary({ ...fullRow, providerQuery: null }).size_confirm_later).toBe(false)
  })

  it('nulls every optional field that is absent', () => {
    const sparse: GtmPlayRowLike = {
      id: fullRow.id,
      workspaceId: fullRow.workspaceId,
      source: 'imported',
      executionEligibility: 'strategy_only',
      createdAt: new Date('2026-07-23T09:00:00.000Z'),
      updatedAt: new Date('2026-07-23T09:00:00.000Z'),
    }
    const summary = shapePlaySummary(sparse)
    expect(summary.name).toBeNull()
    expect(summary.market_type).toBeNull()
    expect(summary.audience).toBeNull()
    expect(summary.signal).toBeNull()
    expect(summary.source_hint).toBeNull()
    expect(summary.geography).toBeNull()
    expect(summary.confidence).toBeNull()
    expect(summary.likely_buyer).toBeNull()
    expect(summary.why_now).toBeNull()
    expect(summary.estimated_reach).toEqual({ low: null, high: null, unit: null, confidence: null, method: null })
    expect(summary.eligibility_reason).toBeNull()
    expect(summary.lead_mode).toBeNull()
    expect(summary.research_eligibility).toBeNull()
    expect(summary.outreach_mode).toBeNull()
    expect(summary.policy_flags).toEqual([])
  })
})

describe('shapePlayDetail', () => {
  it('carries every SPEC field including likely_buyer and estimate fields', () => {
    const detail = shapePlayDetail(fullRow)
    expect(detail).toMatchObject({
      workspace_id: fullRow.workspaceId,
      recency_window: '90 days',
      why_now: fullRow.whyNow,
      recommended_angle: fullRow.recommendedAngle,
      supported_channels: ['email', 'linkedin'],
      estimated_size: { label: '500-1000', low: 500, high: 1000 },
      entity_unit: 'companies',
      estimate_method: 'source volume sampling',
      estimate_basis: 'sampled',
      confidence_rationale: fullRow.confidenceRationale,
      likely_buyer: 'Founder or head of ops',
      why_now: fullRow.whyNow,
      estimated_reach: { low: 500, high: 1000, unit: 'companies', confidence: 'fair', method: 'source volume sampling' },
      eligibility_evaluated_at: '2026-07-23T10:00:00.000Z',
      policy_evaluated_at: '2026-08-26T10:00:00.000Z',
      updated_at: '2026-07-23T09:30:00.000Z',
    })
    // and everything from the summary shape
    expect(detail.name).toBe('Seed-stage US SaaS founders')
    expect(detail.audience).toBe(fullRow.audience)
    expect(detail.execution_eligibility).toBe('executable')
    expect(detail.created_at).toBe('2026-07-23T09:00:00.000Z')
  })

  it('nulls eligibility_evaluated_at when never evaluated', () => {
    const detail = shapePlayDetail({ ...fullRow, eligibilityEvaluatedAt: null })
    expect(detail.eligibility_evaluated_at).toBeNull()
  })
})

describe('deriveEstimatedReach', () => {
  // The shape every imported audience-play row actually stores (131 of 154
  // live rows at the time of writing): {low, high, label} numbers, a free-text
  // entity_unit, a "Modeled from ..." method and a low|medium|high grade.
  it('maps a stored low/high range with the engine confidence words', () => {
    expect(
      deriveEstimatedReach({
        estimatedSize: { low: 120, high: 180, label: 'modeled range: roughly 120 to 180 practices' },
        entityUnit: 'businesses',
        estimateMethod: 'Modeled from state dental board registrations.',
        confidence: 'medium',
      }),
    ).toEqual({
      low: 120,
      high: 180,
      unit: 'businesses',
      confidence: 'fair',
      method: 'Modeled from state dental board registrations.',
    })
    expect(deriveEstimatedReach({ estimatedSize: { low: 1, high: 2 }, confidence: 'low' }).confidence).toBe('rough')
    expect(deriveEstimatedReach({ estimatedSize: { low: 1, high: 2 }, confidence: 'HIGH ' }).confidence).toBe('solid')
  })

  it('carries a single point estimate on both bounds', () => {
    expect(deriveEstimatedReach({ estimatedSize: { value: 500 }, entityUnit: 'people', confidence: 'high' }))
      .toEqual({ low: 500, high: 500, unit: 'people', confidence: 'solid', method: null })
    // only one bound stored: the other stays null rather than being invented
    expect(deriveEstimatedReach({ estimatedSize: { low: 40, label: 'at least 40' }, entityUnit: 'companies' }))
      .toMatchObject({ low: 40, high: null })
    expect(deriveEstimatedReach({ estimatedSize: { high: '90' }, entityUnit: 'companies' }))
      .toMatchObject({ low: null, high: 90 })
  })

  it('never invents numbers when the estimate is missing or non-numeric', () => {
    const empty = { low: null, high: null, unit: null, confidence: null, method: null }
    expect(deriveEstimatedReach({})).toEqual(empty)
    expect(deriveEstimatedReach({ estimatedSize: null, entityUnit: null, estimateMethod: null, confidence: null })).toEqual(empty)
    // label-only: the text is never parsed for numbers
    expect(deriveEstimatedReach({ estimatedSize: { label: 'dozens per week' }, entityUnit: 'post', estimateMethod: 'modeled' }))
      .toEqual({ low: null, high: null, unit: 'post', confidence: null, method: 'modeled' })
    expect(deriveEstimatedReach({ estimatedSize: { low: 'about 120', high: NaN, value: -5 } }))
      .toMatchObject({ low: null, high: null })
    expect(deriveEstimatedReach({ estimatedSize: { low: true, high: { n: 3 } } }))
      .toMatchObject({ low: null, high: null })
    // an array or scalar stored in the jsonb column is treated as no estimate
    expect(deriveEstimatedReach({ estimatedSize: [120, 180] as unknown as Record<string, unknown> }))
      .toMatchObject({ low: null, high: null })
  })

  it('maps an unknown or unrecognised confidence to null', () => {
    expect(reachConfidence('unknown')).toBeNull()
    expect(reachConfidence(null)).toBeNull()
    expect(reachConfidence('')).toBeNull()
    expect(reachConfidence('very high')).toBeNull()
    expect(reachConfidence(0.8)).toBeNull()
    expect(reachConfidence('fair')).toBe('fair')
    expect(deriveEstimatedReach({ estimatedSize: { low: 30, high: 80 }, confidence: 'unknown' }))
      .toMatchObject({ low: 30, high: 80, confidence: null })
  })

  it('orders a reversed range and falls back to unit/method inside the jsonb', () => {
    expect(deriveEstimatedReach({ estimatedSize: { low: 200, high: 100, unit: 'locations', method: 'counted' } }))
      .toEqual({ low: 100, high: 200, unit: 'locations', confidence: null, method: 'counted' })
    // the column wins over the jsonb when both are present
    expect(deriveEstimatedReach({ estimatedSize: { low: 1, high: 2, unit: 'x' }, entityUnit: ' people ' }).unit).toBe('people')
  })
})

describe('buildPlayCounts', () => {
  it('counts totals plus executable and strategy_only buckets', () => {
    expect(
      buildPlayCounts(['executable', 'strategy_only', 'executable', 'unsupported', 'strategy_only']),
    ).toEqual({ plays: 5, executable: 2, strategy_only: 2 })
  })

  it('returns zeros for an empty workspace', () => {
    expect(buildPlayCounts([])).toEqual({ plays: 0, executable: 0, strategy_only: 0 })
  })
})
