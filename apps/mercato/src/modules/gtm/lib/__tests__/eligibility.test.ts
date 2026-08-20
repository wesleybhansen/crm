import { computeExecutionEligibility, isUsGeography } from '../eligibility'

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
