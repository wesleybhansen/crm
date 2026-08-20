import { creditsFromUsd } from '../../credits/markup'
import {
  capabilityCovers,
  type AdapterDescriptor,
  type AdapterResult,
  type Candidate,
  type SourceAdapter,
  type SourceSearchPlan,
} from '../types'

export const LEADMAGIC_SOURCE_ADAPTER_ID = 'leadmagic-people-search'
export const LEADMAGIC_PEOPLE_SEARCH_URL = 'https://api.leadmagic.io/v3/people/search'
export const LEADMAGIC_DEFAULT_USD_PER_PERSON = 0.025
const RECEIPT_FIELDS = [
  'provider_request_id',
  'provider_status',
  'credits_consumed',
  'returned_people',
  'normalized_people',
]

export type LeadMagicEnv = Record<string, string | undefined>
export type LeadMagicFetch = typeof fetch

function envValue(env: LeadMagicEnv, name: string): string {
  return (env[name] ?? '').trim()
}

function positiveNumber(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function leadMagicApproved(env: LeadMagicEnv = process.env): boolean {
  return (
    envValue(env, 'GTM_LEADMAGIC_CUSTOMER_USE_APPROVED') === 'true' &&
    Boolean(envValue(env, 'GTM_LEADMAGIC_TERMS_VERSION')) &&
    Boolean(envValue(env, 'GTM_LEADMAGIC_PRICE_VERSION'))
  )
}

export function leadMagicEnabled(env: LeadMagicEnv = process.env): boolean {
  return (
    envValue(env, 'GTM_LEADMAGIC_ENABLED') === 'true' &&
    Boolean(envValue(env, 'GTM_LEADMAGIC_API_KEY')) &&
    leadMagicApproved(env)
  )
}

export function leadMagicSourceDescriptor(env: LeadMagicEnv = process.env): AdapterDescriptor {
  const approved = leadMagicApproved(env)
  return {
    contract_version: '2',
    adapter_id: LEADMAGIC_SOURCE_ADAPTER_ID,
    layer: 'source',
    capabilities: [
      {
        signal_kind: 'firmographic_match',
        entity_units: ['people'],
        geographies: ['US'],
        channels: [],
      },
      {
        signal_kind: 'technology_usage',
        entity_units: ['people'],
        geographies: ['US'],
        channels: [],
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
      // Cursor-backed V3 pages are capped at 50. This adapter intentionally
      // performs one page per ledger operation until continuation support is
      // added to the generic source contract.
      max_batch: 50,
    },
    cost_model: {
      unit: 'returned_person',
      quoted_credits_per_unit: creditsFromUsd(
        positiveNumber(
          envValue(env, 'GTM_LEADMAGIC_USD_PER_PERSON'),
          LEADMAGIC_DEFAULT_USD_PER_PERSON,
        ),
      ),
      price_version: envValue(env, 'GTM_LEADMAGIC_PRICE_VERSION') || 'unapproved',
      pay_on_found: true,
    },
    evidence_policy: {
      source_url: 'required',
      observed_at: 'required',
      max_age_days: 30,
      min_confidence: 0.65,
    },
    ambiguity_contract: { timeout_is_ambiguous: true, receipt_fields: RECEIPT_FIELDS },
    dsr: { deletion_supported: false },
  }
}

function receipt(
  status: string,
  returnedPeople: number,
  requestId: string | null = null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    provider_request_id: requestId,
    provider_status: status,
    returned_people: returnedPeople,
    ...extra,
  }
}

function stringFrom(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function stringsFrom(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : []
}

function objectFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function resultsFrom(payload: unknown): Record<string, unknown>[] {
  const root = objectFrom(payload)
  const candidate = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.people)
      ? root.people
      : Array.isArray(root.results)
        ? root.results
        : []
  return candidate.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object'))
}

function normalizePerson(row: Record<string, unknown>, observedAt: string): Candidate | null {
  const company = objectFrom(row.company)
  const first =
    stringFrom(row.contact_first_name) ?? stringFrom(row.first_name) ?? stringFrom(row.firstName)
  const last =
    stringFrom(row.contact_last_name) ?? stringFrom(row.last_name) ?? stringFrom(row.lastName)
  const joinedName = [first, last].filter(Boolean).join(' ').trim()
  const name =
    stringFrom(row.contact_full_name) ??
    stringFrom(row.full_name) ??
    stringFrom(row.name) ??
    (joinedName || null)
  if (!name) return null
  const profileUrl =
    stringFrom(row.contact_linkedin_url) ??
    stringFrom(row.linkedin_url) ??
    stringFrom(row.linkedin_profile_url) ??
    stringFrom(row.profile_url)
  // The documented company object prefixes its fields (company_domain,
  // company_website, company_name). Both spellings are read because the
  // response-row contract has not been confirmed against a live payload, and
  // a null domain/company here silently blocks the whole enrichment waterfall.
  const domain =
    stringFrom(row.company_domain) ??
    stringFrom(company.company_domain) ??
    stringFrom(company.domain) ??
    stringFrom(company.company_website) ??
    stringFrom(company.website)
  const companyName =
    stringFrom(row.contact_company_name) ??
    stringFrom(row.company_name) ??
    stringFrom(company.company_name) ??
    stringFrom(company.name)
  const title =
    stringFrom(row.contact_job_title) ?? stringFrom(row.job_title) ?? stringFrom(row.title)
  const contactLocation = [
    stringFrom(row.contact_city),
    stringFrom(row.contact_state_code),
    stringFrom(row.contact_country_code),
  ]
    .filter(Boolean)
    .join(', ')
  const location =
    stringFrom(row.contact_location) ??
    (contactLocation || null) ??
    stringFrom(row.location) ??
    stringFrom(row.country) ??
    stringFrom(row.city)
  const industry =
    stringFrom(company.company_industry_linkedin) ?? stringFrom(company.industry)
  const companyDescription =
    stringFrom(company.company_about) ?? stringFrom(company.company_headline) ?? stringFrom(company.description)
  const employeeRange = stringFrom(company.employee_range)
  const technologies = stringsFrom(company.tech_stack)

  return {
    entity_kind: 'person',
    identity: {
      name,
      company: companyName,
      title,
      domain,
      urls: profileUrl ? [profileUrl] : [],
      ...(location ? { location } : {}),
      ...(industry ? { industry } : {}),
      ...(companyDescription ? { company_description: companyDescription } : {}),
      ...(employeeRange ? { employee_range: employeeRange } : {}),
      ...(technologies.length ? { technologies } : {}),
      ...(stringFrom(row.contact_job_level) ? { seniority: stringFrom(row.contact_job_level) } : {}),
      ...(stringFrom(row.contact_job_function)
        ? { department: stringFrom(row.contact_job_function) }
        : {}),
    },
    evidence: [
      {
        claim: `${name} matched the approved provider targeting filters${title ? ` as ${title}` : ''}${companyName ? ` at ${companyName}` : ''}.`,
        source_url: profileUrl,
        observed_at: observedAt,
        confidence: 0.75,
        detail: {
          provider_person_id: row.id ?? row.person_id ?? null,
          provider: 'leadmagic',
          match_type: 'people_search',
        },
      },
    ],
  }
}

const ALLOWED_QUERY_KEYS = ['company_filters', 'people_filters', 'query'] as const

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : []
}

