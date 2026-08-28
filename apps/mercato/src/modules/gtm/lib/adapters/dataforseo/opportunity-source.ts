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
  type DemonstratedOpportunityIntent,
  sensitiveConsumerOpportunityReasons,
} from '../../research/opportunity-quality'

export const DATAFORSEO_OPPORTUNITY_ADAPTER_ID = 'dataforseo-organic-demand-opportunities'
export const DATAFORSEO_ORGANIC_URL = 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced'
export const DATAFORSEO_ORGANIC_USD_PER_SERP = 0.002
export const DATAFORSEO_ORGANIC_RESULTS_PER_SERP = 10
export const DATAFORSEO_ORGANIC_MAX_DEPTH = 50
export const DATAFORSEO_OPPORTUNITY_PRICE_VERSION_ENV = 'GTM_DATAFORSEO_ORGANIC_PRICE_VERSION'
export const DATAFORSEO_OPPORTUNITY_REQUIRED_PRICE_VERSION = 'google-organic-live-advanced-2026-08-26'
export const DATAFORSEO_NO_SEARCH_RESULTS_CODE = 40102

const PRICE_MULTIPLYING_QUERY_OPERATOR =
  /(^|[^a-z0-9_-])(?:allinanchor|allintext|allintitle|allinurl|define|filetype|id|inanchor|info|intext|intitle|inurl|link|site|-site):/i

export function hasPriceMultiplyingDataForSeoOpportunityQueryOperator(keyword: string): boolean {
  return PRICE_MULTIPLYING_QUERY_OPERATOR.test(keyword)
}
const SENSITIVE_CONSUMER_TARGETING =
  /\b(?:bereav(?:ed|ement)|widow(?:ed|er)?|probate|divorc(?:e|ed|ing)|foreclos(?:e|ed|ure)|bankrupt(?:cy)?|tax delinquen(?:t|cy)|mortgage payoff|disab(?:led|ility)|medical|health condition|pregnan(?:t|cy)|family status|retire(?:d|ment)|elderly|senior citizen)\b/i
const BUYER_INTENT =
  /\b(?:buy(?:ing)?|buyer|house hunt|home search|first[- ]time home|moving to|move to|relocat(?:e|ing|ion)|looking for (?:a )?(?:home|house|condo))\b/i
const SELLER_INTENT =
  /\b(?:sell(?:ing)?|seller|list(?:ing)? (?:a|my|our|the)? ?(?:home|house|property)|home valuation|home worth|prepare (?:a|my|our|the)? ?(?:home|house) for sale)\b/i
const LOCAL_AUDIENCE =
  /\b(?:local|neighbou?rhood|resident|community|homeowner|real estate|housing|property|home|house|condo)\b/i
const EVENT_HINT = /\b(?:event|meetup|workshop|seminar|webinar|open house|home tour|class|fair)\b/i
const GROUP_HINT = /\b(?:group|club|association)\b/i
const FORUM_HINT = /\bforum\b/i
const VERIFIED_COMMUNITY_TITLE =
  /\b(?:community (?:group|forum|registry|calendar|organization)|neighbou?rhood (?:association|group|forum|organization|calendar)|homeowners? association|resident organization)\b/i
const NON_LOCAL_REDDIT_COMMUNITIES = new Set([
  'realestate',
  'firsttimehomebuyer',
  'homeowners',
  'homeimprovement',
  'personalfinance',
  'mortgages',
  'housing',
])
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
type OpportunityKind = NonNullable<Candidate['identity']['opportunity_kind']>

function envValue(env: DataForSeoEnv, name: string): string {
  return (env[name] ?? '').trim()
}

