import { creditsFromUsd } from '../../credits/markup'
import {
  capabilityCovers,
  type AdapterDescriptor,
  type AdapterResult,
  type Candidate,
  type SourceAdapter,
  type SourceSearchPlan,
} from '../types'
import {
  DATAFORSEO_MAX_KEYWORD_CHARS,
  DATAFORSEO_REQUIRED_RETENTION_DAYS,
  DATAFORSEO_REQUIRED_TERMS_VERSION,
  canonicalDataForSeoUsLocation,
} from './maps'
import {
  assessRealtorOpportunitySuitability,
  calibratedOpportunityConfidence,
  classifyOpportunityIntent,
  demonstratedOpportunityLocation,
  sensitiveConsumerOpportunityReasons,
  type DemonstratedOpportunityIntent,
} from '../../research/opportunity-quality'

export const DATAFORSEO_EVENTS_OPPORTUNITY_ADAPTER_ID = 'dataforseo-events-demand-opportunities'
export const DATAFORSEO_EVENTS_URL = 'https://api.dataforseo.com/v3/serp/google/events/live/advanced'
export const DATAFORSEO_EVENTS_USD_PER_SERP = 0.002
export const DATAFORSEO_EVENTS_RESULTS_PER_SERP = 10
export const DATAFORSEO_EVENTS_MAX_DEPTH = 30
export const DATAFORSEO_EVENTS_DATE_RANGE = 'month'
export const DATAFORSEO_EVENTS_PRICE_VERSION_ENV = 'GTM_DATAFORSEO_EVENTS_PRICE_VERSION'
export const DATAFORSEO_EVENTS_REQUIRED_PRICE_VERSION = 'google-events-live-advanced-2026-08-30'
export const DATAFORSEO_EVENTS_ENABLED_ENV = 'GTM_DATAFORSEO_EVENTS_OPPORTUNITY_ENABLED'

const DATAFORSEO_NO_SEARCH_RESULTS_CODE = 40102
const SENSITIVE_CONSUMER_TARGETING =
  /\b(?:bereav(?:ed|ement)|widow(?:ed|er)?|probate|divorc(?:e|ed|ing)|foreclos(?:e|ed|ure)|bankrupt(?:cy)?|tax delinquen(?:t|cy)|mortgage payoff|disab(?:led|ility)|medical|health condition|pregnan(?:t|cy)|family status|retire(?:d|ment)|elderly|senior citizen)\b/i
const GOOGLE_HOST = /(^|\.)google\.[a-z.]+$/i
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
  'provider_failure_class',
]

type DataForSeoEventsEnv = Record<string, string | undefined>
type DataForSeoEventsFetch = typeof fetch
type EventDropReason =
  | 'unsupported_result_type'
  | 'unsafe_url_or_missing_title'
  | 'sensitive_targeting'
  | 'expired_or_missing_event_date'
  | 'unproven_market'
  | 'unproven_realtor_relevance'

function envValue(env: DataForSeoEventsEnv, name: string): string {
  return (env[name] ?? '').trim()
}

