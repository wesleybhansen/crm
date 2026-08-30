export const OPPORTUNITY_DESTINATION_VALIDATION_VERSION = 'safe-public-destination-v1' as const
export const OPPORTUNITY_DESTINATION_VALIDATION_MAX_ATTEMPTS = 20
export const OPPORTUNITY_DESTINATION_VALIDATION_MAX_REDIRECTS = 3
export const OPPORTUNITY_DESTINATION_VALIDATION_TIMEOUT_MS = 8_000
export const OPPORTUNITY_DESTINATION_VALIDATION_MAX_BODY_BYTES = 300_000

export type OpportunityDestinationValidationPlan = {
  version: typeof OPPORTUNITY_DESTINATION_VALIDATION_VERSION
  enabled: boolean
  maxAttempts: number
  maxRedirects: typeof OPPORTUNITY_DESTINATION_VALIDATION_MAX_REDIRECTS
  timeoutMs: typeof OPPORTUNITY_DESTINATION_VALIDATION_TIMEOUT_MS
  maxBodyBytes: typeof OPPORTUNITY_DESTINATION_VALIDATION_MAX_BODY_BYTES
  socialNetworkPolicy: 'provider_evidence_only'
}

export function buildOpportunityDestinationValidationPlan(
  entityKind: 'person' | 'company' | 'opportunity',
  maxRawCandidates: number,
): OpportunityDestinationValidationPlan {
  const enabled = entityKind === 'opportunity'
  return {
    version: OPPORTUNITY_DESTINATION_VALIDATION_VERSION,
    enabled,
    maxAttempts: enabled
      ? Math.min(maxRawCandidates, OPPORTUNITY_DESTINATION_VALIDATION_MAX_ATTEMPTS)
      : 0,
    maxRedirects: OPPORTUNITY_DESTINATION_VALIDATION_MAX_REDIRECTS,
    timeoutMs: OPPORTUNITY_DESTINATION_VALIDATION_TIMEOUT_MS,
    maxBodyBytes: OPPORTUNITY_DESTINATION_VALIDATION_MAX_BODY_BYTES,
    socialNetworkPolicy: 'provider_evidence_only',
  }
}