function retentionDays(env: DataForSeoEnv): number | null {
  const parsed = Number(envValue(env, 'GTM_DATAFORSEO_RETENTION_DAYS'))
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

export function dataForSeoOpportunityApproved(env: DataForSeoEnv = process.env): boolean {
  return (
    envValue(env, 'GTM_DATAFORSEO_CUSTOMER_USE_APPROVED') === 'true' &&
    envValue(env, 'GTM_DATAFORSEO_CONSUMER_OPPORTUNITY_USE_APPROVED') === 'true' &&
    envValue(env, 'GTM_DATAFORSEO_TERMS_VERSION') === DATAFORSEO_REQUIRED_TERMS_VERSION &&
    envValue(env, DATAFORSEO_OPPORTUNITY_PRICE_VERSION_ENV) === DATAFORSEO_OPPORTUNITY_REQUIRED_PRICE_VERSION &&
    retentionDays(env) === DATAFORSEO_REQUIRED_RETENTION_DAYS
  )
}

export function dataForSeoOpportunityEnabled(env: DataForSeoEnv = process.env): boolean {
  return (
    envValue(env, 'GTM_DATAFORSEO_ENABLED') === 'true' &&
    Boolean(envValue(env, 'GTM_DATAFORSEO_LOGIN')) &&
    Boolean(envValue(env, 'GTM_DATAFORSEO_PASSWORD')) &&
    dataForSeoOpportunityApproved(env)
  )
}

export function dataForSeoOpportunityDescriptor(env: DataForSeoEnv = process.env): AdapterDescriptor {
  const approved = dataForSeoOpportunityApproved(env)
  return {
    contract_version: '2',
    adapter_id: DATAFORSEO_OPPORTUNITY_ADAPTER_ID,
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
      rate_limits: { requests_per_minute: 120, concurrent: 5 },
      max_batch: DATAFORSEO_ORGANIC_MAX_DEPTH,
    },
    cost_model: {
      unit: 'organic_serp_10_results',
      quoted_credits_per_unit: creditsFromUsd(DATAFORSEO_ORGANIC_USD_PER_SERP),
      price_version: envValue(env, DATAFORSEO_OPPORTUNITY_PRICE_VERSION_ENV) || 'unapproved',
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
    // The stored record is Noli's bounded public-search projection and can be
    // deleted through the ordinary candidate-removal path.
    dsr: { deletion_supported: true },
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
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
  if (!normalized) return null
  return Array.from(normalized).slice(0, limit).join('')
}

function keywordLength(value: string): number {
  return Array.from(value).length
}

function safePublicUrl(value: unknown): URL | null {
  const raw = stringValue(value)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || !url.hostname.includes('.')) return null
    if (url.hostname === 'localhost' || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal'))
      return null
    url.hash = ''
    return url
  } catch {
    return null
  }
}

function platformName(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^www\./, '')
  if (host.endsWith('reddit.com')) return 'Reddit'
  if (host.endsWith('meetup.com')) return 'Meetup'
  if (host.endsWith('eventbrite.com')) return 'Eventbrite'
  if (host.endsWith('facebook.com')) return 'Facebook'
  if (host.endsWith('linkedin.com')) return 'LinkedIn'
  if (host.endsWith('nextdoor.com')) return 'Nextdoor'
  if (host.endsWith('biggerpockets.com')) return 'BiggerPockets'
  if (host.endsWith('city-data.com')) return 'City-Data'
  if (host.endsWith('quora.com')) return 'Quora'
  if (host.endsWith('youtube.com')) return 'YouTube'
  return host
}