function retentionDays(env: DataForSeoEventsEnv): number | null {
  const parsed = Number(envValue(env, 'GTM_DATAFORSEO_RETENTION_DAYS'))
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

export function dataForSeoEventsOpportunityApproved(
  env: DataForSeoEventsEnv = process.env,
): boolean {
  return (
    envValue(env, 'GTM_DATAFORSEO_CUSTOMER_USE_APPROVED') === 'true'
    && envValue(env, 'GTM_DATAFORSEO_CONSUMER_OPPORTUNITY_USE_APPROVED') === 'true'
    && envValue(env, 'GTM_DATAFORSEO_TERMS_VERSION') === DATAFORSEO_REQUIRED_TERMS_VERSION
    && envValue(env, DATAFORSEO_EVENTS_PRICE_VERSION_ENV) === DATAFORSEO_EVENTS_REQUIRED_PRICE_VERSION
    && retentionDays(env) === DATAFORSEO_REQUIRED_RETENTION_DAYS
  )
}

export function dataForSeoEventsOpportunityEnabled(
  env: DataForSeoEventsEnv = process.env,
): boolean {
  return (
    envValue(env, DATAFORSEO_EVENTS_ENABLED_ENV) === 'true'
    && envValue(env, 'GTM_DATAFORSEO_ENABLED') === 'true'
    && Boolean(envValue(env, 'GTM_DATAFORSEO_LOGIN'))
    && Boolean(envValue(env, 'GTM_DATAFORSEO_PASSWORD'))
    && dataForSeoEventsOpportunityApproved(env)
  )
}

export function dataForSeoEventsOpportunityDescriptor(
  env: DataForSeoEventsEnv = process.env,
): AdapterDescriptor {
  const approved = dataForSeoEventsOpportunityApproved(env)
  return {
    contract_version: '2',
    adapter_id: DATAFORSEO_EVENTS_OPPORTUNITY_ADAPTER_ID,
    layer: 'source',
    capabilities: [
      {
        signal_kind: 'social_engagement',
        entity_units: ['opportunities'],
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
        audience_modes: ['business', 'consumer'],
        manual_outreach_allowed: approved,
        automated_email_allowed: false,
        public_profile_contact_allowed: false,
        public_opportunity_use_allowed: approved,
      },
      rate_limits: { requests_per_minute: 2_000, concurrent: 5 },
      max_batch: DATAFORSEO_EVENTS_MAX_DEPTH,
    },
    cost_model: {
      unit: 'google_events_serp_10_results',
      quoted_credits_per_unit: creditsFromUsd(DATAFORSEO_EVENTS_USD_PER_SERP),
      price_version: envValue(env, DATAFORSEO_EVENTS_PRICE_VERSION_ENV) || 'unapproved',
      pay_on_found: false,
    },
    evidence_policy: {
      source_url: 'required',
      observed_at: 'required',
      max_age_days: 30,
      min_confidence: 0.72,
    },
    ambiguity_contract: {
      timeout_is_ambiguous: true,
      receipt_fields: RECEIPT_FIELDS,
    },
    dsr: { deletion_supported: true },
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
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

function boundedText(value: unknown, limit: number): string | null {
  const normalized = stringValue(value)?.replace(/\s+/g, ' ')
  return normalized ? Array.from(normalized).slice(0, limit).join('') : null
}

function safePublicUrl(value: unknown): URL | null {
  const raw = stringValue(value)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || !url.hostname.includes('.') || GOOGLE_HOST.test(url.hostname)) {
      return null
    }
    if (url.hostname === 'localhost' || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')) {
      return null
    }
    url.hash = ''
    return url
  } catch {
    return null
  }
}

function platformName(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^www\./, '')
  if (host.endsWith('eventbrite.com')) return 'Eventbrite'
  if (host.endsWith('meetup.com')) return 'Meetup'
  if (host.endsWith('facebook.com')) return 'Facebook'
  if (host.endsWith('linkedin.com')) return 'LinkedIn'
  return host
}

function strictTimestamp(value: unknown): string | null {
  const raw = stringValue(value)
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}

function ticketRows(item: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(item.information_and_tickets)
    ? item.information_and_tickets.map(objectValue)
    : []
}

function eventDestination(item: Record<string, unknown>): URL | null {
  const direct = safePublicUrl(item.url)
  if (direct) return direct
  for (const row of ticketRows(item)) {
    const ticketUrl = safePublicUrl(row.url)
    if (ticketUrl) return ticketUrl
  }
  return null
}

function eventAccessType(item: Record<string, unknown>): 'public' | 'ticketed' {
  return ticketRows(item).some((row) => /\b(?:ticket|register|rsvp|admission)\b/i.test(
    `${stringValue(row.title) ?? ''} ${stringValue(row.description) ?? ''}`,
  )) ? 'ticketed' : 'public'
}

function eventItems(task: Record<string, unknown>): Record<string, unknown>[] {
  const result = Array.isArray(task.result) ? objectValue(task.result[0]) : {}
  if (!Array.isArray(result.items)) return []
  return result.items
    .map(objectValue)
    .filter((item) => stringValue(item.type)?.toLowerCase() === 'event_item')
}

function eventQuery(plan: SourceSearchPlan): {
  keyword: string
  location: string | null
  dateRange: string | null
} {
  const providerQuery = plan.provider_query ?? {}
  const locations = Array.isArray(providerQuery.locations)
    ? providerQuery.locations.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : []
  return {
    keyword: stringValue(providerQuery.search_query) ?? plan.query.trim(),
    location: canonicalDataForSeoUsLocation(locations[0] ?? plan.geography),
    dateRange: stringValue(providerQuery.date_range),
  }
}

function requestedIntent(plan: SourceSearchPlan): DemonstratedOpportunityIntent {
  const value = plan.provider_query?.opportunity_intent_lane
  return value === 'buyer_intent'
    || value === 'seller_intent'
    || value === 'local_audience'
    || value === 'mixed_intent'
    ? value
    : null
}

