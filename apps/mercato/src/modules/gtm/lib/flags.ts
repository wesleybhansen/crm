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
