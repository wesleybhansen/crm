import { creditsFromUsd } from '../../credits/markup'
import {
  capabilityCovers,
  type AdapterDescriptor,
  type AdapterResult,
  type VerificationOutcome,
  type VerificationState,
  type VerifyAdapter,
} from '../types'

export const BOUNCER_VERIFY_ADAPTER_ID = 'bouncer-email-verification'
export const BOUNCER_VERIFY_URL = 'https://api.usebouncer.com/v1.1/email/verify'
export const BOUNCER_DEFAULT_USD_PER_VERIFICATION = 0.008
const RECEIPT_FIELDS = ['provider_request_id', 'provider_status', 'reason', 'score']
type BouncerEnv = Record<string, string | undefined>
type BouncerFetch = typeof fetch

function envValue(env: BouncerEnv, name: string): string {
  return (env[name] ?? '').trim()
}

export function bouncerApproved(env: BouncerEnv = process.env): boolean {
  return (
    envValue(env, 'GTM_BOUNCER_CUSTOMER_USE_APPROVED') === 'true' &&
    Boolean(envValue(env, 'GTM_BOUNCER_TERMS_VERSION')) &&
    Boolean(envValue(env, 'GTM_BOUNCER_PRICE_VERSION'))
  )
}

export function bouncerEnabled(env: BouncerEnv = process.env): boolean {
  return (
    envValue(env, 'GTM_BOUNCER_ENABLED') === 'true' &&
    Boolean(envValue(env, 'GTM_BOUNCER_API_KEY')) &&
    bouncerApproved(env)
  )
}

export function bouncerDescriptor(env: BouncerEnv = process.env): AdapterDescriptor {
  const parsed = Number(envValue(env, 'GTM_BOUNCER_USD_PER_VERIFICATION'))
  const approved = bouncerApproved(env)
  return {
    contract_version: '2',
    adapter_id: BOUNCER_VERIFY_ADAPTER_ID,
    layer: 'verify',
    capabilities: [
      {
        signal_kind: 'email_verification',
        entity_units: ['contacts'],
        geographies: ['*'],
        channels: ['email'],
      },
    ],
    constraints: {
      license: {
        status: approved ? 'approved' : 'provisional',
        terms_version: envValue(env, 'GTM_BOUNCER_TERMS_VERSION') || 'unapproved',
        export: approved,
        customer_display: approved,
        outreach_allowed: approved,
        retention_days: 90,
      },
      rate_limits: { requests_per_minute: 1000, concurrent: 10 },
      max_batch: 1,
    },
    cost_model: {
      unit: 'email_verification',
      quoted_credits_per_unit: creditsFromUsd(
        Number.isFinite(parsed) && parsed > 0 ? parsed : BOUNCER_DEFAULT_USD_PER_VERIFICATION,
      ),
      price_version: envValue(env, 'GTM_BOUNCER_PRICE_VERSION') || 'unapproved',
      pay_on_found: false,
    },
    evidence_policy: {
      source_url: 'not_applicable', observed_at: 'not_applicable', max_age_days: null, min_confidence: 0,
    },
    ambiguity_contract: { timeout_is_ambiguous: true, receipt_fields: RECEIPT_FIELDS },
    dsr: { deletion_supported: false },
  }
}

function stateFrom(payload: Record<string, unknown>): VerificationState {
  const status = String(payload.status ?? '').toLowerCase()
  if (status === 'deliverable') return 'verified'
  if (status === 'undeliverable') return 'not_found'
  if (status === 'unknown') return 'unknown'
  if (status === 'risky') {
    const reason = String(payload.reason ?? '').toLowerCase()
    const domain = payload.domain && typeof payload.domain === 'object' && !Array.isArray(payload.domain)
      ? payload.domain as Record<string, unknown>
      : {}
    const acceptAll = String(domain.acceptAll ?? domain.accept_all ?? '').toLowerCase()
    return acceptAll === 'yes' || reason.includes('accept_all') || reason.includes('catch_all')
      ? 'catch_all'
      : 'risky'
  }
  return 'unknown'
}

function receipt(payload: Record<string, unknown>, requestId: string | null, status?: string) {
  return {
    provider_request_id: requestId,
    provider_status: status ?? payload.status ?? null,
    reason: payload.reason ?? null,
    score: payload.score ?? null,
  }
}

export function createBouncerVerifyAdapter(deps: {
  env?: BouncerEnv
  fetchImpl?: BouncerFetch
} = {}): VerifyAdapter {
  const env = deps.env ?? process.env
  const descriptor = bouncerDescriptor(env)
  const fetchImpl = deps.fetchImpl ?? fetch
  return {
    descriptor,
    async verify(request): Promise<AdapterResult<VerificationOutcome>> {
      const coverage = capabilityCovers(descriptor, request)
      if (!coverage.covered) {
        return {
          status: 'error', data: null, cost_units: 0,
          receipt: receipt({}, null, 'unsupported'),
          error: `unsupported_capability: ${coverage.reason ?? 'not covered'}`,
        }
      }
      if (!bouncerEnabled(env)) {
        return {
          status: 'error', data: null, cost_units: 0,
          receipt: receipt({}, null, 'disabled'),
          error: 'provider_disabled: Bouncer requires an API key plus approved terms and price versions',
        }
      }
      try {
        const url = new URL(BOUNCER_VERIFY_URL)
        url.searchParams.set('email', request.value)
        url.searchParams.set('timeout', '10')
        const response = await fetchImpl(url, {
          headers: { 'x-api-key': envValue(env, 'GTM_BOUNCER_API_KEY') },
          signal: AbortSignal.timeout(15_000),
        })
        const requestId = response.headers.get('x-request-id')
        let payload: Record<string, unknown>
        try {
          payload = (await response.json()) as Record<string, unknown>
        } catch {
          return {
            status: 'ambiguous', data: null, cost_units: null,
            receipt: receipt({}, requestId, 'unreadable_response'),
            error: 'provider_transport_unknown: Bouncer response body was unreadable',
          }
        }
        if (!response.ok) {
          return {
            status: 'error', data: null, cost_units: 0,
            receipt: receipt(payload, requestId, `http_${response.status}`),
            error: `provider_http_error: Bouncer returned ${response.status}`,
          }
        }
        const verificationState = stateFrom(payload)
        return {
          status: 'ok',
          data: { channel: 'email', value: request.value, verification_state: verificationState },
          // Bouncer does not charge unknown outcomes; all other definitive
          // outcomes consume one verification credit.
          cost_units: verificationState === 'unknown' ? 0 : 1,
          receipt: receipt(payload, requestId),
        }
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError'
        return {
          status: 'ambiguous',
          data: null,
          cost_units: null,
          receipt: receipt({}, null, timedOut ? 'timeout' : 'transport_unknown'),
          error: timedOut
            ? 'provider_timeout: Bouncer outcome is unknown'
            : 'provider_transport_unknown: Bouncer outcome is unknown',
        }
      }
    },
  }
}
