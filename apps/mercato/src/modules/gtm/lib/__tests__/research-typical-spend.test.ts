import {
  DEFAULT_TYPICAL_RATIO,
  previewHistoryFromRows,
  spendHistoryFromRows,
  typicalCredits,
  typicalEstimate,
  typicalFields,
  typicalPreviewCredits,
} from '../research/typical-spend'
import { usdFromCredits } from '../credits/markup'

describe('typical run cost from history', () => {
  const history = spendHistoryFromRows([
    { adapter: 'reddit', runs: 316, charged: 1239010, quoted: 5145470 },
    { adapter: 'organic', runs: 338, charged: 2054750, quoted: 2138000 },
    { adapter: 'rare', runs: 2, charged: 30000, quoted: 60000 },
  ])
  test('each source is scaled by its own history, never above the cap', () => {
    const typical = typicalCredits([{ adapter_id: 'reddit', estimatedCredits: 100_000 }, { adapter_id: 'organic', estimatedCredits: 50_000 }], history)
    expect(typical).toBe(Math.round(100_000 * (1239010 / 5145470) + 50_000 * (2054750 / 2138000)))
    expect(typical!).toBeLessThanOrEqual(150_000)
  })
  test('a source with too few runs uses the platform-wide ratio', () => {
    const overall = (1239010 + 2054750 + 30000) / (5145470 + 2138000 + 60000)
    expect(typicalCredits([{ adapter_id: 'rare', estimatedCredits: 10_000 }], history)).toBe(Math.round(10_000 * overall))
  })
  test('no history anywhere falls back to the audited default share, never above the cap', () => {
    const est = typicalEstimate([{ adapter_id: 'x', estimatedCredits: 10_000 }], spendHistoryFromRows([]))
    expect(est).toEqual({ credits: Math.round(10_000 * DEFAULT_TYPICAL_RATIO), usd: usdFromCredits(Math.round(10_000 * DEFAULT_TYPICAL_RATIO)), basis: 'default' })
  })
  test('an empty plan has no estimate', () => {
    expect(typicalCredits([], history)).toBeNull()
    expect(typicalFields([], history)).toEqual({ typical_credits: null, typical_usd: null, typical_basis: null })
  })
  test('basis reports the weakest source used', () => {
    expect(typicalEstimate([{ adapter_id: 'reddit', estimatedCredits: 1 }], history)?.basis).toBe('source_history')
    expect(typicalEstimate([{ adapter_id: 'reddit', estimatedCredits: 1 }, { adapter_id: 'rare', estimatedCredits: 1 }], history)?.basis).toBe('platform_history')
  })
  test('typical plan before/after: a $99 cap on a Reddit-led plan quotes about $24-$36 typical', () => {
    // $99 cap = 24,750,000 credits. Reddit lanes historically charge ~24% of
    // their quote; the platform-wide share is ~45%; the default is 37%.
    const cap = 99 * 250_000
    const redditOnly = typicalFields([{ adapter_id: 'reddit', estimatedCredits: cap }], history)
    expect(redditOnly.typical_usd).toBeCloseTo(99 * (1239010 / 5145470), 2)
    const noHistory = typicalFields([{ adapter_id: 'new-source', estimatedCredits: cap }], spendHistoryFromRows([]))
    expect(noHistory.typical_usd).toBeCloseTo(99 * DEFAULT_TYPICAL_RATIO, 2)
  })
})

describe('typical preview cost from history', () => {
  const previews = previewHistoryFromRows([
    { adapter: 'reddit', runs: 12, avg_charged: 40_000 },
    { adapter: 'thin', runs: 2, avg_charged: 10 },
  ])
  test('uses what previews of the source were actually charged, capped by the quote', () => {
    expect(typicalPreviewCredits('reddit', 100_000, previews)).toBe(40_000)
    expect(typicalPreviewCredits('reddit', 30_000, previews)).toBe(30_000)
  })
  test('too few previews means no typical figure (the quote stands)', () => {
    expect(typicalPreviewCredits('thin', 100_000, previews)).toBeNull()
    expect(typicalPreviewCredits('none', 100_000, previews)).toBeNull()
  })
})
