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
export const DATAFORSEO_PROVIDER_MAX_DEPTH = 700
export const DATAFORSEO_MAX_KEYWORD_CHARS = 700
const PRICE_MULTIPLYING_QUERY_OPERATOR =
  /(^|[^a-z0-9_-])(?:allinanchor|allintext|allintitle|allinurl|define|filetype|id|inanchor|info|intext|intitle|inurl|link|site|-site):/i
const RECEIPT_FIELDS = [
  'provider_request_id',
  'provider_status',
  'root_status_code',
  'task_status_code',
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
    Boolean(envValue(env, 'GTM_DATAFORSEO_TERMS_VERSION')) &&
    Boolean(envValue(env, 'GTM_DATAFORSEO_PRICE_VERSION'))
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

function usdPerBlock(env: DataForSeoEnv): number {
  const parsed = Number(envValue(env, 'GTM_DATAFORSEO_USD_PER_100_RESULTS'))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DATAFORSEO_DEFAULT_USD_PER_100_RESULTS
}

function maxDepth(env: DataForSeoEnv): number {
  const parsed = Number(envValue(env, 'GTM_DATAFORSEO_MAX_DEPTH'))
  if (!Number.isInteger(parsed) || parsed < 1) return DATAFORSEO_DEFAULT_MAX_DEPTH
  return Math.min(parsed, DATAFORSEO_PROVIDER_MAX_DEPTH)
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
        retention_days: 90,
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
    keyword: keywords.join(' ') || plan.query.trim(),
    location: locations[0]?.trim() || 'United States',
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
        task_status_code: task.status_code ?? null,
        root_cost_usd: null,
        task_cost_usd: task.cost ?? null,
        items_count: count,
      })
      const coverage = capabilityCovers(descriptor, plan)
      if (!coverage.covered) {
        return { status: 'error', data: null, cost_units: 0, receipt: baseReceipt('unsupported'), error: `unsupported_capability: ${coverage.reason ?? 'not covered'}` }
      }
      if (!dataForSeoEnabled(env)) {
        return { status: 'error', data: null, cost_units: 0, receipt: baseReceipt('disabled'), error: 'provider_disabled: DataForSEO requires credentials plus approved terms and price versions' }
      }
      const { keyword, location } = keywordAndLocation(plan)
      if (!keyword) {
        return { status: 'error', data: null, cost_units: 0, receipt: baseReceipt('bad_request'), error: 'bad_request: a local-business keyword is required' }
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
          task_status_code: taskStatus || null,
          root_cost_usd: root.cost ?? null,
        })
        if (!response.ok || rootStatus !== 20000 || taskStatus !== 20000) {
          return {
            status: 'error', data: null, cost_units: 0,
            receipt: providerReceipt(`provider_error_${rootStatus || taskStatus || response.status}`),
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
