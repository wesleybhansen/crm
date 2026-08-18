import crypto from 'crypto'
import {
  importAudiencePlayBodySchema,
  type ImportAudiencePlayBody,
  type ImportedPlayInput,
} from '../data/validators'
import { computeExecutionEligibility } from './eligibility'
import { classifySignalKind, isSignalKind, type SignalKind } from './signal-taxonomy'

/*
 * Pure helpers for the /internal/gtm/import-audience-play route. Kept free of
 * ORM and framework imports so they are directly unit-testable.
 */

export type ParsedImportBody =
  | { ok: true; body: ImportAudiencePlayBody }
  | { ok: false; error: string }

export function parseImportAudiencePlayBody(raw: unknown): ParsedImportBody {
  const parsed = importAudiencePlayBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    return { ok: false, error: `${where}${first?.message ?? 'Invalid body'}` }
  }
  return { ok: true, body: { ...parsed.data, report_token_hash: normalizeReportTokenHash(parsed.data.report_token_hash) } }
}

// Hex hashes compare case-insensitively everywhere else in the stack, so a
// hex-looking token hash is canonicalized to lowercase; anything else (e.g.
// base64url) is preserved verbatim.
export function normalizeReportTokenHash(raw: string): string {
  const trimmed = raw.trim()
  return /^[0-9a-fA-F]+$/.test(trimmed) ? trimmed.toLowerCase() : trimmed
}

export type ImportedPlayValues = {
  source: 'imported'
  importedReportTokenHash: string
  importedPlayKey: string
  marketType: string | null
  audience: string | null
  signal: string | null
  signalKind: SignalKind | null
  providerQuery: Record<string, unknown> | null
  sourceHint: string | null
  geography: string | null
  recencyWindow: string | null
  whyNow: string | null
  recommendedAngle: string | null
  supportedChannels: string[] | null
  estimatedSize: Record<string, unknown> | null
  entityUnit: string | null
  estimateMethod: string | null
  estimateBasis: string | null
  businessEvidence: unknown[] | null
  confidence: string | null
  confidenceRationale: string | null
  likelyBuyer: string | null
  executionEligibility: 'executable' | 'strategy_only' | 'unsupported'
  eligibilityReason: string
  eligibilityEvaluatedAt: Date
}

function normalizePlayIdentityPart(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : ''
}

// This is an idempotency identity, not a security boundary. MD5 is used so the
// application and PostgreSQL's built-in md5(text) can produce the same key for
// existing imported rows without requiring an optional database extension.
export function computeImportedPlayKey(play: ImportedPlayInput, likelyBuyer: string | null): string {
  const identity = [
    play.market_type,
    play.audience,
    play.signal,
    play.source_hint ?? play.source,
    play.geography,
    play.recency_window,
    play.recommended_angle,
    likelyBuyer,
  ]
    .map(normalizePlayIdentityPart)
    .join('\n')

  return crypto.createHash('md5').update(identity).digest('hex')
}

// Maps the typed hub payload onto GtmPlay column values with the eligibility
// ALWAYS recomputed server-side (SPEC-066 section 7) - the caller's own
// eligibility claim, if any, is discarded by the schema and never consulted.
export function buildImportedPlayValues(
  play: ImportedPlayInput,
  likelyBuyer: string | null,
  reportTokenHash: string,
  now: () => Date = () => new Date(),
): ImportedPlayValues {
  const sourceHint = play.source_hint ?? play.source ?? null
  const eligibility = computeExecutionEligibility({
    market_type: play.market_type ?? null,
    geography: play.geography ?? null,
  })
  return {
    source: 'imported',
    importedReportTokenHash: normalizeReportTokenHash(reportTokenHash),
    importedPlayKey: computeImportedPlayKey(play, likelyBuyer),
    marketType: play.market_type ?? null,
    audience: play.audience ?? null,
    signal: play.signal ?? null,
    signalKind: isSignalKind(play.signal_kind)
      ? play.signal_kind
      : classifySignalKind(play.signal),
    providerQuery: play.provider_query ?? null,
    sourceHint,
    geography: play.geography ?? null,
    recencyWindow: play.recency_window ?? null,
    whyNow: play.why_now ?? null,
    recommendedAngle: play.recommended_angle ?? null,
    supportedChannels: play.supported_channels ?? null,
    estimatedSize: play.estimated_size ?? null,
    entityUnit: play.entity_unit ?? null,
    estimateMethod: play.estimate_method ?? null,
    estimateBasis: play.estimate_basis ?? null,
    businessEvidence: play.business_evidence ?? null,
    confidence: play.confidence ?? null,
    confidenceRationale: play.confidence_rationale ?? null,
    likelyBuyer: likelyBuyer ?? null,
    executionEligibility: eligibility.execution_eligibility,
    eligibilityReason: eligibility.eligibility_reason,
    eligibilityEvaluatedAt: now(),
  }
}
