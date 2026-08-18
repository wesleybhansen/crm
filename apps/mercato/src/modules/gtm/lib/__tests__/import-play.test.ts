import {
  parseImportAudiencePlayBody,
  normalizeReportTokenHash,
  computeImportedPlayKey,
  buildImportedPlayValues,
} from '../import-play'

const HEX_HASH = 'A'.repeat(64)

const validBody = {
  noliUserId: 'usr_123',
  report_token_hash: HEX_HASH,
  play: {
    market_type: 'b2b',
    audience: 'US B2B SaaS founders who just raised a seed round',
    signal: 'Recent seed announcement',
    source: 'Crunchbase-style funding feeds',
    geography: 'United States',
    recency_window: '90 days',
    why_now: 'New budget lands right after a raise',
    recommended_angle: 'Congratulate, then offer the ops teardown',
    supported_channels: ['email', 'linkedin'],
    estimated_size: { label: '500-1000', low: 500, high: 1000 },
    entity_unit: 'companies',
    estimate_method: 'source volume sampling',
    confidence: 'medium',
    confidence_rationale: 'Funding feeds are dense but noisy',
  },
  likely_buyer: 'Founder or head of ops',
}

describe('normalizeReportTokenHash', () => {
  it('lowercases hex hashes', () => {
    expect(normalizeReportTokenHash(HEX_HASH)).toBe('a'.repeat(64))
  })

  it('preserves non-hex token hashes verbatim', () => {
    expect(normalizeReportTokenHash('abc-DEF_123xyz-not-hex')).toBe('abc-DEF_123xyz-not-hex')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeReportTokenHash(`  ${HEX_HASH}  `)).toBe('a'.repeat(64))
  })
})

describe('parseImportAudiencePlayBody', () => {
  it('accepts a full valid body and normalizes the token hash', () => {
    const parsed = parseImportAudiencePlayBody(validBody)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.body.report_token_hash).toBe('a'.repeat(64))
      expect(parsed.body.play.market_type).toBe('b2b')
      expect(parsed.body.likely_buyer).toBe('Founder or head of ops')
    }
  })

  it('rejects a missing noliUserId', () => {
    const parsed = parseImportAudiencePlayBody({ ...validBody, noliUserId: '' })
    expect(parsed.ok).toBe(false)
  })

  it('rejects a short or whitespace-bearing token hash', () => {
    expect(parseImportAudiencePlayBody({ ...validBody, report_token_hash: 'short' }).ok).toBe(false)
    expect(
      parseImportAudiencePlayBody({ ...validBody, report_token_hash: 'has whitespace inside pad pad' }).ok,
    ).toBe(false)
  })

  it('rejects a missing play object', () => {
    const { play: _play, ...withoutPlay } = validBody
    expect(parseImportAudiencePlayBody(withoutPlay).ok).toBe(false)
  })

  it('accepts a minimal play with all optional fields absent', () => {
    const parsed = parseImportAudiencePlayBody({
      noliUserId: 'usr_123',
      report_token_hash: HEX_HASH,
      play: {},
    })
    expect(parsed.ok).toBe(true)
  })

  it('discards caller-supplied eligibility claims', () => {
    const parsed = parseImportAudiencePlayBody({
      ...validBody,
      play: { ...validBody.play, execution_eligibility: 'executable', eligibility_reason: 'trust me' },
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect('execution_eligibility' in parsed.body.play).toBe(false)
      expect('eligibility_reason' in parsed.body.play).toBe(false)
    }
  })
})

describe('buildImportedPlayValues', () => {
  it('maps typed fields and recomputes eligibility server-side', () => {
    const parsed = parseImportAudiencePlayBody(validBody)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const now = new Date('2026-07-23T12:00:00Z')
    const values = buildImportedPlayValues(
      parsed.body.play,
      parsed.body.likely_buyer,
      parsed.body.report_token_hash,
      () => now,
    )
    expect(values.source).toBe('imported')
    expect(values.importedReportTokenHash).toBe('a'.repeat(64))
    expect(values.importedPlayKey).toMatch(/^[0-9a-f]{32}$/)
    expect(values.marketType).toBe('b2b')
    expect(values.sourceHint).toBe('Crunchbase-style funding feeds')
    expect(values.supportedChannels).toEqual(['email', 'linkedin'])
    expect(values.likelyBuyer).toBe('Founder or head of ops')
    expect(values.executionEligibility).toBe('executable')
    expect(values.eligibilityEvaluatedAt).toBe(now)
  })

  it('gives retries the same key while keeping distinct report plays distinct', () => {
    const first = computeImportedPlayKey(validBody.play, validBody.likely_buyer)
    const retry = computeImportedPlayKey(
      { ...validBody.play, audience: `  ${validBody.play.audience.toUpperCase()}  ` },
      validBody.likely_buyer,
    )
    const second = computeImportedPlayKey(
      { ...validBody.play, audience: 'US healthcare operators adopting a new CRM' },
      validBody.likely_buyer,
    )

    expect(retry).toBe(first)
    expect(second).not.toBe(first)
  })

  it('prefers an explicit source_hint over the hub source alias', () => {
    const values = buildImportedPlayValues(
      { source_hint: 'explicit hint', source: 'alias' } as never,
      null,
      HEX_HASH,
    )
    expect(values.sourceHint).toBe('explicit hint')
  })

  it('computes strategy_only for non-B2B or non-US plays regardless of caller claims', () => {
    const b2c = buildImportedPlayValues(
      { market_type: 'b2c', geography: 'United States' } as never,
      null,
      HEX_HASH,
    )
    expect(b2c.executionEligibility).toBe('strategy_only')
    expect(b2c.eligibilityReason).toContain('Consumer audiences')

    const nonUs = buildImportedPlayValues(
      { market_type: 'b2b', geography: 'Berlin, Germany' } as never,
      null,
      HEX_HASH,
    )
    expect(nonUs.executionEligibility).toBe('strategy_only')
  })
})