function opportunityKind(url: URL, title: string, resultType: string): OpportunityKind | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const path = url.pathname.toLowerCase()
  if (resultType === 'discussions_and_forums_element') return 'thread'
  if (resultType === 'perspectives_element') return 'post'
  if (resultType === 'events_element') return 'event'
  if (host.endsWith('reddit.com')) return path.includes('/comments/') ? 'thread' : 'community'
  if (host.endsWith('eventbrite.com')) return path.startsWith('/e/') ? 'event' : 'community'
  if (host.endsWith('meetup.com')) return path.includes('/events/') ? 'event' : 'group'
  if (host.endsWith('facebook.com')) {
    if (path.includes('/groups/')) return 'group'
    if (path.includes('/events/')) return 'event'
    if (path.includes('/posts/') || path.includes('/permalink/')) return 'post'
  }
  if (host.endsWith('linkedin.com')) {
    if (path.includes('/groups/')) return 'group'
    if (path.includes('/events/')) return 'event'
    if (path.includes('/posts/') || path.includes('/feed/update/')) return 'post'
  }
  if (host.endsWith('nextdoor.com')) return 'community'
  if (host.endsWith('biggerpockets.com') || host.endsWith('city-data.com')) return 'forum'
  if (host.endsWith('quora.com')) return 'thread'
  if (host.endsWith('youtube.com') && (path.startsWith('/@') || path.startsWith('/channel/'))) {
    return 'creator_audience'
  }
  // Organic-result descriptions frequently splice unrelated sitelinks and
  // snippets together. They may support fit, but cannot manufacture a
  // destination type. Require the title or URL structure to prove the venue.
  if (EVENT_HINT.test(title) || /\/(?:events?|calendar)(?:\/|$)/.test(path)) return 'event'
  if (FORUM_HINT.test(title) || /\/(?:forums?|boards?)(?:\/|$)/.test(path)) return 'forum'
  if (GROUP_HINT.test(title) || /\/(?:groups?|clubs?)(?:\/|$)/.test(path)) return 'group'
  if (/\/(?:threads?|topics?|questions?|discussions?)(?:\/|$)/.test(path)) {
    return 'thread'
  }
  if (VERIFIED_COMMUNITY_TITLE.test(title) || /\/(?:community|communities|neighbou?rhoods?)(?:\/|$)/.test(path)) {
    return 'community'
  }
  return null
}

