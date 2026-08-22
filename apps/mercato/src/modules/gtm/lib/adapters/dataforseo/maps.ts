import { creditsFromUsd } from '../../credits/markup'
import {
  capabilityCovers,
  type AdapterDescriptor,
  type AdapterResult,
  type Candidate,
  type SourceAdapter,
} from '../types'

export const DATAFORSEO_MAPS_ADAPTER_ID = 'dataforseo-google-maps'
export const DATAFORSEO_MAPS_URL = 'https://api.dataforseo.com/v3/serp/google/maps/live/advanced'
export const DATAFORSEO_DEFAULT_USD_PER_100_RESULTS = 0.002
export const DATAFORSEO_DEFAULT_MAX_DEPTH = 100
export const DATAFORSEO_MAX_KEYWORD_CHARS = 700
export const DATAFORSEO_REQUIRED_TERMS_VERSION = 'dataforseo-tos-2026-06-12'
export const DATAFORSEO_REQUIRED_PRICE_VERSION = 'google-maps-live-advanced-2026-08-21'
export const DATAFORSEO_REQUIRED_RETENTION_DAYS = 30
const PRICE_MULTIPLYING_QUERY_OPERATOR =
  /(^|[^a-z0-9_-])(?:allinanchor|allintext|allintitle|allinurl|define|filetype|id|inanchor|info|intext|intitle|inurl|link|site|-site):/i
const RECEIPT_FIELDS = [
  'provider_request_id',
  'provider_status',
  'root_status_code',
  'root_status_message',
  'task_status_code',
  'task_status_message',
  'root_cost_usd',
  'task_cost_usd',
  'items_count',
]
type DataForSeoEnv = Record<string, string | undefined>
type DataForSeoFetch = typeof fetch

function envValue(env: DataForSeoEnv, name: string): string {
  return (env[name] ?? '').trim()
}

export function dataForSeoApproved(env: DataForSeoEnv = process.env): boolean {
  return (
    envValue(env, 'GTM_DATAFORSEO_CUSTOMER_USE_APPROVED') === 'true' &&
    envValue(env, 'GTM_DATAFORSEO_TERMS_VERSION') === DATAFORSEO_REQUIRED_TERMS_VERSION &&
    envValue(env, 'GTM_DATAFORSEO_PRICE_VERSION') === DATAFORSEO_REQUIRED_PRICE_VERSION &&
    retentionDays(env) === DATAFORSEO_REQUIRED_RETENTION_DAYS
  )
}

export function dataForSeoEnabled(env: DataForSeoEnv = process.env): boolean {
  return (
    envValue(env, 'GTM_DATAFORSEO_ENABLED') === 'true' &&
    Boolean(envValue(env, 'GTM_DATAFORSEO_LOGIN')) &&
    Boolean(envValue(env, 'GTM_DATAFORSEO_PASSWORD')) &&
    dataForSeoApproved(env)
  )
}

function usdPerBlock(_env: DataForSeoEnv): number {
  // Compatibility note: GTM_DATAFORSEO_USD_PER_100_RESULTS is intentionally ignored.
  // A rate change requires a new reviewed price-version constant and code change.
  return DATAFORSEO_DEFAULT_USD_PER_100_RESULTS
}

function maxDepth(_env: DataForSeoEnv): number {
  // Compatibility note: GTM_DATAFORSEO_MAX_DEPTH is intentionally ignored.
  // The reviewed quote covers exactly one Live Advanced task of up to 100 rows.
  return DATAFORSEO_DEFAULT_MAX_DEPTH
}