function providerPayload(plan: SourceSearchPlan, maxBatch: number): Record<string, unknown> {
  const source = plan.provider_query ?? {}
  // The request ceiling must never exceed the units the ledger reserved. The
  // planner already clamps, so this is defence in depth against a direct call.
  const limit = Math.max(1, Math.min(Math.floor(plan.max_candidates), maxBatch))
  const payload: Record<string, unknown> = { limit }
  for (const key of ALLOWED_QUERY_KEYS) {
    if (source[key] !== undefined) payload[key] = source[key]
  }
  const companyFilters = {
    industries: stringArray(source.industries),
    keyword: stringArray(source.company_keywords).join(' '),
    employee_ranges: stringArray(source.employee_ranges),
    tech_stack: stringArray(source.technologies),
    country_codes: ['US'],
  }
  const peopleFilters = {
    contact_job_level: stringArray(source.seniorities),
    contact_job_function: stringArray(source.departments),
    location: stringArray(source.locations),
    contact_country_code: ['US'],
  }
  if (Object.values(companyFilters).some((value) => Array.isArray(value) ? value.length : Boolean(value))) {
    payload.company_filters = companyFilters
  }
  if (Object.values(peopleFilters).some((values) => values.length)) {
    payload.people_filters = peopleFilters
  }
  const titles = stringArray(source.titles)
  const roles = stringArray(source.roles)
  if (titles.length) payload.titles = titles
  if (roles.length) payload.roles = roles
  /*
   * Source discovery must never unlock raw outreach fields. Contact data is
   * purchased only by the enrichment waterfall after a lead is accepted.
   * The documentation does not state the server-side defaults for the
   * per-field flags, and a returned email or mobile is separately billable
   * (1 and 5 extra credits), so all three are sent explicitly. Leaving them
   * implicit would break the credits_consumed === returned people invariant
   * and park every search as ambiguous after the provider had already charged.
   */
  payload.include_contact_details = false
  payload.include_email = false
  payload.include_mobile = false
  // Legacy plays have no structured provider query. The free text is sent as
  // a provider search query, never interpreted as an instruction.
  if (payload.query === undefined && plan.query.trim()) payload.query = plan.query.trim()
  return payload
}