function normalizedLocationToken(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function redditCommunityConflictsWithLocation(url: URL, requestedLocation: string): boolean {
  if (!url.hostname.toLowerCase().endsWith('reddit.com')) return false
  const subreddit = url.pathname.match(/^\/r\/([^/]+)/i)?.[1]
  if (!subreddit) return false
  const returned = normalizedLocationToken(subreddit)
  if (NON_LOCAL_REDDIT_COMMUNITIES.has(returned)) return false
  const [primary, region] = requestedLocation.split(',')
  const expected = [normalizedLocationToken(primary), normalizedLocationToken(region)].filter(Boolean)
  return !expected.some((value) => returned.includes(value) || value.includes(returned))
}

function demonstratedSearchResultLocation(args: {
  title: string
  description: string | null
  url: URL
  requestedLocation: string
  expectedIntent: DemonstratedOpportunityIntent
  kind: OpportunityKind
}): string | null {
  if (redditCommunityConflictsWithLocation(args.url, args.requestedLocation)) return null
  const titleAndUrl = `${args.title} ${args.url.hostname} ${args.url.pathname}`
  const direct = demonstratedOpportunityLocation(titleAndUrl, args.requestedLocation)
  if (direct) return direct
  if (!args.description) return null
  const segments = args.description
    .split(/(?:\.{2,}|(?<=[.!?])\s+|\s+\|\s+|\s+—\s+)/)
    .map((value) => value.trim())
    .filter(Boolean)
  for (const segment of segments) {
    const location = demonstratedOpportunityLocation(segment, args.requestedLocation)
    if (!location) continue
    const suitability = assessRealtorOpportunitySuitability(
      segment,
      args.expectedIntent,
      args.url.toString(),
      args.kind,
    )
    if (suitability.relevant) return location
  }
  return null
}

function recommendedAction(kind: OpportunityKind): string {
  if (kind === 'event') {
    return 'Open the event page, confirm the current audience and participation rules, then decide whether to attend, sponsor, or contribute manually.'
  }
  return 'Open the public source, read the current rules and full conversation, then contribute one useful response manually. Do not automate posting or direct outreach.'
}

function messageAngle(intent: Candidate['identity']['intent_kind']): string {
  if (intent === 'buyer_intent') {
    return 'Offer a useful local buying answer that resolves the question before mentioning your services.'
  }
  if (intent === 'seller_intent') {
    return 'Share a practical seller answer grounded in the local market, then offer help without pressure.'
  }
  if (intent === 'mixed_intent') {
    return 'Address the buy-versus-sell decision with a clear sequence and local tradeoffs.'
  }
  return 'Contribute locally useful information that fits the community or event context.'
}

const MONTH_NAME =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?\s+20\d{2}\b/i
const ISO_CALENDAR_DATE = /\b20\d{2}-\d{2}-\d{2}\b/
const MONTH_DAY =
  /\b(?:(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?),?\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

function explicitEventStartAt(value: string, referenceValue: string): string | null {
  const match = value.match(ISO_CALENDAR_DATE)?.[0] ?? value.match(MONTH_NAME)?.[0]
  if (match) {
    const date = new Date(match.replace(/(\d)(?:st|nd|rd|th)\b/i, '$1'))
    return Number.isFinite(date.getTime()) ? date.toISOString() : null
  }

  const monthDay = value.match(MONTH_DAY)
  const reference = new Date(referenceValue)
  if (!monthDay || !Number.isFinite(reference.getTime())) return null
  const weekday = monthDay[1]?.slice(0, 3).toLowerCase() ?? null
  const month = monthDay[2]
  const day = monthDay[3]
  const candidates: Date[] = []
  for (let year = reference.getUTCFullYear() - 3; year <= reference.getUTCFullYear() + 1; year += 1) {
    const candidate = new Date(`${month} ${day}, ${year} 12:00:00 UTC`)
    if (!Number.isFinite(candidate.getTime())) continue
    if (weekday != null && candidate.getUTCDay() !== WEEKDAY_INDEX[weekday]) continue
    candidates.push(candidate)
  }
  candidates.sort(
    (left, right) =>
      Math.abs(left.getTime() - reference.getTime()) - Math.abs(right.getTime() - reference.getTime()),
  )
  return candidates[0]?.toISOString() ?? null
}

function strictProviderTimestamp(value: unknown): string | null {
  const raw = stringValue(value)
  if (!raw) return null
  const date = new Date(raw)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

export function normalizeDataForSeoOpportunityItem(
  item: Record<string, unknown>,
  context: {
    keyword: string
    location: string
    observedAt: string
    expectedIntent?: DemonstratedOpportunityIntent
  },
): Candidate | null {
  const resultType = stringValue(item.type)?.toLowerCase() ?? ''
  if (!['organic', 'discussions_and_forums_element', 'perspectives_element', 'events_element'].includes(resultType)) {
    return null
  }
  const url = safePublicUrl(item.url)
  const title = boundedText(item.title, 180)
  const description = boundedText(item.description, 500)
  if (!url || !title) return null
  const searchable = `${title} ${description ?? ''} ${url.pathname}`
  if (
    SENSITIVE_CONSUMER_TARGETING.test(searchable)
    || sensitiveConsumerOpportunityReasons(searchable).length > 0
  ) return null
  if (resultType === 'events_element' && /(^|\.)google\.[a-z.]+$/i.test(url.hostname)) return null
  const kind = opportunityKind(url, title, resultType)
  if (!kind) return null
  if (!LOCAL_AUDIENCE.test(searchable) && !BUYER_INTENT.test(searchable) && !SELLER_INTENT.test(searchable)) {
    return null
  }
  const demonstratedIntent = classifyOpportunityIntent(searchable)
  const intent = demonstratedIntent.kind
  const platform = platformName(url.hostname)
  const demonstratedLocation = context.expectedIntent == null
    ? demonstratedOpportunityLocation(searchable, context.location)
    : demonstratedSearchResultLocation({
        title,
        description,
        url,
        requestedLocation: context.location,
        expectedIntent: context.expectedIntent,
        kind,
      })
  const eventStartAt = kind === 'event' ? explicitEventStartAt(searchable, context.observedAt) : null
  const sourcePublishedAt = strictProviderTimestamp(item.timestamp)
  const engagementCount = Math.max(0, finiteNumber(item.posts_count) ?? 0)
  const accessType =
    kind === 'event'
      ? url.hostname.toLowerCase().endsWith('eventbrite.com')
        ? 'ticketed' as const
        : 'public' as const
      : kind === 'group'
        ? 'approval_required' as const
        : 'public' as const
  const candidate: Candidate = {
    entity_kind: 'opportunity',
    identity: {
      name: title,
      urls: [url.toString()],
      location: demonstratedLocation,
      provider_location: context.location,
      opportunity_kind: kind,
      platform,
      intent_kind: intent,
      audience_description: description ?? `${title} on ${platform}`,
      activity_level: 'unknown',
      access_type: accessType,
      event_start_at: eventStartAt,
      source_published_at: sourcePublishedAt,
      engagement_count: engagementCount,
      participation_rules:
        'Check current community or event rules before participating. Be useful, disclose affiliation when relevant, and do not automate contact.',
      recommended_action: recommendedAction(kind),
      message_angle: messageAngle(intent),
    },
    evidence: [
      {
        claim: `${title} appeared in public search results for “${context.keyword}” in ${context.location}.`,
        source_url: url.toString(),
        observed_at: context.observedAt,
        confidence: calibratedOpportunityConfidence({
          content: searchable,
          sourceUrl: url.toString(),
          observedAt: sourcePublishedAt ?? context.observedAt,
          attemptedAt: context.observedAt,
          engagement: engagementCount,
          location: demonstratedLocation,
        }),
        detail: {
          provider: 'dataforseo',
          result_type: resultType,
          platform,
          requested_location: context.location,
          requested_intent: context.expectedIntent ?? null,
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
  return candidate
}

function taskFrom(payload: unknown): Record<string, unknown> {
  const root = objectValue(payload)
  return Array.isArray(root.tasks) ? objectValue(root.tasks[0]) : {}
}

function opportunityItems(task: Record<string, unknown>): Record<string, unknown>[] {
  const result = Array.isArray(task.result) ? objectValue(task.result[0]) : {}
  if (!Array.isArray(result.items)) return []
  return result.items.flatMap((value) => {
    const item = objectValue(value)
    const type = stringValue(item.type)?.toLowerCase()
    if (type === 'organic') return [item]
    if (!['discussions_and_forums', 'perspectives', 'events'].includes(type ?? '')) return []
    if (!Array.isArray(item.items)) return []
    return item.items
      .map((nested) => objectValue(nested))
      .filter((nested) => Boolean(stringValue(nested.url)) && Boolean(stringValue(nested.title)))
      .map((nested) => ({
        ...nested,
        rank_group: finiteNumber(nested.rank_group) ?? finiteNumber(item.rank_group),
        rank_absolute: finiteNumber(nested.rank_absolute) ?? finiteNumber(item.rank_absolute),
      }))
  })
}

export function dataForSeoOpportunityQuery(plan: SourceSearchPlan): {
  keyword: string
  location: string | null
} {
  const providerQuery = plan.provider_query ?? {}
  const explicit = stringValue(providerQuery.search_query)
  const discovery = Array.isArray(providerQuery.source_search_keywords)
    ? providerQuery.source_search_keywords.find((value) => typeof value === 'string' && value.trim())
    : null
  const locations = Array.isArray(providerQuery.locations)
    ? providerQuery.locations.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : []
  return {
    keyword: explicit ?? stringValue(discovery) ?? plan.query.trim(),
    location: canonicalDataForSeoUsLocation(locations[0] ?? plan.geography),
  }
}

export function createDataForSeoOpportunityAdapter(
  deps: {
    env?: DataForSeoEnv
    fetchImpl?: DataForSeoFetch
    now?: () => Date
  } = {},
): SourceAdapter {
  const env = deps.env ?? process.env
  const descriptor = dataForSeoOpportunityDescriptor(env)
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => new Date())
  return {
    descriptor,
    quote(plan) {
      const maxCandidates = Math.max(0, Math.min(Math.floor(plan.max_candidates), DATAFORSEO_ORGANIC_MAX_DEPTH))
      const providerUnits = Math.ceil(maxCandidates / DATAFORSEO_ORGANIC_RESULTS_PER_SERP)
      return {
        max_candidates: maxCandidates,
        provider_units: providerUnits,
        billable_unit: descriptor.cost_model.unit,
        expected_candidates: {
          low: 0,
          high: maxCandidates,
          basis: 'provider_quote',
        },
        quoted_credits_per_unit: descriptor.cost_model.quoted_credits_per_unit,
        estimated_credits_before_markup: providerUnits * descriptor.cost_model.quoted_credits_per_unit,
      }
    },
    async search(plan): Promise<AdapterResult<Candidate[]>> {
      const maxCandidates = Math.max(0, Math.min(Math.floor(plan.max_candidates), DATAFORSEO_ORGANIC_MAX_DEPTH))
      const reservedUnits = Math.ceil(Math.max(1, maxCandidates) / DATAFORSEO_ORGANIC_RESULTS_PER_SERP)
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
          status: 'error',
          data: null,
          cost_units: 0,
          receipt: baseReceipt('unsupported'),
          error: `unsupported_capability: ${coverage.reason ?? 'not covered'}`,
        }
      }
      if (!dataForSeoOpportunityEnabled(env)) {
        return {
          status: 'error',
          data: null,
          cost_units: 0,
          receipt: baseReceipt('disabled'),
          error:
            'provider_disabled: DataForSEO organic opportunities require credentials plus exact customer-use, terms, price, and retention approval',
        }
      }
      const { keyword, location } = dataForSeoOpportunityQuery(plan)
      if (!keyword || maxCandidates < 1) {
        return {
          status: 'error',
          data: null,
          cost_units: 0,
          receipt: baseReceipt('bad_request'),
          error: 'bad_request: a public demand-opportunity query and at least one result are required',
        }
      }
      if (!location) {
        return {
          status: 'error',
          data: null,
          cost_units: 0,
          receipt: baseReceipt('bad_request'),
          error: 'bad_request: DataForSEO requires a US state or a city/county plus state',
        }
      }
      if (keywordLength(keyword) > DATAFORSEO_MAX_KEYWORD_CHARS) {
        return {
          status: 'error',
          data: null,
          cost_units: 0,
          receipt: baseReceipt('bad_request'),
          error: 'bad_request: DataForSEO keyword exceeds 700 characters',
        }
      }
      if (hasPriceMultiplyingDataForSeoOpportunityQueryOperator(keyword)) {
        return {
          status: 'error',
          data: null,
          cost_units: 0,
          receipt: baseReceipt('unpriced_query_operator'),
          error: 'unpriced_query_operator: DataForSEO query would multiply the frozen base price',
        }
      }
      if (SENSITIVE_CONSUMER_TARGETING.test(keyword)) {
        return {
          status: 'error',
          data: null,
          cost_units: 0,
          receipt: baseReceipt('unsafe_consumer_targeting'),
          error: 'unsafe_consumer_targeting: sensitive consumer demand research is blocked',
        }
      }
      try {
        const authorization = Buffer.from(
          `${envValue(env, 'GTM_DATAFORSEO_LOGIN')}:${envValue(env, 'GTM_DATAFORSEO_PASSWORD')}`,
        ).toString('base64')
        const response = await fetchImpl(DATAFORSEO_ORGANIC_URL, {
          method: 'POST',
          headers: {
            authorization: `Basic ${authorization}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify([
            {
              keyword,
              location_name: location,
              language_code: 'en',
              depth: maxCandidates,
            },
          ]),
          signal: AbortSignal.timeout(30_000),
        })
        let payload: unknown
        try {
          payload = await response.json()
        } catch {
          return {
            status: 'ambiguous',
            data: null,
            cost_units: null,
            receipt: baseReceipt('unreadable_response'),
            error: 'provider_transport_unknown: DataForSEO response body was unreadable',
          }
        }
        const root = objectValue(payload)
        const task = taskFrom(payload)
        const rootStatus = Number(root.status_code ?? 0)
        const taskStatus = Number(task.status_code ?? 0)
        const providerReceipt = (status: string, count = 0, rawCount = count) => ({
          ...baseReceipt(status, task, count),
          root_status_code: rootStatus || null,
          root_status_message: boundedText(root.status_message, 240),
          task_status_code: taskStatus || null,
          task_status_message: boundedText(task.status_message, 240),
          root_cost_usd: root.cost ?? null,
          raw_item_count: rawCount,
          returned_count: count,
          parser_dropped_rows: Math.max(0, rawCount - count),
        })
        const rootCost = finiteNumber(root.cost)
        const taskCost = finiteNumber(task.cost)
        const authoritativeCost =
          taskCost != null ? Math.max(0, taskCost) : rootCost != null ? Math.max(0, rootCost) : null
        const actualUnits =
          authoritativeCost != null ? authoritativeCost / DATAFORSEO_ORGANIC_USD_PER_SERP : null
        if (actualUnits != null && actualUnits > reservedUnits + 1e-9) {
          return {
            status: 'ambiguous',
            data: null,
            cost_units: null,
            receipt: providerReceipt('billing_over_reservation'),
            error: 'provider_billing_mismatch: DataForSEO cost exceeded the reserved ceiling',
          }
        }
        if (!response.ok || rootStatus !== 20000 || taskStatus !== 20000) {
          const failureCode =
            taskStatus && taskStatus !== 20000
              ? taskStatus
              : rootStatus && rootStatus !== 20000
                ? rootStatus
                : !response.ok
                  ? response.status
                  : 'missing_task_status'
          if (actualUnits == null) {
            return {
              status: 'ambiguous',
              data: null,
              cost_units: null,
              receipt: providerReceipt(`provider_error_${failureCode}_billing_unknown`),
              error: `provider_billing_unknown: DataForSEO returned root ${rootStatus || 'unknown'} and task ${taskStatus || 'unknown'} without a final cost`,
            }
          }
          if (response.ok && rootStatus === 20000 && taskStatus === DATAFORSEO_NO_SEARCH_RESULTS_CODE) {
            return {
              status: 'no_result',
              data: null,
              cost_units: actualUnits,
              receipt: providerReceipt('no_result'),
            }
          }
          return {
            status: 'error',
            data: null,
            cost_units: actualUnits,
            receipt: providerReceipt(`provider_error_${failureCode}`),
            error: `provider_application_error: DataForSEO returned root ${rootStatus || 'unknown'} and task ${taskStatus || 'unknown'}`,
          }
        }
        if (actualUnits == null) {
          return {
            status: 'ambiguous',
            data: null,
            cost_units: null,
            receipt: providerReceipt('missing_billing_receipt'),
            error: 'provider_billing_unknown: DataForSEO omitted task and root cost',
          }
        }
        const result = objectValue(Array.isArray(task.result) ? task.result[0] : {})
        const observedAt = stringValue(result.datetime) ?? now().toISOString()
        const rawItems = opportunityItems(task).slice(0, maxCandidates)
        const candidates = rawItems
          .map((item) =>
            normalizeDataForSeoOpportunityItem(item, {
              keyword,
              location,
              observedAt,
              expectedIntent: requestedOpportunityIntent(plan),
            }),
          )
          .filter((candidate): candidate is Candidate => candidate !== null)
        if (candidates.length === 0) {
          return {
            status: 'no_result',
            data: null,
            cost_units: actualUnits,
            receipt: providerReceipt('no_result', 0, rawItems.length),
          }
        }
        return {
          status: 'ok',
          data: candidates,
          cost_units: actualUnits,
          receipt: providerReceipt('completed', candidates.length, rawItems.length),
        }
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError'
        return {
          status: 'ambiguous',
          data: null,
          cost_units: null,
          receipt: baseReceipt(timedOut ? 'timeout' : 'transport_unknown'),
          error: timedOut
            ? 'provider_timeout: DataForSEO outcome is unknown'
            : 'provider_transport_unknown: DataForSEO outcome is unknown',
        }
      }
    },
  }
}

function requestedOpportunityIntent(plan: SourceSearchPlan): DemonstratedOpportunityIntent {
  const value = plan.provider_query?.opportunity_intent_lane
  return value === 'buyer_intent'
    || value === 'seller_intent'
    || value === 'local_audience'
    || value === 'mixed_intent'
    ? value
    : null
}
