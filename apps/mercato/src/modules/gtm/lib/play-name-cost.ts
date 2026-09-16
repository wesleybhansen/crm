import { buildPlayNamePrompt, type PlayNameInput } from './play-name'
import { estimateModelTokens } from './ai/model'

/*
 * What naming a batch of plays is expected to cost, computed BEFORE anything
 * is spent so the operator running the backfill sees the bill first.
 *
 * Pure module (no ORM, no network, no environment reads beyond the two
 * optional price overrides) so the CLI's dry run is directly unit-testable.
 *
 * Everything here is an ESTIMATE and is labelled as one wherever it is
 * printed. Two separate honesty rules apply:
 *
 *   - Tokens are the unit Noli shows customers everywhere else (the research
 *     quote line, the usage tables), and they are genuinely derived: the
 *     prompt is built for real and measured with the same estimator the
 *     metering path uses. Output is a fixed small allowance because a play
 *     name is 3 to 6 words.
 *   - Dollars are NOT derived from a live rate card. The default per-play
 *     figure comes from the GTM redesign plan's own sizing (2026-09-11:
 *     "one Gemini call per play, about $0.20 total" for 134 plays), which is
 *     the only costing this project has agreed. Ops can replace it with the
 *     real rate through GTM_PLAY_NAME_USD_PER_PLAY rather than have this file
 *     carry a vendor price it cannot verify.
 */

// A name is 3 to 6 words plus the JSON envelope: a dozen tokens, generously.
export const PLAY_NAME_ESTIMATED_OUTPUT_TOKENS = 12

// Source: gtm-redesign-plan-2026-09-11.md, "about $0.20 total" for 134 plays.
export const PLAY_NAME_ESTIMATED_USD_PER_PLAY = 0.2 / 134

export type PlayNameCostEstimate = {
  plays: number
  tokensIn: number
  tokensOut: number
  tokensTotal: number
  usd: number
  usdPerPlay: number
  /** Where the dollar figure came from, so the printout can say so. */
  usdBasis: 'redesign_plan_estimate' | 'operator_override'
}

/** The per-play dollar figure in force: the operator's override when it parses
 *  as a non-negative finite number, else the redesign plan's figure. */
export function playNameUsdPerPlay(env: NodeJS.ProcessEnv = process.env): {
  usdPerPlay: number
  basis: PlayNameCostEstimate['usdBasis']
} {
  const raw = env.GTM_PLAY_NAME_USD_PER_PLAY?.trim()
  if (raw) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return { usdPerPlay: parsed, basis: 'operator_override' }
    }
  }
  return { usdPerPlay: PLAY_NAME_ESTIMATED_USD_PER_PLAY, basis: 'redesign_plan_estimate' }
}

/*
 * One metered model call per play. The prompt is built exactly as
 * generatePlayName would build it, so the token figure moves with the prompt
 * instead of drifting away from it.
 */
export function estimatePlayNameCost(
  plays: PlayNameInput[],
  env: NodeJS.ProcessEnv = process.env,
): PlayNameCostEstimate {
  const { usdPerPlay, basis } = playNameUsdPerPlay(env)
  let tokensIn = 0
  for (const play of plays) {
    const { system, prompt } = buildPlayNamePrompt(play)
    tokensIn += estimateModelTokens(system) + estimateModelTokens(prompt)
  }
  const tokensOut = plays.length * PLAY_NAME_ESTIMATED_OUTPUT_TOKENS
  return {
    plays: plays.length,
    tokensIn,
    tokensOut,
    tokensTotal: tokensIn + tokensOut,
    usd: plays.length * usdPerPlay,
    usdPerPlay,
    usdBasis: basis,
  }
}

/** The one line the CLI prints. Always says "estimate", never a flat price. */
export function formatPlayNameCost(estimate: PlayNameCostEstimate): string {
  const dollars = estimate.usd < 0.01 && estimate.usd > 0
    ? `under $0.01`
    : `about $${estimate.usd.toFixed(2)}`
  const basis = estimate.usdBasis === 'operator_override'
    ? 'GTM_PLAY_NAME_USD_PER_PLAY'
    : 'the GTM redesign plan sizing'
  return [
    `${estimate.plays} ${estimate.plays === 1 ? 'play' : 'plays'} to name.`,
    `Estimated ${estimate.tokensTotal.toLocaleString()} tokens`,
    `(${estimate.tokensIn.toLocaleString()} in, ${estimate.tokensOut.toLocaleString()} out),`,
    `${dollars} at $${estimate.usdPerPlay.toFixed(5)} per play from ${basis}.`,
    'Both figures are estimates.',
  ].join(' ')
}
