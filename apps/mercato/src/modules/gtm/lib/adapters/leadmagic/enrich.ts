import { creditsFromUsd } from '../../credits/markup'
import {
  capabilityCovers,
  type AdapterDescriptor,
  type AdapterResult,
  type ContactPoint,
  type EnrichAdapter,
} from '../types'
import {
  LEADMAGIC_DEFAULT_USD_PER_PERSON,
  leadMagicApproved,
  type LeadMagicEnv,
  type LeadMagicFetch,
} from './source'

export const LEADMAGIC_ENRICH_ADAPTER_ID = 'leadmagic-email-finder'
export const LEADMAGIC_EMAIL_FINDER_URL = 'https://api.leadmagic.io/v1/people/email-finder'
const RECEIPT_FIELDS = ['provider_request_id', 'provider_status', 'credits_consumed']

function envValue(env: LeadMagicEnv, name: string): string {
  return (env[name] ?? '').trim()
}

function usdPerEmail(env: LeadMagicEnv): number {
  const parsed = Number(envValue(env, 'GTM_LEADMAGIC_USD_PER_EMAIL'))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : LEADMAGIC_DEFAULT_USD_PER_PERSON
}

export function leadMagicEnrichEnabled(env: LeadMagicEnv = process.env): boolean {
  return (
    envValue(env, 'GTM_LEADMAGIC_ENABLED') === 'true' &&
    Boolean(envValue(env, 'GTM_LEADMAGIC_API_KEY')) &&
    leadMagicApproved(env)
  )
}

export function leadMagicEnrichDescriptor(env: LeadMagicEnv = process.env): AdapterDescriptor {
  const approved = leadMagicApproved(env)
  return {
    contract_version: '2',
    adapter_id: LEADMAGIC_ENRICH_ADAPTER_ID,
    layer: 'enrich',
    capabilities: [
      {
        signal_kind: 'contact_discovery',
        entity_units: ['people'],
        geographies: ['US'],
        channels: ['email'],
      },
    ],
    constraints: {
      license: {
        status: approved ? 'approved' : 'provisional',
        terms_version: envValue(env, 'GTM_LEADMAGIC_TERMS_VERSION') || 'unapproved',
        export: approved,
        customer_display: approved,
        outreach_allowed: approved,
        retention_days: 90,
      },
      rate_limits: { requests_per_minute: 300, concurrent: 5 },
      max_batch: 1,
    },
    cost_model: {
      unit: 'found_work_email',
      quoted_credits_per_unit: creditsFromUsd(usdPerEmail(env)),
      price_version: envValue(env, 'GTM_LEADMAGIC_PRICE_VERSION') || 'unapproved',
      pay_on_found: true,
    },
    evidence_policy: {
      source_url: 'not_applicable', observed_at: 'not_applicable', max_age_days: null, min_confidence: 0,
    },
    ambiguity_contract: { timeout_is_ambiguous: true, receipt_fields: RECEIPT_FIELDS },
    dsr: { deletion_supported: false },
  }
}

function receipt(
  status: string,
  credits: number | null,
  requestId: string | null = null,
  extra: Record<string, unknown> = {},
) {
  return {
    provider_request_id: requestId,
    provider_status: status,
    credits_consumed: credits,
    ...extra,
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function createLeadMagicEnrichAdapter(deps: {
  env?: LeadMagicEnv
  fetchImpl?: LeadMagicFetch
} = {}): EnrichAdapter {
  const env = deps.env ?? process.env
  const descriptor = leadMagicEnrichDescriptor(env)
  const fetchImpl = deps.fetchImpl ?? fetch
  return {
    descriptor,
    async enrich(request): Promise<AdapterResult<ContactPoint[]>> {
      const coverage = capabilityCovers(descriptor, request)
      if (!coverage.covered) {
        return {
          status: 'error', data: null, cost_units: 0,
          receipt: receipt('unsupported', 0),
          error: `unsupported_capability: ${coverage.reason ?? 'not covered'}`,
        }
      }
      if (!leadMagicEnrichEnabled(env)) {
        return {
          status: 'error', data: null, cost_units: 0,
          receipt: receipt('disabled', 0),
          error: 'provider_disabled: LeadMagic requires an API key plus approved terms and price versions',
        }
      }
      const identity = request.candidate.identity
      const domain = stringValue(identity.domain)
      const company = stringValue(identity.company)
      const fullName = stringValue(identity.name)
      if (!fullName || (!domain && !company)) {
        return {
          status: 'error', data: null, cost_units: 0,
          receipt: receipt('bad_request', 0),
          error: 'bad_request: name plus company domain or company name is required',
        }
      }
      try {
        const response = await fetchImpl(LEADMAGIC_EMAIL_FINDER_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-API-Key': envValue(env, 'GTM_LEADMAGIC_API_KEY'),
          },
          body: JSON.stringify({
            full_name: fullName,
            ...(domain ? { domain } : { company_name: company }),
          }),
          signal: AbortSignal.timeout(30_000),
        })
        const requestId = response.headers.get('x-request-id')
        let payload: Record<string, unknown>
        try {
          payload = (await response.json()) as Record<string, unknown>
        } catch {
          return {
            status: 'ambiguous', data: null, cost_units: null,
            receipt: receipt('unreadable_response', null, requestId),
            error: 'provider_transport_unknown: LeadMagic response body was unreadable',
          }
        }
        if (!response.ok) {
          return {
            status: 'error', data: null, cost_units: 0,
            receipt: receipt(`http_${response.status}`, 0, requestId),
            error: `provider_http_error: LeadMagic returned ${response.status}`,
          }
        }
        const email = stringValue(payload.email)
        const credits = typeof payload.credits_consumed === 'number'
          ? payload.credits_consumed
          : Number.NaN
        const consumed = Number.isFinite(credits) ? Math.max(0, credits) : null
        if ((email && (consumed == null || consumed > 1)) || (!email && (consumed ?? 0) > 0)) {
          return {
            status: 'ambiguous', data: null, cost_units: null,
            receipt: receipt('invalid_billing_receipt', consumed, requestId),
            error: 'provider_billing_mismatch: LeadMagic Email Finder billing did not match its result',
          }
        }
        if (!email) {
          return {
            status: 'no_result', data: null, cost_units: consumed ?? 0,
            receipt: receipt('no_result', consumed ?? 0, requestId, {
              email_status: payload.status ?? null,
            }),
          }
        }
        return {
          status: 'ok',
          data: [
            {
              channel: 'email',
              value: email,
              provenance: {
                provider: 'leadmagic',
                method: 'email_finder',
                provider_status: payload.status ?? null,
                employment_verified: payload.employment_verified ?? null,
              },
            },
          ],
          cost_units: consumed,
          receipt: receipt('completed', consumed, requestId, {
            email_status: payload.status ?? null,
          }),
        }
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError'
        return {
          status: 'ambiguous',
          data: null,
          cost_units: null,
          receipt: receipt(timedOut ? 'timeout' : 'transport_unknown', null),
          error: timedOut
            ? 'provider_timeout: LeadMagic outcome is unknown'
            : 'provider_transport_unknown: LeadMagic outcome is unknown',
        }
      }
    },
  }
}
