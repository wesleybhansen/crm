import { spendHistoryFromRows, typicalCredits } from '../research/typical-spend'

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
  test('no history means no estimate, only the cap', () => {
    expect(typicalCredits([{ adapter_id: 'x', estimatedCredits: 10_000 }], spendHistoryFromRows([]))).toBeNull()
  })
})
