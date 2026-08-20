import {
  isUuid,
  shapePlaySummary,
  shapePlayDetail,
  buildPlayCounts,
  type GtmPlayRowLike,
} from '../play-shape'

const fullRow: GtmPlayRowLike = {
  id: '11111111-2222-4333-8444-555555555555',
  workspaceId: '99999999-8888-4777-8666-555555555555',
  source: 'imported',
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
  confidence: 'medium',
  confidenceRationale: 'Funding feeds are dense but noisy',
  likelyBuyer: 'Founder or head of ops',
  executionEligibility: 'executable',
  eligibilityReason: 'US B2B audience with a findable source. Eligible for automated execution.',
  eligibilityEvaluatedAt: new Date('2026-07-23T10:00:00.000Z'),
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
      market_type: 'b2b',
      audience: fullRow.audience,
      signal: fullRow.signal,
      source_hint: fullRow.sourceHint,
      geography: 'United States',
      confidence: 'medium',
      execution_eligibility: 'executable',
      eligibility_reason: fullRow.eligibilityReason,
      created_at: '2026-07-23T09:00:00.000Z',
    })
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
    expect(summary.market_type).toBeNull()
    expect(summary.audience).toBeNull()
    expect(summary.signal).toBeNull()
    expect(summary.source_hint).toBeNull()
    expect(summary.geography).toBeNull()
    expect(summary.confidence).toBeNull()
    expect(summary.eligibility_reason).toBeNull()
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
      confidence_rationale: fullRow.confidenceRationale,
      likely_buyer: 'Founder or head of ops',
      eligibility_evaluated_at: '2026-07-23T10:00:00.000Z',
      updated_at: '2026-07-23T09:30:00.000Z',
    })
    // and everything from the summary shape
    expect(detail.execution_eligibility).toBe('executable')
    expect(detail.created_at).toBe('2026-07-23T09:00:00.000Z')
  })

  it('nulls eligibility_evaluated_at when never evaluated', () => {
    const detail = shapePlayDetail({ ...fullRow, eligibilityEvaluatedAt: null })
    expect(detail.eligibility_evaluated_at).toBeNull()
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