function normalizeEventWithDiagnostics(
  item: Record<string, unknown>,
  context: {
    keyword: string
    location: string
    observedAt: string
    expectedIntent: DemonstratedOpportunityIntent
  },
): { candidate: Candidate | null; dropReason: EventDropReason | null } {
  if (stringValue(item.type)?.toLowerCase() !== 'event_item') {
    return { candidate: null, dropReason: 'unsupported_result_type' }
  }
  const title = boundedText(item.title, 180)
  const description = boundedText(item.description, 700)
  const url = eventDestination(item)
  if (!title || !url) return { candidate: null, dropReason: 'unsafe_url_or_missing_title' }

  const locationInfo = objectValue(item.location_info)
  const venue = boundedText(locationInfo.name, 180)
  const address = boundedText(locationInfo.address, 240)
  const dates = objectValue(item.event_dates)
  const eventStartAt = strictTimestamp(dates.start_datetime)
  const eventEndAt = strictTimestamp(dates.end_datetime)
  const displayedDates = boundedText(dates.displayed_dates, 160)
  const ticketText = ticketRows(item)
    .map((row) => `${boundedText(row.title, 120) ?? ''} ${boundedText(row.description, 240) ?? ''}`)
    .join(' ')
  const searchable = [title, description, venue, address, displayedDates, ticketText].filter(Boolean).join(' ')
  if (SENSITIVE_CONSUMER_TARGETING.test(searchable) || sensitiveConsumerOpportunityReasons(searchable).length > 0) {
    return { candidate: null, dropReason: 'sensitive_targeting' }
  }
  if (!eventStartAt || new Date(eventEndAt ?? eventStartAt).getTime() < new Date(context.observedAt).getTime()) {
    return { candidate: null, dropReason: 'expired_or_missing_event_date' }
  }
  const demonstratedLocation = demonstratedOpportunityLocation(searchable, context.location)
  if (!demonstratedLocation) return { candidate: null, dropReason: 'unproven_market' }

  const suitability = assessRealtorOpportunitySuitability(
    searchable,
    context.expectedIntent,
    url.toString(),
    'event',
  )
  if (!suitability.relevant) return { candidate: null, dropReason: 'unproven_realtor_relevance' }

  const demonstratedIntent = classifyOpportunityIntent(searchable)
  const platform = platformName(url.hostname)
  const accessType = eventAccessType(item)
  const candidate: Candidate = {
    entity_kind: 'opportunity',
    identity: {
      name: title,
      urls: [url.toString()],
      location: demonstratedLocation,
      provider_location: context.location,
      opportunity_kind: 'event',
      platform,
      intent_kind: demonstratedIntent.kind,
      audience_description: description ?? `${title} at ${venue ?? demonstratedLocation}`,
      activity_level: 'unknown',
      access_type: accessType,
      event_start_at: eventStartAt,
      source_published_at: null,
      participation_rules:
        'Review the organizer terms before attending or participating. Do not infer that real estate professionals or promotion are permitted.',
      participation_rules_status: 'unverified',
      recommended_action:
        'Open the event page, verify the audience and organizer rules, then attend or register manually only if professional participation is permitted.',
      message_angle:
        'Answer relevant housing questions when invited and provide useful local context without unsolicited promotion.',
    },
    evidence: [
      {
        claim: `${title} is listed for ${eventStartAt} at ${venue ?? demonstratedLocation}.`,
        source_url: url.toString(),
        observed_at: context.observedAt,
        confidence: calibratedOpportunityConfidence({
          content: searchable,
          sourceUrl: url.toString(),
          observedAt: eventStartAt,
          attemptedAt: context.observedAt,
          engagement: 0,
          location: demonstratedLocation,
        }),
        detail: {
          provider: 'dataforseo-google-events',
          result_type: 'event_item',
          platform,
          requested_location: context.location,
          requested_intent: context.expectedIntent,
          venue,
          address,
          displayed_dates: displayedDates,
          event_start_at: eventStartAt,
          event_end_at: eventEndAt,
          rank_group: finiteNumber(item.rank_group),
          rank_absolute: finiteNumber(item.rank_absolute),
          demonstrated_intent_signals: [
            ...demonstratedIntent.buyerSignals,
            ...demonstratedIntent.sellerSignals,
            ...demonstratedIntent.localAudienceSignals,
          ],
        },
      },
    ],
  }
  return { candidate, dropReason: null }
}

export function normalizeDataForSeoEventOpportunity(
  item: Record<string, unknown>,
  context: {
    keyword: string
    location: string
    observedAt: string
    expectedIntent: DemonstratedOpportunityIntent
  },
): Candidate | null {
  return normalizeEventWithDiagnostics(item, context).candidate
}