function retentionDays(env: DataForSeoEnv): number | null {
  const configured = envValue(env, 'GTM_DATAFORSEO_RETENTION_DAYS')
  if (!configured) return null
  const parsed = Number(configured)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function keywordLength(value: string): number {
  return Array.from(value).length
}

export function dataForSeoDescriptor(env: DataForSeoEnv = process.env): AdapterDescriptor {
  const approved = dataForSeoApproved(env)
  return {
    contract_version: '2',
    adapter_id: DATAFORSEO_MAPS_ADAPTER_ID,
    layer: 'source',
    capabilities: [
      {
        signal_kind: 'local_business_listing',
        entity_units: ['companies', 'locations'],
        geographies: ['US'],
        channels: [],
      },
    ],
    constraints: {
      license: {
        status: approved ? 'approved' : 'provisional',
        terms_version: envValue(env, 'GTM_DATAFORSEO_TERMS_VERSION') || 'unapproved',
        export: approved,
        customer_display: approved,
        outreach_allowed: approved,
        retention_days: retentionDays(env),
      },
      rate_limits: { requests_per_minute: 120, concurrent: 5 },
      max_batch: maxDepth(env),
    },
    cost_model: {
      unit: 'maps_100_results',
      quoted_credits_per_unit: creditsFromUsd(usdPerBlock(env)),
      price_version: envValue(env, 'GTM_DATAFORSEO_PRICE_VERSION') || 'unapproved',
      pay_on_found: false,
    },
    evidence_policy: {
      source_url: 'required', observed_at: 'required', max_age_days: 30, min_confidence: 0.7,
    },
    ambiguity_contract: { timeout_is_ambiguous: true, receipt_fields: RECEIPT_FIELDS },
    dsr: { deletion_supported: false },
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const US_STATE_NAMES_BY_ABBREVIATION: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia',
}

const US_STATE_NAMES = new Map(
  Object.values(US_STATE_NAMES_BY_ABBREVIATION).map((name) => [name.toLowerCase(), name]),
)

function canonicalDataForSeoUsLocation(value: string): string | null {
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return 'United States'

  const countryToken = parts.at(-1)?.replaceAll('.', '').toLowerCase()
  if (countryToken === 'us' || countryToken === 'usa' || countryToken === 'united states') {
    parts.pop()
  }
  if (parts.length === 0) return 'United States'

  const stateToken = parts.at(-1) ?? ''
  const state = US_STATE_NAMES_BY_ABBREVIATION[stateToken.toUpperCase()]
    ?? US_STATE_NAMES.get(stateToken.toLowerCase())
  if (!state) return null
  parts[parts.length - 1] = state
  return `${parts.join(',')},United States`
}

function taskFrom(payload: unknown): Record<string, unknown> {
  const root = objectValue(payload)
  return Array.isArray(root.tasks) ? objectValue(root.tasks[0]) : {}
}

function mapItems(task: Record<string, unknown>): Record<string, unknown>[] {
  const result = Array.isArray(task.result) ? objectValue(task.result[0]) : {}
  return Array.isArray(result.items)
    ? result.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    : []
}

function mapsUrl(item: Record<string, unknown>): string | null {
  const placeId = stringValue(item.place_id)
  if (placeId) return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`
  const direct = stringValue(item.url)
  try {
    if (direct && /^https?:$/.test(new URL(direct).protocol)) return direct
  } catch {
    // fall through to null
  }
  return null
}

function keywordAndLocation(plan: { query: string; provider_query?: Record<string, unknown> }) {
  const query = plan.provider_query ?? {}
  const keywords = Array.isArray(query.company_keywords)
    ? query.company_keywords.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : []
  const locations = Array.isArray(query.locations)
    ? query.locations.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : []
  return {
    // One frozen Live task can carry one Maps search phrase. Use the primary
    // ranked phrase rather than concatenating alternatives into an accidental
    // all-terms query that suppresses valid local results.
    keyword: keywords[0]?.trim() || plan.query.trim(),
    location: canonicalDataForSeoUsLocation(locations[0]?.trim() || 'United States'),
  }
}

export function createDataForSeoMapsAdapter(deps: {
  env?: DataForSeoEnv
  fetchImpl?: DataForSeoFetch
  now?: () => Date
} = {}): SourceAdapter {
  const env = deps.env ?? process.env
  const descriptor = dataForSeoDescriptor(env)
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => new Date())
  return {
    descriptor,
    quote(plan) {
      const maxCandidates = Math.max(0, Math.min(Math.floor(plan.max_candidates), maxDepth(env)))
      const providerUnits = Math.ceil(maxCandidates / 100)
      return {
        max_candidates: maxCandidates,
        provider_units: providerUnits,
        billable_unit: descriptor.cost_model.unit,
        expected_candidates: { low: 0, high: maxCandidates, basis: 'provider_quote' },
        quoted_credits_per_unit: descriptor.cost_model.quoted_credits_per_unit,
        estimated_credits_before_markup: providerUnits * descriptor.cost_model.quoted_credits_per_unit,
      }
    },
    async search(plan): Promise<AdapterResult<Candidate[]>> {
      const maxCandidates = Math.max(0, Math.min(Math.floor(plan.max_candidates), maxDepth(env)))
      const blocks = Math.ceil(Math.max(1, maxCandidates) / 100)
      const baseReceipt = (status: string, task: Record<string, unknown> = {}, count = 0) => ({
        provider_request_id: task.id ?? null,
        provider_status: status,
        root_status_code: null,
        root_status_message: null,
        task_status_code: task.status_code ?? null,
        task_status_message: stringValue(task.status_message)?.slice(0, 240) ?? null,
        root_cost_usd: null,
        task_cost_usd: task.cost ?? null,
        items_count: count,
      })
      const coverage = capabilityCovers(descriptor, plan)
      if (!coverage.covered) {
        return { status: 'error', data: null, cost_units: 0, receipt: baseReceipt('unsupported'), error: `unsupported_capability: ${coverage.reason ?? 'not covered'}` }
      }
      if (!dataForSeoEnabled(env)) {
        return { status: 'error', data: null, cost_units: 0, receipt: baseReceipt('disabled'), error: 'provider_disabled: DataForSEO requires credentials plus approved terms and price versions and provider-retention truth' }
      }
      const { keyword, location } = keywordAndLocation(plan)
      if (!keyword) {
        return { status: 'error', data: null, cost_units: 0, receipt: baseReceipt('bad_request'), error: 'bad_request: a local-business keyword is required' }
      }
      if (!location) {
        return { status: 'error', data: null, cost_units: 0, receipt: baseReceipt('bad_request'), error: 'bad_request: DataForSEO requires a US state or a city/county plus state' }
      }
      if (maxCandidates < 1) {
        return { status: 'error', data: null, cost_units: 0, receipt: baseReceipt('bad_request'), error: 'bad_request: DataForSEO requires at least one authorized result' }
      }
      if (keywordLength(keyword) > DATAFORSEO_MAX_KEYWORD_CHARS) {
        return { status: 'error', data: null, cost_units: 0, receipt: baseReceipt('bad_request'), error: 'bad_request: DataForSEO keyword exceeds 700 characters' }
      }
      if (PRICE_MULTIPLYING_QUERY_OPERATOR.test(keyword)) {
        return { status: 'error', data: null, cost_units: 0, receipt: baseReceipt('unpriced_query_operator'), error: 'unpriced_query_operator: DataForSEO query would multiply the frozen base price' }
      }
      try {
        const authorization = Buffer.from(`${envValue(env, 'GTM_DATAFORSEO_LOGIN')}:${envValue(env, 'GTM_DATAFORSEO_PASSWORD')}`).toString('base64')
        const response = await fetchImpl(DATAFORSEO_MAPS_URL, {
          method: 'POST',
          headers: { authorization: `Basic ${authorization}`, 'content-type': 'application/json' },
          body: JSON.stringify([{ keyword, location_name: location, language_code: 'en', depth: maxCandidates }]),
          signal: AbortSignal.timeout(30_000),
        })
        let payload: unknown
        try {
          payload = await response.json()
        } catch {
          return {
            status: 'ambiguous', data: null, cost_units: null,
            receipt: baseReceipt('unreadable_response'),
            error: 'provider_transport_unknown: DataForSEO response body was unreadable',
          }
        }
        const root = objectValue(payload)
        const task = taskFrom(payload)
        const rootStatus = Number(root.status_code ?? 0)
        const taskStatus = Number(task.status_code ?? 0)
        const providerReceipt = (status: string, count = 0) => ({
          ...baseReceipt(status, task, count),
          root_status_code: rootStatus || null,
          root_status_message: stringValue(root.status_message)?.slice(0, 240) ?? null,
          task_status_code: taskStatus || null,
          task_status_message: stringValue(task.status_message)?.slice(0, 240) ?? null,
          root_cost_usd: root.cost ?? null,
        })
        if (!response.ok || rootStatus !== 20000 || taskStatus !== 20000) {
          const failureCode = taskStatus && taskStatus !== 20000
            ? taskStatus
            : rootStatus && rootStatus !== 20000
              ? rootStatus
              : !response.ok
                ? response.status
                : 'missing_task_status'
          return {
            status: 'error', data: null, cost_units: 0,
            receipt: providerReceipt(`provider_error_${failureCode}`),
            error: `provider_application_error: DataForSEO returned root ${rootStatus || 'unknown'} and task ${taskStatus || 'unknown'}`,
          }
        }
        const rootCost = finiteNumber(root.cost)
        const taskCost = finiteNumber(task.cost)
        const authoritativeCost = taskCost != null
          ? Math.max(0, taskCost)
          : rootCost != null
            ? Math.max(0, rootCost)
            : null
        if (authoritativeCost == null) {
          return {
            status: 'ambiguous', data: null, cost_units: null,
            receipt: providerReceipt('missing_billing_receipt'),
            error: 'provider_billing_unknown: DataForSEO omitted task and root cost',
          }
        }
        const actualUnits = authoritativeCost / usdPerBlock(env)
        if (actualUnits > blocks + 1e-9) {
          return {
            status: 'ambiguous', data: null, cost_units: null,
            receipt: providerReceipt('billing_over_reservation'),
            error: 'provider_billing_mismatch: DataForSEO cost exceeded the reserved ceiling',
          }
        }
        const observedAt = stringValue(objectValue(Array.isArray(task.result) ? task.result[0] : {}).datetime) ?? now().toISOString()
        const items = mapItems(task).slice(0, maxCandidates)
        const candidates = items.map((item): Candidate | null => {
          const name = stringValue(item.title)
          const sourceUrl = mapsUrl(item)
          if (!name || !sourceUrl) return null
          return {
            entity_kind: 'company',
            identity: {
              name,
              domain: stringValue(item.domain),
              urls: [sourceUrl],
              location: stringValue(item.address),
              industry: stringValue(item.category),
            },
            evidence: [{
              claim: `${name} appeared in the Google Maps results for “${keyword}” in ${location}.`,
              source_url: sourceUrl,
              observed_at: observedAt,
              confidence: 0.9,
              detail: { provider: 'dataforseo', place_id: item.place_id ?? null, category: item.category ?? null },
            }],
          }
        }).filter((candidate): candidate is Candidate => candidate !== null)
        if (candidates.length === 0) {
          return { status: 'no_result', data: null, cost_units: actualUnits, receipt: providerReceipt('no_result') }
        }
        return { status: 'ok', data: candidates, cost_units: actualUnits, receipt: providerReceipt('completed', candidates.length) }
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError'
        return {
          status: 'ambiguous', data: null, cost_units: null,
          receipt: baseReceipt(timedOut ? 'timeout' : 'transport_unknown'),
          error: timedOut
            ? 'provider_timeout: DataForSEO outcome is unknown'
            : 'provider_transport_unknown: DataForSEO outcome is unknown',
        }
      }
    },
  }
}
