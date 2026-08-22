import { z } from 'zod'

const positiveVersion = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(
  (value) => BigInt(value) <= BigInt('9223372036854775807'),
)
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

const consentVersionSchema = z.object({
  version: positiveVersion,
  state: z.enum(['granted', 'denied', 'withdrawn']),
  effectiveAt: instant,
  expiresAt: instant.nullable(),
}).strict()

const suppressionVersionSchema = z.object({
  version: positiveVersion,
  active: z.boolean(),
  effectiveAt: instant,
}).strict()

const eligibilityInputSchema = z.object({
  dependencyAvailable: z.boolean(),
  nowMs: z.number().int().nonnegative().safe(),
  expectedConsentVersion: positiveVersion,
  expectedSuppressionVersion: positiveVersion,
  consent: consentVersionSchema.nullable(),
  suppression: suppressionVersionSchema.nullable(),
}).strict()

export type CrmAmsEligibilityDenialCodeV1 =
  | 'consent_absent'
  | 'consent_denied'
  | 'consent_withdrawn'
  | 'consent_expired'
  | 'suppressed'
  | 'stale_expected_version'
  | 'dependency_unavailable'

export type CrmAmsEligibilityResultV1 =
  | { eligible: true; denialCode: null; consentVersion: string; suppressionVersion: string }
  | {
      eligible: false
      denialCode: CrmAmsEligibilityDenialCodeV1
      consentVersion: string | null
      suppressionVersion: string | null
    }

function deny(
  denialCode: CrmAmsEligibilityDenialCodeV1,
  consentVersion: string | null = null,
  suppressionVersion: string | null = null,
): CrmAmsEligibilityResultV1 {
  return { eligible: false, denialCode, consentVersion, suppressionVersion }
}

export function evaluateCrmAmsEligibilityV1(value: unknown): CrmAmsEligibilityResultV1 {
  const parsed = eligibilityInputSchema.safeParse(value)
  if (!parsed.success || !parsed.data.dependencyAvailable) return deny('dependency_unavailable')

  const { consent, suppression, nowMs, expectedConsentVersion, expectedSuppressionVersion } = parsed.data
  if (!consent || Date.parse(consent.effectiveAt) > nowMs) {
    return deny('consent_absent', consent?.version ?? null, suppression?.version ?? null)
  }
  if (!suppression || Date.parse(suppression.effectiveAt) > nowMs) {
    return deny('stale_expected_version', consent.version, suppression?.version ?? null)
  }
  if (consent.version !== expectedConsentVersion || suppression.version !== expectedSuppressionVersion) {
    return deny('stale_expected_version', consent.version, suppression.version)
  }
  if (consent.state === 'denied') return deny('consent_denied', consent.version, suppression.version)
  if (consent.state === 'withdrawn') return deny('consent_withdrawn', consent.version, suppression.version)
  if (consent.expiresAt !== null && Date.parse(consent.expiresAt) <= nowMs) {
    return deny('consent_expired', consent.version, suppression.version)
  }
  if (suppression.active) return deny('suppressed', consent.version, suppression.version)

  return {
    eligible: true,
    denialCode: null,
    consentVersion: consent.version,
    suppressionVersion: suppression.version,
  }
}
