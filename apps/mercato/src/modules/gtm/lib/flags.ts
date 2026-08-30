// GTM Engineer feature gate (SPEC-066: optional-parallel, feature-flagged,
// OFF for the current launch candidate). Dispatcher-facing GTM routes must
// fail closed (404) when the flag is off.
export function gtmEnabled(): boolean {
  return process.env.GTM_ENGINEER_ENABLED === 'true'
}

export const GTM_CONSUMER_LEGAL_APPROVAL_VERSION = 'gtm-b2c-legal-2026-08-26-v1'
export const GTM_CONSUMER_QUALITY_APPROVAL_VERSION = 'realtor-opportunity-benchmark-v2'

export type GtmConsumerResearchReleaseState = {
  enabled: boolean
  featureEnabled: boolean
  legalApproved: boolean
  qualityApproved: boolean
  holdReasons: Array<
    | 'consumer_feature_disabled'
    | 'consumer_legal_approval_missing'
    | 'consumer_quality_approval_missing'
  >
}

type GtmConsumerOwnerProbeLimits = {
  targetAccepted?: unknown
  maxRawCandidates?: unknown
  maxCandidates?: unknown
  maxCredits?: unknown
}

export const GTM_CONSUMER_OWNER_PROBE_CEILINGS = {
  targetAccepted: 10,
  maxRawCandidates: 60,
  // Three TikTok lanes each require a $0.50 provider-side reservation even
  // though finalized event charges are normally much lower. At the canonical
  // two-times markup and 250,000 credits/USD this is exactly 750,000 credits.
  // This remains owner-ID-bound and cannot satisfy the customer quality gate.
  maxCredits: 750_000,
} as const

export function gtmConsumerResearchReleaseState(): GtmConsumerResearchReleaseState {
  const featureEnabled = process.env.GTM_CONSUMER_RESEARCH_ENABLED === 'true'
  const legalApproved =
    process.env.GTM_CONSUMER_LEGAL_APPROVAL_VERSION === GTM_CONSUMER_LEGAL_APPROVAL_VERSION
  const qualityApproved =
    process.env.GTM_CONSUMER_QUALITY_APPROVAL_VERSION === GTM_CONSUMER_QUALITY_APPROVAL_VERSION
  const holdReasons: GtmConsumerResearchReleaseState['holdReasons'] = []
  if (!featureEnabled) holdReasons.push('consumer_feature_disabled')
  if (!legalApproved) holdReasons.push('consumer_legal_approval_missing')
  if (!qualityApproved) holdReasons.push('consumer_quality_approval_missing')
  return {
    enabled: holdReasons.length === 0,
    featureEnabled,
    legalApproved,
    qualityApproved,
    holdReasons,
  }
}

// Consumer research has a separate dark-release gate. Enabling the GTM
// workspace must never implicitly authorize customer-serving consumer-source
// calls. This gate controls research only; consumer outreach stays manual-only
// in policy regardless of its value. The exact counsel disposition and the
// independently reviewed benchmark must also be recorded in deployment config;
// a generic feature flag can never stand in for either release decision.
export function gtmConsumerResearchEnabled(): boolean {
  return gtmConsumerResearchReleaseState().enabled
}

function boundedPositiveInteger(value: unknown, ceiling: number): boolean {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= ceiling
}

/**
 * Pre-release quality probes are restricted to one explicitly configured Noli
 * owner and a small immutable quote. This avoids the circular requirement to
 * pass the paid-source benchmark before it can be run, without weakening the
 * customer release gate or enabling consumer outreach.
 */
export function gtmConsumerOwnerProbeEnabled(
  noliUserId: string,
  limits: GtmConsumerOwnerProbeLimits | null | undefined,
): boolean {
  if (
    process.env.GTM_CONSUMER_RESEARCH_ENABLED !== 'true'
    || process.env.GTM_CONSUMER_OWNER_PROBE_ENABLED !== 'true'
    || !process.env.GTM_CONSUMER_OWNER_PROBE_NOLI_USER_ID
    || process.env.GTM_CONSUMER_OWNER_PROBE_NOLI_USER_ID !== noliUserId
    || !limits
  ) return false
  const rawCeiling = limits.maxRawCandidates ?? limits.maxCandidates
  return boundedPositiveInteger(limits.targetAccepted, GTM_CONSUMER_OWNER_PROBE_CEILINGS.targetAccepted)
    && boundedPositiveInteger(rawCeiling, GTM_CONSUMER_OWNER_PROBE_CEILINGS.maxRawCandidates)
    && boundedPositiveInteger(limits.maxCredits, GTM_CONSUMER_OWNER_PROBE_CEILINGS.maxCredits)
}
