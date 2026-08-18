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
  confidence?: string | null
  confidenceRationale?: string | null
  likelyBuyer?: string | null
  executionEligibility: string
  eligibilityReason?: string | null
  eligibilityEvaluatedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

export type GtmPlaySummary = {
  id: string
  source: string
  market_type: string | null
  audience: string | null
  signal: string | null
  source_hint: string | null
  geography: string | null
  confidence: string | null
  execution_eligibility: string
  eligibility_reason: string | null
  created_at: string
}

export type GtmPlayDetail = GtmPlaySummary & {
  workspace_id: string
  recency_window: string | null
  why_now: string | null
  recommended_angle: string | null
  supported_channels: unknown[] | null
  estimated_size: Record<string, unknown> | null
  entity_unit: string | null
  estimate_method: string | null
  confidence_rationale: string | null
  likely_buyer: string | null
  eligibility_evaluated_at: string | null
  updated_at: string
}

export type GtmPlayCounts = {
  plays: number
  executable: number
  strategy_only: number
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

export function shapePlaySummary(play: GtmPlayRowLike): GtmPlaySummary {
  return {
    id: play.id,
    source: play.source,
    market_type: play.marketType ?? null,
    audience: play.audience ?? null,
    signal: play.signal ?? null,
    source_hint: play.sourceHint ?? null,
    geography: play.geography ?? null,
    confidence: play.confidence ?? null,
    execution_eligibility: play.executionEligibility,
    eligibility_reason: play.eligibilityReason ?? null,
    created_at: play.createdAt.toISOString(),
  }
}

export function shapePlayDetail(play: GtmPlayRowLike): GtmPlayDetail {
  return {
    ...shapePlaySummary(play),
    workspace_id: play.workspaceId,
    recency_window: play.recencyWindow ?? null,
    why_now: play.whyNow ?? null,
    recommended_angle: play.recommendedAngle ?? null,
    supported_channels: play.supportedChannels ?? null,
    estimated_size: play.estimatedSize ?? null,
    entity_unit: play.entityUnit ?? null,
    estimate_method: play.estimateMethod ?? null,
    confidence_rationale: play.confidenceRationale ?? null,
    likely_buyer: play.likelyBuyer ?? null,
    eligibility_evaluated_at: iso(play.eligibilityEvaluatedAt),
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
