import { evaluateCrmAmsEligibilityV1 } from '../ams-crm-eligibility-v1'

const nowMs = Date.parse('2026-08-22T20:00:00.000Z')
const base = {
  dependencyAvailable: true,
  nowMs,
  expectedConsentVersion: '3',
  expectedSuppressionVersion: '7',
  consent: {
    version: '3',
    state: 'granted' as const,
    effectiveAt: '2026-08-22T19:00:00.000Z',
    expiresAt: null,
  },
  suppression: {
    version: '7',
    active: false,
    effectiveAt: '2026-08-22T19:00:00.000Z',
  },
}

describe('AMS CRM just-in-time eligibility v1', () => {
  it('allows only an exact current grant and inactive suppression version', () => {
    expect(evaluateCrmAmsEligibilityV1(base)).toEqual({
      eligible: true,
      denialCode: null,
      consentVersion: '3',
      suppressionVersion: '7',
    })
  })

  it.each([
    ['withdrawal after enqueue', { ...base, consent: { ...base.consent, state: 'withdrawn' as const } }, 'consent_withdrawn'],
    ['suppression after enqueue', { ...base, suppression: { ...base.suppression, active: true } }, 'suppressed'],
    ['consent expiry', { ...base, consent: { ...base.consent, expiresAt: '2026-08-22T20:00:00.000Z' } }, 'consent_expired'],
    ['stale consent version', { ...base, consent: { ...base.consent, version: '4' } }, 'stale_expected_version'],
    ['stale suppression version', { ...base, suppression: { ...base.suppression, version: '8' } }, 'stale_expected_version'],
    ['dependency outage', { ...base, dependencyAvailable: false }, 'dependency_unavailable'],
  ])('denies %s', (_name, input, denialCode) => {
    expect(evaluateCrmAmsEligibilityV1(input)).toMatchObject({ eligible: false, denialCode })
  })

  it('fails closed for malformed persistence-shaped input', () => {
    expect(evaluateCrmAmsEligibilityV1({ ...base, dependencyAvailable: 'true' })).toEqual({
      eligible: false,
      denialCode: 'dependency_unavailable',
      consentVersion: null,
      suppressionVersion: null,
    })
  })
})