export function createLeadMagicSourceAdapter(deps: {
  env?: LeadMagicEnv
  fetchImpl?: LeadMagicFetch
  now?: () => Date
} = {}): SourceAdapter {
  const env = deps.env ?? process.env
  const descriptor = leadMagicSourceDescriptor(env)
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => new Date())
  return {
    descriptor,
    quote(plan) {
      const maxCandidates = Math.max(
        0,
        Math.min(Math.floor(plan.max_candidates), descriptor.constraints.max_batch),
      )
      return {
        max_candidates: maxCandidates,
        provider_units: maxCandidates,
        billable_unit: descriptor.cost_model.unit,
        expected_candidates: { low: 0, high: maxCandidates, basis: 'contract' },
        quoted_credits_per_unit: descriptor.cost_model.quoted_credits_per_unit,
        estimated_credits_before_markup:
          maxCandidates * descriptor.cost_model.quoted_credits_per_unit,
      }
    },
    async search(plan): Promise<AdapterResult<Candidate[]>> {
      const coverage = capabilityCovers(descriptor, plan)
      if (!coverage.covered) {
        return {
          status: 'error', data: null, cost_units: 0,
          receipt: receipt('unsupported', 0),
          error: `unsupported_capability: ${coverage.reason ?? 'not covered'}`,
        }
      }
      if (!leadMagicEnabled(env)) {
        return {
          status: 'error', data: null, cost_units: 0,
          receipt: receipt('disabled', 0),
          error: 'provider_disabled: LeadMagic requires an API key plus approved terms and price versions',
        }
      }
      try {
        const body = providerPayload(plan, descriptor.constraints.max_batch)
        const response = await fetchImpl(LEADMAGIC_PEOPLE_SEARCH_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-API-Key': envValue(env, 'GTM_LEADMAGIC_API_KEY'),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        })
        const requestId = response.headers.get('x-request-id')
        let payload: unknown
        try {
          payload = await response.json()
        } catch {
          return {
            status: 'ambiguous', data: null, cost_units: null,
            receipt: receipt('unreadable_response', 0, requestId),
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
        const observedAt = now().toISOString()
        const rows = resultsFrom(payload)
        const root = objectFrom(payload)
        const creditsRaw = finiteNumber(root.credits_consumed)
        const creditsConsumed = creditsRaw != null ? Math.max(0, creditsRaw) : null
        const candidates = rows
          .map((row) => normalizePerson(row, observedAt))
          .filter((row): row is Candidate => row !== null)
          .slice(0, plan.max_candidates)
        if (
          creditsConsumed != null &&
          (creditsConsumed > plan.max_candidates || creditsConsumed !== rows.length)
        ) {
          return {
            status: 'ambiguous', data: null, cost_units: null,
            receipt: receipt('invalid_billing_receipt', rows.length, requestId, {
              credits_consumed: creditsConsumed,
              normalized_people: candidates.length,
              limit_applied: root.limit_applied ?? null,
            }),
            error: 'provider_billing_mismatch: LeadMagic credits did not match returned people or the reserved ceiling',
          }
        }
        if (rows.length > 0 && creditsConsumed == null) {
          return {
            status: 'ambiguous', data: null, cost_units: null,
            receipt: receipt('missing_billing_receipt', rows.length, requestId, {
              credits_consumed: null,
              normalized_people: candidates.length,
            }),
            error: 'provider_billing_unknown: LeadMagic omitted credits_consumed',
          }
        }
        if (candidates.length === 0 && rows.length > 0) {
          return {
            status: 'ambiguous', data: null, cost_units: null,
            receipt: receipt('unusable_paid_response', rows.length, requestId, {
              credits_consumed: creditsConsumed,
              normalized_people: 0,
            }),
            error: 'provider_schema_error: LeadMagic returned paid rows that could not be normalized',
          }
        }
        if (candidates.length === 0) {
          return {
            status: 'no_result', data: null, cost_units: 0,
            receipt: receipt('no_result', 0, requestId, { credits_consumed: creditsConsumed ?? 0 }),
          }
        }
        return {
          status: candidates.length === rows.length ? 'ok' : 'partial',
          data: candidates,
          cost_units: creditsConsumed ?? rows.length,
          receipt: receipt(candidates.length === rows.length ? 'completed' : 'partial', rows.length, requestId, {
            credits_consumed: creditsConsumed ?? rows.length,
            normalized_people: candidates.length,
            raw_people: rows.length,
            limit_applied: root.limit_applied ?? null,
          }),
        }
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError'
        return {
          status: 'ambiguous',
          data: null,
          cost_units: null,
          receipt: receipt(timedOut ? 'timeout' : 'transport_unknown', 0),
          error: timedOut
            ? 'provider_timeout: LeadMagic outcome is unknown'
            : 'provider_transport_unknown: LeadMagic outcome is unknown',
        }
      }
    },
  }
}
