import { computeExecutionEligibility, isUsGeography } from '../eligibility'
import { computeGtmPolicy, consumerPolicyFlags } from '../policy'

describe('isUsGeography', () => {
  it('accepts explicit US country markers', () => {
    expect(isUsGeography('US')).toBe(true)
    expect(isUsGeography('USA')).toBe(true)
    expect(isUsGeography('U.S.A.')).toBe(true)
    expect(isUsGeography('United States')).toBe(true)
    expect(isUsGeography('united states of america')).toBe(true)
    // Canonical hub-rule quirk mirrored on purpose: the trailing word boundary
    // cannot match after the final dot, so bare 'U.S.' is not recognized.
    expect(isUsGeography('U.S.')).toBe(false)
  })

  it('accepts US state names and metro strings', () => {
    expect(isUsGeography('California')).toBe(true)
    expect(isUsGeography('San Francisco Bay Area, California')).toBe(true)
    expect(isUsGeography('Texas and Oklahoma')).toBe(true)
    expect(isUsGeography('District of Columbia')).toBe(true)
  })

  it('accepts uppercase two-letter state abbreviations only', () => {
    expect(isUsGeography('Austin, TX')).toBe(true)
    expect(isUsGeography('Sacramento, CA')).toBe(true)
    expect(isUsGeography('Berlin or Munich')).toBe(false)
    expect(isUsGeography('offices in Toronto')).toBe(false)
  })

  it('rejects empty, not_applicable, and non-US geographies', () => {
    expect(isUsGeography('')).toBe(false)
    expect(isUsGeography('   ')).toBe(false)
    expect(isUsGeography('not_applicable')).toBe(false)
    expect(isUsGeography('Toronto, Canada')).toBe(false)
    expect(isUsGeography('United Kingdom')).toBe(false)
    expect(isUsGeography('Sydney, Australia')).toBe(false)
  })
})

describe('computeExecutionEligibility', () => {
  it('marks US B2B plays executable', () => {
    const result = computeExecutionEligibility({ market_type: 'b2b', geography: 'Denver, Colorado' })
    expect(result.execution_eligibility).toBe('executable')
    expect(result.eligibility_reason).toContain('Eligible for automated execution')
  })

  it('fails closed to strategy_only for b2c with a consumer-specific reason', () => {
    const result = computeExecutionEligibility({ market_type: 'b2c', geography: 'United States' })
    expect(result.execution_eligibility).toBe('strategy_only')
    expect(result.eligibility_reason).toContain('Consumer audiences')
  })

  it('fails closed to strategy_only for mixed, missing, and unknown market types', () => {
    for (const marketType of ['mixed', undefined, null, 'housing_consumer', 'B2B']) {
      const result = computeExecutionEligibility({ market_type: marketType, geography: 'United States' })
      expect(result.execution_eligibility).toBe('strategy_only')
    }
  })

  it('fails closed to strategy_only for b2b without a US geography', () => {
    expect(
      computeExecutionEligibility({ market_type: 'b2b', geography: '' }).execution_eligibility,
    ).toBe('strategy_only')
    expect(
      computeExecutionEligibility({ market_type: 'b2b', geography: 'not_applicable' }).execution_eligibility,
    ).toBe('strategy_only')
    expect(
      computeExecutionEligibility({ market_type: 'b2b', geography: 'Ontario, Canada' }).execution_eligibility,
    ).toBe('strategy_only')
    expect(
      computeExecutionEligibility({ market_type: 'b2b', geography: null }).execution_eligibility,
    ).toBe('strategy_only')
  })

  it('always returns a non-empty reason', () => {
    const cases = [
      { market_type: 'b2b', geography: 'US' },
      { market_type: 'b2b', geography: 'France' },
      { market_type: 'b2c', geography: 'US' },
      { market_type: null, geography: null },
    ]
    for (const input of cases) {
      expect(computeExecutionEligibility(input).eligibility_reason.length).toBeGreaterThan(0)
    }
  })
})

describe('computeGtmPolicy', () => {
  it('preserves governed B2B automation while separating research policy', () => {
    expect(computeGtmPolicy({
      market_type: 'b2b',
      geography: 'Denver, Colorado',
      audience: 'Independent accounting firms',
    })).toEqual(expect.objectContaining({
      lead_mode: 'business',
      research_eligibility: 'provider_runnable',
      outreach_mode: 'automated_email',
      execution_eligibility: 'executable',
      policy_flags: [],
    }))
  })

  it('allows safe US consumer research but keeps outreach strictly manual', () => {
    expect(computeGtmPolicy({
      market_type: 'b2c',
      geography: 'Los Angeles, California',
      audience: 'People who publicly requested information at a neighborhood home-design workshop',
      signal: 'Public workshop information request',
    })).toEqual(expect.objectContaining({
      lead_mode: 'consumer',
      research_eligibility: 'provider_runnable',
      outreach_mode: 'manual_only',
      execution_eligibility: 'strategy_only',
      policy_flags: [],
    }))
  })

  it('keeps non-US and mixed audiences import-only and manual', () => {
    expect(computeGtmPolicy({ market_type: 'b2c', geography: 'Paris, France' })).toEqual(
      expect.objectContaining({ research_eligibility: 'import_only', outreach_mode: 'manual_only' }),
    )
    expect(computeGtmPolicy({ market_type: 'mixed', geography: 'United States' })).toEqual(
      expect.objectContaining({ research_eligibility: 'import_only', outreach_mode: 'manual_only' }),
    )
  })

  it('blocks unknown geography and market type', () => {
    expect(computeGtmPolicy({ market_type: 'b2c', geography: '' })).toEqual(
      expect.objectContaining({ research_eligibility: 'blocked', outreach_mode: 'blocked' }),
    )
    expect(computeGtmPolicy({ market_type: 'consumer', geography: 'US' })).toEqual(
      expect.objectContaining({ research_eligibility: 'blocked', outreach_mode: 'blocked' }),
    )
  })

  it('blocks sensitive consumer criteria found in free text or provider filters', () => {
    const cases = [
      { audience: 'Homeowners in foreclosure' },
      { signal: 'Recently diagnosed with cancer' },
      { recommended_angle: 'Help for expectant parents' },
      { provider_query: { source_search_keywords: ['high school students'] } },
      { why_now: 'Recently filed for bankruptcy' },
      { audience: '17 year olds interested in a summer program' },
      { audience: 'Black homeowners in coastal California' },
      { audience: 'Adults ages 25 to 40 who recently moved' },
      { provider_query: { source_search_keywords: ['undocumented residents'] } },
      { signal: 'Recently received an eviction notice' },
    ]
    for (const value of cases) {
      const result = computeGtmPolicy({ market_type: 'b2c', geography: 'US', ...value })
      expect(result.research_eligibility).toBe('blocked')
      expect(result.outreach_mode).toBe('blocked')
      expect(result.policy_flags.length).toBeGreaterThan(0)
    }
  })

  it('does not block a professional audience merely because its practice area is sensitive', () => {
    expect(computeGtmPolicy({
      market_type: 'b2b',
      geography: 'US',
      audience: 'Estate planning attorneys',
      signal: 'Public law firm practice area',
    })).toEqual(expect.objectContaining({
      research_eligibility: 'provider_runnable',
      outreach_mode: 'automated_email',
    }))
  })

  it('returns finite safe policy codes instead of source text', () => {
    expect(consumerPolicyFlags({
      audience: 'Recently divorced parents with tax liens',
    })).toEqual(expect.arrayContaining([
      'sensitive_legal_or_financial_event',
    ]))
  })
})
