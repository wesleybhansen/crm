import {
  estimatePlayNameCost,
  formatPlayNameCost,
  PLAY_NAME_ESTIMATED_OUTPUT_TOKENS,
  PLAY_NAME_ESTIMATED_USD_PER_PLAY,
  playNameUsdPerPlay,
} from '../play-name-cost'

/*
 * The backfill CLI prints this before it spends anything, so the numbers must
 * come from the real prompt and must always read as estimates.
 */

const PLAY = {
  audience: 'Independent dental practices in Austin with 1 to 50 staff',
  signal: 'opened a second location in the last six months',
  geography: 'US-TX',
  whyNow: 'A second location doubles the front-desk load before the systems catch up.',
}

describe('estimatePlayNameCost', () => {
  it('counts one call per play and scales with the real prompt', () => {
    const one = estimatePlayNameCost([PLAY], {})
    const two = estimatePlayNameCost([PLAY, PLAY], {})
    expect(one.plays).toBe(1)
    expect(one.tokensIn).toBeGreaterThan(0)
    expect(one.tokensOut).toBe(PLAY_NAME_ESTIMATED_OUTPUT_TOKENS)
    expect(one.tokensTotal).toBe(one.tokensIn + one.tokensOut)
    expect(two.tokensIn).toBe(one.tokensIn * 2)
    expect(two.tokensOut).toBe(one.tokensOut * 2)
  })

  it('a longer play costs more input tokens than a sparse one', () => {
    const sparse = estimatePlayNameCost([{ audience: 'Dentists' }], {})
    const rich = estimatePlayNameCost([PLAY], {})
    expect(rich.tokensIn).toBeGreaterThan(sparse.tokensIn)
  })

  it('an empty batch costs nothing', () => {
    expect(estimatePlayNameCost([], {})).toMatchObject({ plays: 0, tokensIn: 0, tokensOut: 0, usd: 0 })
  })

  it('prices from the redesign plan by default and from the operator override when set', () => {
    expect(playNameUsdPerPlay({})).toEqual({
      usdPerPlay: PLAY_NAME_ESTIMATED_USD_PER_PLAY,
      basis: 'redesign_plan_estimate',
    })
    // The plan's own sizing: about $0.20 for 134 plays.
    expect(estimatePlayNameCost(new Array(134).fill(PLAY), {}).usd).toBeCloseTo(0.2, 6)

    expect(playNameUsdPerPlay({ GTM_PLAY_NAME_USD_PER_PLAY: '0.01' })).toEqual({
      usdPerPlay: 0.01,
      basis: 'operator_override',
    })
    expect(estimatePlayNameCost([PLAY, PLAY], { GTM_PLAY_NAME_USD_PER_PLAY: '0.01' }).usd).toBeCloseTo(0.02, 6)
  })

  it('ignores an unusable override rather than pricing at NaN or a negative', () => {
    for (const raw of ['', '   ', 'free', '-1', 'NaN', 'Infinity']) {
      expect(playNameUsdPerPlay({ GTM_PLAY_NAME_USD_PER_PLAY: raw }).basis).toBe('redesign_plan_estimate')
    }
    expect(playNameUsdPerPlay({ GTM_PLAY_NAME_USD_PER_PLAY: '0' })).toEqual({
      usdPerPlay: 0,
      basis: 'operator_override',
    })
  })
})

describe('formatPlayNameCost', () => {
  it('always says the numbers are estimates and never states a flat price', () => {
    const line = formatPlayNameCost(estimatePlayNameCost([PLAY, PLAY, PLAY], {}))
    expect(line).toMatch(/3 plays to name\./)
    expect(line).toMatch(/Estimated [\d,]+ tokens/)
    expect(line).toMatch(/Both figures are estimates\./)
    expect(line).not.toMatch(/—/)
  })

  it('says "under $0.01" rather than rounding a real cost to $0.00', () => {
    const line = formatPlayNameCost(estimatePlayNameCost([PLAY], {}))
    expect(line).toContain('under $0.01')
    expect(line).not.toContain('about $0.00')
  })

  it('names the basis so the reader knows where the dollars came from', () => {
    expect(formatPlayNameCost(estimatePlayNameCost([PLAY], {}))).toContain('the GTM redesign plan sizing')
    expect(
      formatPlayNameCost(estimatePlayNameCost([PLAY], { GTM_PLAY_NAME_USD_PER_PLAY: '0.5' })),
    ).toContain('GTM_PLAY_NAME_USD_PER_PLAY')
  })
})
