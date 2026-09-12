/*
 * Pure response-shaping helpers for the /internal/gtm/overview and
 * /internal/gtm/plays routes. Kept free of ORM and framework imports so they
 * are directly unit-testable (same pattern as lib/import-play.ts).
 *
 * Wire shapes use the SPEC-066 snake_case field names; entity rows use the
 * camelCase MikroORM property names, matched structurally so both real
 * GtmPlay instances and plain objects satisfy the input type.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Opaque-404 guard: a playId that is not a UUID can never match a row, so the
// route answers exactly as it does for a missing/foreign/soft-deleted row.
export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim())
}

export type GtmPlayRowLike = {
  id: string
  workspaceId: string
  source: string
  name?: string | null
  marketType?: string | null
  audience?: string | null
  signal?: string | null
  sourceHint?: string | null
  geography?: string | null
  recencyWindow?: string | null
  whyNow?: string | null
  recommendedAngle?: string | null
  supportedChannels?: unknown[] | null
  estimatedSize?: Record<string, unknown> | null
  entityUnit?: string | null
  estimateMethod?: string | null
  estimateBasis?: string | null
  providerQuery?: Record<string, unknown> | null
  confidence?: string | null
  confidenceRationale?: string | null
  likelyBuyer?: string | null
  executionEligibility: string
  eligibilityReason?: string | null
  eligibilityEvaluatedAt?: Date | null
  leadMode?: string | null
  researchEligibility?: string | null
  researchEligibilityReason?: string | null
  outreachMode?: string | null
  outreachPolicyReason?: string | null
  policyFlags?: string[] | null
  policyEvaluatedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

// Hub-facing reach grade. Imported reports grade confidence low | medium |
// high (audience-plays engine, Confidence); the hub renders it as a word a
// customer reads without a legend: "fair" not "medium".
export type GtmReachConfidence = 'rough' | 'fair' | 'solid'

// Deterministic projection of the stored estimate columns so the hub can
// render "EST. 120 to 180 businesses, fair" from the plays list without
// parsing estimated_size itself. Numbers come ONLY from the stored jsonb
// (low/high, or a single point estimate carried on both bounds); nothing is
// inferred from the label text, and unknown means null, never a guess.
export type GtmEstimatedReach = {
  low: number | null
  high: number | null
  // Free text as the report authored it: 'businesses' | 'people' | 'companies'
  // | 'opportunities' | ... Null when the row has no unit rather than a default.
  unit: string | null
  confidence: GtmReachConfidence | null
  method: string | null
}

export type GtmPlaySummary = {
  id: string
  source: string
  // Short label for dropdowns and cards; `audience` is the subtitle. Null for
  // rows the backfill has not reached yet, so the hub falls back to audience.
  name: string | null
  market_type: string | null
  audience: string | null
  signal: string | null
  source_hint: string | null
  geography: string | null
  confidence: string | null
  // Buyer persona and the timing argument travel with the list so a card can
  // show "who buys" and "why now" without a detail round-trip.
  likely_buyer: string | null
  why_now: string | null
  estimated_reach: GtmEstimatedReach
  execution_eligibility: string
  eligibility_reason: string | null
  lead_mode: string | null
  research_eligibility: string | null
  research_eligibility_reason: string | null
  outreach_mode: string | null
  outreach_policy_reason: string | null
  policy_flags: string[]
  // Per-play "team size: confirm later". Surfaced as a single boolean rather
  // than the whole provider_query, which stays server-side: the hub only ever
  // needs to render and flip this one switch.
  size_confirm_later: boolean
  created_at: string
}

export type GtmPlayDetail = GtmPlaySummary & {
  workspace_id: string
  recency_window: string | null
  recommended_angle: string | null
  supported_channels: unknown[] | null
  estimated_size: Record<string, unknown> | null
  entity_unit: string | null
  estimate_method: string | null
  // measured | sampled | modeled | unknown (import validator enum), or null.
  estimate_basis: string | null
  confidence_rationale: string | null
  eligibility_evaluated_at: string | null
  policy_evaluated_at: string | null
  updated_at: string
}

export type GtmPlayCounts = {
  plays: number
  executable: number
  strategy_only: number
}

// Mirrors sizeConfirmLaterEnabled() in lib/research/qualify.ts: only an
// explicit true (or the string "true") counts, so a missing key is off.
function sizeConfirmLater(providerQuery: Record<string, unknown> | null | undefined): boolean {
  if (!providerQuery || typeof providerQuery !== 'object' || Array.isArray(providerQuery)) return false
  const value = providerQuery.size_confirm_later
  return value === true || value === 'true'
}

function nonEmptyText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

// A stored bound is only usable as a finite, non-negative number. Numeric
// strings ("120") are accepted because jsonb written by hand sometimes carries
// them; anything else (label text, NaN, negatives, booleans) is null.
function reachNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const REACH_CONFIDENCE: Record<string, GtmReachConfidence> = {
  // audience-plays engine grades
  low: 'rough',
  medium: 'fair',
  high: 'solid',
  // already-graded values pass through unchanged
  rough: 'rough',
  fair: 'fair',
  solid: 'solid',
}

// low | medium | high -> rough | fair | solid. 'unknown', null, numbers and any
// other wording map to null: the hub then omits the grade instead of
// showing a made-up one.
export function reachConfidence(value: unknown): GtmReachConfidence | null {
  const text = nonEmptyText(value)
  if (!text) return null
  return REACH_CONFIDENCE[text.toLowerCase()] ?? null
}

// Point-estimate keys a stored estimated_size may carry instead of low/high.
// Checked only when neither bound is present, first match wins.
const POINT_ESTIMATE_KEYS = ['value', 'count', 'estimate', 'size', 'total'] as const

export function deriveEstimatedReach(play: Pick<GtmPlayRowLike, 'estimatedSize' | 'entityUnit' | 'estimateMethod' | 'confidence'>): GtmEstimatedReach {
  const size = play.estimatedSize && typeof play.estimatedSize === 'object' && !Array.isArray(play.estimatedSize)
    ? play.estimatedSize
    : null

  let low = size ? reachNumber(size.low) : null
  let high = size ? reachNumber(size.high) : null
  if (size && low === null && high === null) {
    for (const key of POINT_ESTIMATE_KEYS) {
      const point = reachNumber(size[key])
      if (point !== null) {
        low = point
        high = point
        break
      }
    }
  }
  // Both bounds present but reversed: order them. Neither number is changed.
  if (low !== null && high !== null && low > high) [low, high] = [high, low]

  return {
    low,
    high,
    unit: nonEmptyText(play.entityUnit) ?? (size ? nonEmptyText(size.unit) ?? nonEmptyText(size.entity_unit) : null),
    confidence: reachConfidence(play.confidence),
    method: nonEmptyText(play.estimateMethod) ?? (size ? nonEmptyText(size.method) : null),
  }
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

export function shapePlaySummary(play: GtmPlayRowLike): GtmPlaySummary {
  return {
    id: play.id,
    source: play.source,
    name: play.name ?? null,
    market_type: play.marketType ?? null,
    audience: play.audience ?? null,
    signal: play.signal ?? null,
    source_hint: play.sourceHint ?? null,
    geography: play.geography ?? null,
    confidence: play.confidence ?? null,
    likely_buyer: play.likelyBuyer ?? null,
    why_now: play.whyNow ?? null,
    estimated_reach: deriveEstimatedReach(play),
    execution_eligibility: play.executionEligibility,
    eligibility_reason: play.eligibilityReason ?? null,
    lead_mode: play.leadMode ?? null,
    research_eligibility: play.researchEligibility ?? null,
    research_eligibility_reason: play.researchEligibilityReason ?? null,
    outreach_mode: play.outreachMode ?? null,
    outreach_policy_reason: play.outreachPolicyReason ?? null,
    policy_flags: play.policyFlags ?? [],
    size_confirm_later: sizeConfirmLater(play.providerQuery),
    created_at: play.createdAt.toISOString(),
  }
}

export function shapePlayDetail(play: GtmPlayRowLike): GtmPlayDetail {
  return {
    ...shapePlaySummary(play),
    workspace_id: play.workspaceId,
    recency_window: play.recencyWindow ?? null,
    recommended_angle: play.recommendedAngle ?? null,
    supported_channels: play.supportedChannels ?? null,
    estimated_size: play.estimatedSize ?? null,
    entity_unit: play.entityUnit ?? null,
    estimate_method: play.estimateMethod ?? null,
    estimate_basis: play.estimateBasis ?? null,
    confidence_rationale: play.confidenceRationale ?? null,
    eligibility_evaluated_at: iso(play.eligibilityEvaluatedAt),
    policy_evaluated_at: iso(play.policyEvaluatedAt),
    updated_at: play.updatedAt.toISOString(),
  }
}

// Counts are computed from eligibility values fetched without a row cap, so
// they stay correct when the plays list itself is capped at 50.
export function buildPlayCounts(eligibilities: string[]): GtmPlayCounts {
  let executable = 0
  let strategyOnly = 0
  for (const value of eligibilities) {
    if (value === 'executable') executable += 1
    else if (value === 'strategy_only') strategyOnly += 1
  }
  return { plays: eligibilities.length, executable, strategy_only: strategyOnly }
}