function taskFrom(payload: unknown): Record<string, unknown> {
  const root = objectValue(payload)
  return Array.isArray(root.tasks) ? objectValue(root.tasks[0]) : {}
}

export function createDataForSeoEventsOpportunityAdapter(
  deps: {
    env?: DataForSeoEventsEnv
    fetchImpl?: DataForSeoEventsFetch
    now?: () => Date
  } = {},
): SourceAdapter {
  const env = deps.env ?? process.env
  const descriptor = dataForSeoEventsOpportunityDescriptor(env)
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => new Date())
  return {
    descriptor,
    quote(plan) {
      const maxCandidates = Math.max(0, Math.min(Math.floor(plan.max_candidates), DATAFORSEO_EVENTS_MAX_DEPTH))
      const providerUnits = Math.ceil(maxCandidates / DATAFORSEO_EVENTS_RESULTS_PER_SERP)
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
      const maxCandidates = Math.max(0, Math.min(Math.floor(plan.max_candidates), DATAFORSEO_EVENTS_MAX_DEPTH))
      const reservedUnits = Math.ceil(Math.max(1, maxCandidates) / DATAFORSEO_EVENTS_RESULTS_PER_SERP)
      const baseReceipt = (status: string, task: Record<string, unknown> = {}, count = 0) => ({
        provider_request_id: task.id ?? null,
        provider_status: status,
        root_status_code: null,
        root_status_message: null,
        task_status_code: task.status_code ?? null,
        task_status_message: boundedText(task.status_message, 240),
        root_cost_usd: null,
        task_cost_usd: task.cost ?? null,
        items_count: count,
      })
      const coverage = capabilityCovers(descriptor, plan)
      if (!coverage.covered) {
        return {
          status: 'error', data: null, cost_units: 0, receipt: baseReceipt('unsupported'),
          error: `unsupported_capability: ${coverage.reason ?? 'not covered'}`,
        }
      }
      if (!dataForSeoEventsOpportunityEnabled(env)) {
        return {
          status: 'error', data: null, cost_units: 0, receipt: baseReceipt('disabled'),
          error: 'provider_disabled: DataForSEO Events requires its explicit enable flag plus exact customer-use, terms, price, and retention approval',
        }
      }
      const { keyword, location, dateRange } = eventQuery(plan)
      if (!keyword || maxCandidates < 1) {
        return {
          status: 'error', data: null, cost_units: 0, receipt: baseReceipt('bad_request'),
          error: 'bad_request: an event query and at least one result are required',
        }
      }
      if (!location) {
        return {
          status: 'error', data: null, cost_units: 0, receipt: baseReceipt('bad_request'),
          error: 'bad_request: DataForSEO Events requires a US state or a city/county plus state',
        }
      }
      if (dateRange !== DATAFORSEO_EVENTS_DATE_RANGE) {
        return {
          status: 'error', data: null, cost_units: 0, receipt: baseReceipt('unsupported_date_range'),
          error: 'unsupported_date_range: DataForSEO Events requires the frozen next-month search window',
        }
      }
      if (Array.from(keyword).length > DATAFORSEO_MAX_KEYWORD_CHARS) {
        return {
          status: 'error', data: null, cost_units: 0, receipt: baseReceipt('bad_request'),
          error: 'bad_request: DataForSEO event keyword exceeds 700 characters',
        }
      }
      if (SENSITIVE_CONSUMER_TARGETING.test(keyword)) {
        return {
          status: 'error', data: null, cost_units: 0, receipt: baseReceipt('unsafe_consumer_targeting'),
          error: 'unsafe_consumer_targeting: sensitive consumer demand research is blocked',
        }
      }

      try {
        const authorization = Buffer.from(
          `${envValue(env, 'GTM_DATAFORSEO_LOGIN')}:${envValue(env, 'GTM_DATAFORSEO_PASSWORD')}`,
        ).toString('base64')
        const response = await fetchImpl(DATAFORSEO_EVENTS_URL, {
          method: 'POST',
          headers: { authorization: `Basic ${authorization}`, 'content-type': 'application/json' },
          body: JSON.stringify([{
            keyword,
            location_name: location,
            language_code: 'en',
            depth: maxCandidates,
            date_range: dateRange,
          }]),
          signal: AbortSignal.timeout(30_000),
        })
        let payload: unknown
        try {
          payload = await response.json()
        } catch {
          return {
            status: 'ambiguous', data: null, cost_units: null, receipt: baseReceipt('unreadable_response'),
            error: 'provider_transport_unknown: DataForSEO Events response body was unreadable',
          }
        }
        const root = objectValue(payload)
        const task = taskFrom(payload)
        const rootStatus = Number(root.status_code ?? 0)
        const taskStatus = Number(task.status_code ?? 0)
        const rootCost = finiteNumber(root.cost)
        const taskCost = finiteNumber(task.cost)
        const authoritativeCost = taskCost != null ? Math.max(0, taskCost) : rootCost != null ? Math.max(0, rootCost) : null
        const actualUnits = authoritativeCost == null ? null : authoritativeCost / DATAFORSEO_EVENTS_USD_PER_SERP
        const providerReceipt = (
          status: string,
          count = 0,
          rawCount = count,
          parserDropReasons: Partial<Record<EventDropReason, number>> = {},
        ) => ({
          ...baseReceipt(status, task, count),
          root_status_code: rootStatus || null,
          root_status_message: boundedText(root.status_message, 240),
          task_status_code: taskStatus || null,
          task_status_message: boundedText(task.status_message, 240),
          provider_failure_class: taskStatus === 40101 ? 'search_engine_error_after_provider_retries' : null,
          root_cost_usd: root.cost ?? null,
          raw_item_count: rawCount,
          returned_count: count,
          parser_dropped_rows: Math.max(0, rawCount - count),
          parser_drop_reasons: parserDropReasons,
        })
        if (actualUnits != null && actualUnits > reservedUnits + 1e-9) {
          return {
            status: 'ambiguous', data: null, cost_units: null,
            receipt: providerReceipt('billing_over_reservation'),
            error: 'provider_billing_mismatch: DataForSEO Events cost exceeded the reserved ceiling',
          }
        }
        if (!response.ok || rootStatus !== 20000 || taskStatus !== 20000) {
          const failureCode = taskStatus && taskStatus !== 20000
            ? taskStatus
            : rootStatus && rootStatus !== 20000
              ? rootStatus
              : !response.ok ? response.status : 'missing_task_status'
          if (actualUnits == null) {
            return {
              status: 'ambiguous', data: null, cost_units: null,
              receipt: providerReceipt(`provider_error_${failureCode}_billing_unknown`),
              error: `provider_billing_unknown: DataForSEO Events returned root ${rootStatus || 'unknown'} and task ${taskStatus || 'unknown'} without a final cost`,
            }
          }
          if (response.ok && rootStatus === 20000 && taskStatus === DATAFORSEO_NO_SEARCH_RESULTS_CODE) {
            return { status: 'no_result', data: null, cost_units: actualUnits, receipt: providerReceipt('no_result') }
          }
          return {
            status: 'error', data: null, cost_units: actualUnits,
            receipt: providerReceipt(`provider_error_${failureCode}`),
            error: `provider_application_error: DataForSEO Events returned root ${rootStatus || 'unknown'} and task ${taskStatus || 'unknown'}`,
          }
        }
        if (actualUnits == null) {
          return {
            status: 'ambiguous', data: null, cost_units: null, receipt: providerReceipt('missing_billing_receipt'),
            error: 'provider_billing_unknown: DataForSEO Events omitted task and root cost',
          }
        }
        const result = objectValue(Array.isArray(task.result) ? task.result[0] : {})
        const observedAt = strictTimestamp(result.datetime) ?? now().toISOString()
        const rawItems = eventItems(task).slice(0, maxCandidates)
        const normalized = rawItems.map((item) => normalizeEventWithDiagnostics(item, {
          keyword,
          location,
          observedAt,
          expectedIntent: requestedIntent(plan),
        }))
        const candidates = normalized
          .map(({ candidate }) => candidate)
          .filter((candidate): candidate is Candidate => candidate !== null)
        const parserDropReasons = normalized.reduce<Partial<Record<EventDropReason, number>>>((counts, row) => {
          if (row.dropReason) counts[row.dropReason] = (counts[row.dropReason] ?? 0) + 1
          return counts
        }, {})
        if (candidates.length === 0) {
          return {
            status: 'no_result', data: null, cost_units: actualUnits,
            receipt: providerReceipt('no_result', 0, rawItems.length, parserDropReasons),
          }
        }
        return {
          status: 'ok', data: candidates, cost_units: actualUnits,
          receipt: providerReceipt('completed', candidates.length, rawItems.length, parserDropReasons),
        }
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError'
        return {
          status: 'ambiguous', data: null, cost_units: null,
          receipt: baseReceipt(timedOut ? 'timeout' : 'transport_unknown'),
          error: timedOut
            ? 'provider_timeout: DataForSEO Events outcome is unknown'
            : 'provider_transport_unknown: DataForSEO Events outcome is unknown',
        }
      }
    },
  }
}
