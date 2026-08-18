/*
 * Credit pricing of provider units (GTM-SPEC-01 section 4.6): a platform
 * markup multiplier applies over the adapter's quoted per-unit credit cost.
 * The recommended initial multiplier is 2x; it is read from the environment
 * (GTM_CREDIT_MARKUP) with '2' as the fallback so the default needs no env.
 */

export const DEFAULT_CREDIT_MARKUP = 2

/*
 * NOLI CREDIT UNIT. Authoritative source: CREDITS_PER_CENT = 2500 in
 * `apps/mercato/src/lib/usage/allowance.ts` and `packages/shared` (and the
 * noli-core ledger SQL, which settles cost_cents = ceil(charged_credits/2500)).
 * So 2500 credits = 1 cent, 1 credit = $0.000004, and $1 = 250,000 credits.
 *
 * WARNING: This constant MUST stay in parity with packages/entitlements-client /
 * packages/shared. If CREDITS_PER_CENT ever changes there, change it here in
 * the same commit or every provider quote in this module silently mis-prices.
 *
 * WARNING: A provider's own "credits" are NOT Noli credits. Origami's rate card
 * ("0.2 credits per social engagement result") is denominated in ORIGAMI
 * credits; copying that number into a Noli quote undercharges by ~3,750x.
 * Always express provider cost in USD and convert with creditsFromUsd.
 */
export const CREDITS_PER_CENT = 2500
export const CREDITS_PER_USD = CREDITS_PER_CENT * 100 // 250_000

/*
 * Provider cost in USD -> Noli credits, PRE-markup. Markup is applied in
 * exactly one place (creditsForUnits below); never multiply it in here.
 */
export function creditsFromUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new TypeError(`usd must be a non-negative finite number, got ${usd}`)
  }
  // rounded to 6 decimals so float noise cannot leak into a quoted price
  return Math.round(usd * CREDITS_PER_USD * 1e6) / 1e6
}

/*
 * Noli credits -> USD. The exact inverse of creditsFromUsd, on the SAME
 * CREDITS_PER_USD basis, so the two can never drift apart by construction.
 *
 * WARNING (parity): the same warning that guards creditsFromUsd guards this
 * function. If CREDITS_PER_CENT changes in packages/entitlements-client /
 * packages/shared, it must change here in the same commit, or both directions
 * mis-price together and silently.
 *
 * WARNING (markup): credits RESERVED by the section 11.2 wrapper already
 * include the platform markup; a provider invoices us the RAW cost. Never hand
 * a reserved credit figure to this function directly, or the number you get
 * back is markup-inflated and a provider spend cap derived from it would
 * authorize more than we reserved. Divide by the markup multiplier first, or
 * use providerSpendCapUsd below, which does exactly that.
 */
export function usdFromCredits(credits: number): number {
  if (!Number.isFinite(credits) || credits < 0) {
    throw new TypeError(`credits must be a non-negative finite number, got ${credits}`)
  }
  // rounded to 10 decimals so float noise cannot leak into a spend cap
  return Math.round((credits / CREDITS_PER_USD) * 1e10) / 1e10
}

/*
 * The smallest per-run spend cap a provider will accept. Apify rejects a run
 * whose maxTotalChargeUsd is under $0.01 with HTTP 400
 * max-total-charge-usd-below-minimum (LIVE-VERIFIED 2026-07-24), so a cap
 * below this floor does not buy safety, it just fails the run.
 *
 * Kept here, not imported from the Apify client, so this module stays pure.
 * A test asserts it equals APIFY_MIN_CHARGE_USD so the two cannot drift.
 */
export const PROVIDER_MIN_CHARGE_USD = 0.01

/*
 * Turn a LEDGER RESERVATION into the hard per-run provider spend cap, so the
 * provider itself refuses to bill past what we reserved (defence in depth: our
 * ledger escrows the credits, the provider enforces the dollars).
 *
 *   maxChargeUsd = usdFromCredits(reservedCredits / markupMultiplier)
 *
 * The division is the whole point: reserved credits carry OUR markup, the
 * provider bills the raw cost. At the default 2x, reserving 37,500 credits for
 * 25 sourcing results yields a $0.075 cap, which is exactly the measured raw
 * provider cost (25 x $0.003), not $0.15.
 *
 * Floored at PROVIDER_MIN_CHARGE_USD: a tiny reservation would otherwise
 * produce a sub-minimum cap and turn every run into a hard 400.
 */
export function providerSpendCapUsd(
  reservedCredits: number,
  markupMultiplier: number = defaultMarkupMultiplier(),
): number {
  if (!Number.isFinite(markupMultiplier) || markupMultiplier <= 0) {
    throw new TypeError(`markupMultiplier must be a positive finite number, got ${markupMultiplier}`)
  }
  if (!Number.isFinite(reservedCredits) || reservedCredits < 0) {
    throw new TypeError(`reservedCredits must be a non-negative finite number, got ${reservedCredits}`)
  }
  return Math.max(PROVIDER_MIN_CHARGE_USD, usdFromCredits(reservedCredits / markupMultiplier))
}

export function defaultMarkupMultiplier(): number {
  const raw = process.env.GTM_CREDIT_MARKUP ?? String(DEFAULT_CREDIT_MARKUP)
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CREDIT_MARKUP
}

/*
 * Integer credits for a unit count: ceil of units x quoted x markup, and never
 * zero for a nonzero unit count (a paid unit always costs at least 1 credit).
 * Zero units always price at exactly 0.
 */
export function creditsForUnits(
  units: number,
  quotedCreditsPerUnit: number,
  markupMultiplier: number = defaultMarkupMultiplier(),
): number {
  if (!Number.isFinite(units) || units < 0) {
    throw new TypeError(`units must be a non-negative finite number, got ${units}`)
  }
  if (!Number.isFinite(quotedCreditsPerUnit) || quotedCreditsPerUnit < 0) {
    throw new TypeError(
      `quotedCreditsPerUnit must be a non-negative finite number, got ${quotedCreditsPerUnit}`,
    )
  }
  if (!Number.isFinite(markupMultiplier) || markupMultiplier <= 0) {
    throw new TypeError(`markupMultiplier must be a positive finite number, got ${markupMultiplier}`)
  }
  if (units === 0) return 0
  return Math.max(1, Math.ceil(units * quotedCreditsPerUnit * markupMultiplier))
}
