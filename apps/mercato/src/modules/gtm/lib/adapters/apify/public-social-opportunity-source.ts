import { creditsFromUsd } from '../../credits/markup'
import {
  capabilityCovers,
  type AdapterDescriptor,
  type AdapterResult,
  type Candidate,
  type CandidateIdentity,
  type SourceAdapter,
  type SourceSearchPlan,
} from '../types'
import {
  APIFY_ENABLED_ENV,
  APIFY_TERMS_VERSION_ENV,
  APIFY_TIMEOUT_MS_ENV,
  APIFY_TOKEN_ENVS,
  apifyCustomerUseApproved,
  apifyEnabled,
  apifyToken,
} from './source'
import {
  APIFY_DEFAULT_TIMEOUT_MS,
  APIFY_MIN_CHARGE_USD,
  runActorWithFinalizedBilling,
  type ApifyFetchLike,
  type ApifyFinalizedBillingContract,
  type ApifyRunOutcome,
} from './client'
import {
  calibratedOpportunityConfidence,
  classifyOpportunityIntent,
  demonstratedOpportunityLocation,
  type DemonstratedOpportunityIntent,
  sensitiveConsumerOpportunityReasons,
} from '../../research/opportunity-quality'

const APIFY_MILLIDOLLAR_USD = 0.001
const MAX_RESULTS = 25
const MAX_DATASET_BODY_BYTES = 2_000_000
const SENSITIVE_TARGETING =
  /\b(?:bereav(?:ed|ement)|widow(?:ed|er)?|probate|divorc(?:e|ed|ing)|foreclos(?:e|ed|ure)|bankrupt(?:cy)?|tax delinquen(?:t|cy)|mortgage payoff|disab(?:led|ility)|medical|health condition|pregnan(?:t|cy)|family status|retire(?:d|ment)|elderly|senior citizen)\b/i

type SocialEnv = Record<string, string | undefined>
type SocialPlatform = 'Reddit' | 'X' | 'Threads'

export type PublicSocialOpportunityConfig = {
  adapterId: string
  platform: SocialPlatform
  enabledEnv?: string
  actorId: string
  actorBuild: string
  actorEnv: string
  useApprovalEnv: string
  priceVersionEnv: string
  requiredPriceVersion: string
  eventPricesUsd: Record<string, number>
  oneTimeEvent: string | null
  primaryResultEvent: string
  auxiliaryResultEvents?: readonly string[]
  perItemQuoteUsd: number
  oneTimeQuoteUsd: number
  datasetFields: readonly string[]
  buildInput(plan: SourceSearchPlan, maxResults: number, attemptedAt: string): Record<string, unknown>
  isNoResultDiagnostic?(value: unknown): boolean
  normalize(value: unknown, context: NormalizeContext): Candidate | null
}

type NormalizeContext = {
  query: string
  location: string | null
  expectedIntent?: DemonstratedOpportunityIntent
  scopedSubreddits?: string[]
  attemptedAt: string
  actorId: string
}

function redditFilterKeywords(plan: SourceSearchPlan): string[] {
  const values = plan.provider_query?.reddit_filter_keywords
  if (!Array.isArray(values)) return []
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(Boolean)
    .slice(0, 8)
}

function returnedContentMatchesRedditFilter(candidate: Candidate, plan: SourceSearchPlan): boolean {
  if (plan.provider_query?.reddit_returned_content_filter_version === 'semantic-intent-location-v1') {
    const content = [candidate.identity.name, candidate.identity.audience_description]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
    const expected = plan.provider_query?.reddit_filter_required_intent
    const observed = classifyOpportunityIntent(content).kind
    const intentMatches =
      expected === 'local_audience'
        ? observed === 'local_audience'
          || observed === 'buyer_intent'
          || observed === 'seller_intent'
          || observed === 'mixed_intent'
        : expected === 'mixed_intent'
          ? observed === 'buyer_intent'
            || observed === 'seller_intent'
            || observed === 'mixed_intent'
          : observed === expected || observed === 'mixed_intent'
    if (!intentMatches) return false
    if (plan.provider_query?.reddit_filter_require_location !== true) return true
    const requestedLocation = locationText(plan)
    return Boolean(
      requestedLocation
      && (
        candidate.identity.location === requestedLocation
        || demonstratedOpportunityLocation(content, requestedLocation)
      ),
    )
  }
  const keywords = redditFilterKeywords(plan)
  if (keywords.length === 0) return true
  const content = [candidate.identity.name, candidate.identity.audience_description]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
  const matches = keywords.map((keyword) => content.includes(keyword))
  const mode = plan.provider_query?.reddit_filter_keyword_mode
  if (mode === 'all') return matches.every(Boolean)
  if (mode === 'first_and_any') return matches[0] === true && matches.slice(1).some(Boolean)
  return matches.some(Boolean)
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

type RunActor = (
  actorId: string,
  input: Record<string, unknown>,
  options: {
    token: string
    build: string
    timeoutMs: number
    maxItems: number
    maxChargeUsd: number
    datasetFields: string[]
    maxDatasetBodyBytes: number
    now: () => Date
  },
) => Promise<ApifyRunOutcome>

type PublicSocialDeps = {
  env?: SocialEnv
  now?: () => Date
  runActor?: RunActor
  fetchImpl?: ApifyFetchLike
  finalizationDelayMs?: number
  sleep?: (delayMs: number) => Promise<void>
}

export const APIFY_REDDIT_OPPORTUNITY_CONFIG: PublicSocialOpportunityConfig = {
  adapterId: 'apify-reddit-demand-opportunities',
  platform: 'Reddit',
  actorId: 'clearpath/reddit-search-scraper',
  actorBuild: '0.0.66',
  actorEnv: 'GTM_APIFY_ACTOR_REDDIT_SEARCH',
  useApprovalEnv: 'GTM_APIFY_REDDIT_OPPORTUNITY_USE_APPROVED',
  priceVersionEnv: 'GTM_APIFY_REDDIT_SEARCH_PRICE_VERSION',
  // Rechecked against the actor's current public pricing contract after the
  // production account moved to Starter on 2026-08-30. Every run charges one
  // start event; each returned row charges both a primary result event and the
  // platform dataset-item event. Keeping all three in the finalized receipt
  // prevents the Store headline from understating the actual reserved cost.
  requiredPriceVersion: 'clearpath-reddit-search-0.0.66-starter-events-2026-08-30',
  eventPricesUsd: {
    'apify-actor-start': 0.00099,
    'apify-default-dataset-item': 0.00001,
    'result-scraped': 0.00099,
  },
  oneTimeEvent: 'apify-actor-start',
  primaryResultEvent: 'result-scraped',
  auxiliaryResultEvents: ['apify-default-dataset-item'],
  perItemQuoteUsd: 0.001,
  oneTimeQuoteUsd: 0.00099,
  datasetFields: [
    '_type',
    '_status',
    'id',
    'title',
    'author',
    'subreddit',
    'score',
    'commentCount',
    'createdAt',
    'permalink',
    'body',
    'isNsfw',
    'isLocked',
    'isArchived',
    'subredditInfo',
    'postId',
    'postTitle',
    'postUrl',
    'postCommentCount',
    'postCreatedAt',
    'parentId',
    'subredditSubscribers',
  ],
  buildInput(plan, maxResults) {
    const subreddits = redditSubreddits(plan)
    const autoDiscoverSubreddits = subreddits.length === 0 && redditAutoDiscover(plan)
    if (autoDiscoverSubreddits && !redditGlobalSearch(plan)) {
      throw new TypeError('subreddit auto-discovery requires an explicitly governed global Reddit search')
    }
    const query = queryText(plan, 700)
    validateRedditGlobalSearch(plan, {
      query,
      maxResults,
      subreddits,
      autoDiscoverSubreddits,
    })
    return {
      query,
      maxResults,
      contentType: redditContentType(plan),
      sort: redditSort(plan),
      timeFilter: redditTimeFilter(plan),
      subreddits,
      autoDiscoverSubreddits,
      ...(autoDiscoverSubreddits ? { maxSubreddits: redditMaxSubreddits(plan) } : {}),
    }
  },
  normalize: normalizeRedditOpportunity,
}

export const APIFY_X_OPPORTUNITY_CONFIG: PublicSocialOpportunityConfig = {
  adapterId: 'apify-x-demand-opportunities',
  platform: 'X',
  enabledEnv: 'GTM_APIFY_X_OPPORTUNITY_ENABLED',
  actorId: 'scraper_one/x-posts-search',
  actorBuild: '0.0.154',
  actorEnv: 'GTM_APIFY_ACTOR_X_POST_SEARCH',
  useApprovalEnv: 'GTM_APIFY_X_OPPORTUNITY_USE_APPROVED',
  priceVersionEnv: 'GTM_APIFY_X_POST_SEARCH_PRICE_VERSION',
  // The Starter transition was rechecked without running the actor on
  // 2026-08-29. Build 0.0.154 prices BRONZE at $0.0025 once per run and
  // $0.00025 per result. A plan or actor-build change must update this exact
  // account contract instead of silently changing reservation math.
  requiredPriceVersion: 'scraper-one-x-post-search-0.0.154-bronze-events-2026-08-29',
  eventPricesUsd: { init: 0.0025, 'result-item': 0.00025 },
  oneTimeEvent: 'init',
  primaryResultEvent: 'result-item',
  perItemQuoteUsd: 0.00025,
  oneTimeQuoteUsd: 0.0025,
  datasetFields: [
    'postText',
    'postUrl',
    'timestamp',
    'conversationId',
    'postId',
    'author',
    'replyCount',
    'quoteCount',
    'repostCount',
    'favouriteCount',
  ],
  buildInput(plan, maxResults) {
    return {
      query: queryText(plan, 100),
      resultsCount: maxResults,
      timeWindow: recencyDays(plan),
      searchType: 'latest',
    }
  },
  normalize: normalizeXOpportunity,
}

export const APIFY_THREADS_OPPORTUNITY_CONFIG: PublicSocialOpportunityConfig = {
  adapterId: 'apify-threads-demand-opportunities',
  platform: 'Threads',
  enabledEnv: 'GTM_APIFY_THREADS_OPPORTUNITY_ENABLED',
  actorId: 'pro100chok/threads-scraper-usage',
  actorBuild: '0.5.1',
  actorEnv: 'GTM_APIFY_ACTOR_THREADS_SEARCH',
  useApprovalEnv: 'GTM_APIFY_THREADS_OPPORTUNITY_USE_APPROVED',
  priceVersionEnv: 'GTM_APIFY_THREADS_SEARCH_PRICE_VERSION',
  // The Starter transition was rechecked against the actor's effective
  // BRONZE tier table without running it on 2026-08-29: each run costs
  // $0.0001 and each returned dataset item costs $0.002. The actor is
  // explicitly pinned to public post search, so provider-extracted profile
  // contact fields are never requested or retained by this adapter.
  requiredPriceVersion: 'pro100chok-threads-scraper-usage-0.5.1-bronze-events-2026-08-29',
  eventPricesUsd: { 'apify-actor-start': 0.0001, 'apify-default-dataset-item': 0.002 },
  oneTimeEvent: 'apify-actor-start',
  primaryResultEvent: 'apify-default-dataset-item',
  perItemQuoteUsd: 0.002,
  oneTimeQuoteUsd: 0.0001,
  datasetFields: [
    'post_id',
    'code',
    'username',
    'full_name',
    'is_private',
    'text',
    'taken_at',
    'like_count',
    'reply_count',
    'repost_count',
    'quote_count',
    'reshare_count',
    'post_url',
    'is_reply',
  ],
  buildInput(plan, maxResults) {
    return {
      action: 'search',
      queries: [queryText(plan, 100)],
      serp_type: 'default',
      maxItems: maxResults,
      useOurAccounts: true,
    }
  },
  normalize: normalizeThreadsOpportunity,
}

function envValue(env: SocialEnv, name: string): string {
  return (env[name] ?? '').trim()
}

function configuredActor(config: PublicSocialOpportunityConfig, env: SocialEnv): string {
  return envValue(env, config.actorEnv) || config.actorId
}

function timeoutMs(env: SocialEnv): number {
  const parsed = Number(envValue(env, APIFY_TIMEOUT_MS_ENV))
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : APIFY_DEFAULT_TIMEOUT_MS
}

export function publicSocialOpportunityApproved(
  config: PublicSocialOpportunityConfig,
  env: SocialEnv = process.env,
): boolean {
  return (
    apifyCustomerUseApproved(env) &&
    envValue(env, config.useApprovalEnv) === 'true' &&
    envValue(env, config.priceVersionEnv) === config.requiredPriceVersion &&
    configuredActor(config, env) === config.actorId
  )
}

export function publicSocialOpportunityEnabled(
  config: PublicSocialOpportunityConfig,
  env: SocialEnv = process.env,
): boolean {
  const capabilityEnabled = config.enabledEnv == null || envValue(env, config.enabledEnv) === 'true'
  return (
    capabilityEnabled
    && apifyEnabled(env)
    && apifyToken(env) !== null
    && publicSocialOpportunityApproved(config, env)
  )
}

export function publicSocialOpportunityDescriptor(
  config: PublicSocialOpportunityConfig,
  env: SocialEnv = process.env,
): AdapterDescriptor {
  const approved = publicSocialOpportunityApproved(config, env)
  return {
    contract_version: '2',
    adapter_id: config.adapterId,
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
        terms_version: envValue(env, APIFY_TERMS_VERSION_ENV) || 'unapproved',
        export: approved,
        customer_display: approved,
        outreach_allowed: approved,
        retention_days: 30,
        audience_modes: ['business', 'consumer'],
        manual_outreach_allowed: approved,
        automated_email_allowed: false,
        public_profile_contact_allowed: approved,
        public_opportunity_use_allowed: approved,
      },
      rate_limits: { requests_per_minute: 20, concurrent: 1 },
      max_batch: MAX_RESULTS,
    },
    cost_model: {
      unit: 'apify_millidollar',
      quoted_credits_per_unit: creditsFromUsd(APIFY_MILLIDOLLAR_USD),
      price_version: envValue(env, config.priceVersionEnv) || 'unapproved',
      pay_on_found: false,
    },
    evidence_policy: {
      source_url: 'required',
      observed_at: 'required',
      max_age_days: 30,
      min_confidence: 0.75,
    },
    ambiguity_contract: {
      timeout_is_ambiguous: true,
      receipt_fields: ['actor_id', 'run_id', 'item_count', 'charged_event_counts'],
    },
    dsr: { deletion_supported: true },
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized ? Array.from(normalized).slice(0, max).join('') : null
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function sourceKeywords(plan: SourceSearchPlan): string | null {
  const values = plan.provider_query?.source_search_keywords
  if (!Array.isArray(values)) return null
  return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim())) ?? null
}

function queryText(plan: SourceSearchPlan, max: number): string {
  const query =
    text(plan.provider_query?.search_query, max) ?? text(sourceKeywords(plan), max) ?? text(plan.query, max) ?? ''
  if (!query) throw new TypeError('a bounded public opportunity query is required')
  if (SENSITIVE_TARGETING.test(query)) {
    throw new TypeError('sensitive consumer demand research is blocked')
  }
  return query
}

function locationText(plan: SourceSearchPlan): string | null {
  const values = plan.provider_query?.locations
  if (!Array.isArray(values)) return text(plan.geography, 180)
  return (
    text(
      values.find((value) => typeof value === 'string' && value.trim()),
      180,
    ) ?? text(plan.geography, 180)
  )
}

function recencyText(plan: SourceSearchPlan): string {
  return (
    text(
      plan.provider_query?.recency_window ?? plan.provider_query?.recency ?? plan.provider_query?.posted_limit,
      80,
    )?.toLowerCase() ?? 'month'
  )
}

function recencyDays(plan: SourceSearchPlan): number {
  const raw = recencyText(plan)
  const numeric = raw.match(/\b(\d{1,3})\s*days?\b/)
  if (numeric) return Math.max(1, Math.min(30, Number(numeric[1])))
  if (/hour|today|24h|day/.test(raw)) return 1
  if (/week|7d/.test(raw)) return 7
  return 30
}

function redditTimeFilter(plan: SourceSearchPlan): '' | 'hour' | 'day' | 'week' | 'month' | 'year' {
  const raw = recencyText(plan)
  const numeric = raw.match(/\b(\d{1,3})\s*days?\b/)
  if (numeric) {
    const days = Number(numeric[1])
    if (days <= 1) return 'day'
    if (days <= 7) return 'week'
    if (days <= 30) return 'month'
    return 'year'
  }
  if (/hour|1h/.test(raw)) return 'hour'
  if (/week|7d|\b7 days?\b/.test(raw)) return 'week'
  if (/today|24h|day/.test(raw)) return 'day'
  if (/year|365d/.test(raw)) return 'year'
  return 'month'
}

function redditSort(plan: SourceSearchPlan): 'relevance' | 'new' | 'top' | 'hot' | 'comments' {
  const value = text(plan.provider_query?.reddit_sort, 20)?.toLowerCase()
  return value && ['relevance', 'new', 'top', 'hot', 'comments'].includes(value)
    ? value as 'relevance' | 'new' | 'top' | 'hot' | 'comments'
    : 'new'
}

function redditContentType(plan: SourceSearchPlan): 'posts' | 'comments' {
  // `both` can emit up to twice maxResults under the actor contract and would
  // exceed the one-result-ceiling quote used by this adapter. Each content
  // type therefore remains a separately visible and separately metered lane.
  return plan.provider_query?.reddit_content_type === 'comments' ? 'comments' : 'posts'
}

function redditAutoDiscover(plan: SourceSearchPlan): boolean {
  return plan.provider_query?.reddit_auto_discover === true
}

function redditGlobalSearch(plan: SourceSearchPlan): boolean {
  return plan.provider_query?.reddit_global_search === true
}

function validateRedditGlobalSearch(
  plan: SourceSearchPlan,
  input: {
    query: string
    maxResults: number
    subreddits: string[]
    autoDiscoverSubreddits: boolean
  },
): void {
  if (!redditGlobalSearch(plan)) return
  if (input.subreddits.length > 0 || !input.autoDiscoverSubreddits) {
    throw new TypeError('global Reddit search requires bounded subreddit auto-discovery and no frozen scope')
  }
  if (input.maxResults > 10) {
    throw new TypeError('global Reddit search is limited to 10 results')
  }
  if (redditTimeFilter(plan) === 'year') {
    throw new TypeError('global Reddit search must stay inside the 30-day recency window')
  }
  const location = locationText(plan)
  const market = location?.split(',')[0]?.trim().toLowerCase() ?? ''
  if (market.length < 3 || !input.query.toLowerCase().includes(market)) {
    throw new TypeError('global Reddit search query must contain the requested market')
  }
}

function redditMaxSubreddits(plan: SourceSearchPlan): number {
  const parsed = Number(plan.provider_query?.reddit_max_subreddits)
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(8, parsed)) : 6
}

function redditSubreddits(plan: SourceSearchPlan): string[] {
  const values = plan.provider_query?.reddit_subreddits
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().replace(/^\/?r\//i, ''))
    .filter((value) => /^[a-z0-9_]{2,50}$/i.test(value))
    .filter((value) => {
      const key = value.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 8)
}

function scopedSubredditLocation(
  subreddit: string | null,
  scopedSubreddits: string[] | undefined,
  requestedLocation: string | null,
): string | null {
  if (!subreddit || !requestedLocation || !scopedSubreddits?.length) return null
  const returned = subreddit.toLowerCase().replace(/[^a-z0-9]/g, '')
  const isScoped = scopedSubreddits.some(
    (value) => value.toLowerCase().replace(/[^a-z0-9]/g, '') === returned,
  )
  if (!isScoped) return null
  const market = requestedLocation.split(',')[0]?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? ''
  return market && returned.includes(market) ? requestedLocation : null
}

function activityLevel(count: number): NonNullable<CandidateIdentity['activity_level']> {
  if (count >= 25) return 'high'
  if (count >= 5) return 'medium'
  if (count > 0) return 'low'
  return 'unknown'
}

function safePlatformUrl(value: unknown, platform: SocialPlatform): string | null {
  const raw = text(value, 2_000)
  if (!raw) return null
  try {
    const url = new URL(raw.startsWith('/') && platform === 'Reddit' ? `https://www.reddit.com${raw}` : raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (platform === 'Reddit' && host !== 'reddit.com') return null
    if (platform === 'X' && host !== 'x.com' && host !== 'twitter.com') return null
    if (platform === 'Threads' && host !== 'threads.com' && host !== 'threads.net') return null
    url.protocol = 'https:'
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function sourcePublishedAt(value: unknown): string | null {
  if (value == null || (typeof value === 'string' && !value.trim())) return null
  const numeric = Number(value)
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1_000)
    : new Date(String(value ?? ''))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function commonIdentity(args: {
  name: string
  platform: SocialPlatform
  content: string
  sourceUrl: string
  requestedLocation: string | null
  locationEvidence: string
  engagement: number
  people?: CandidateIdentity['people_to_follow']
}): CandidateIdentity {
  const demonstratedIntent = classifyOpportunityIntent(args.content)
  const demonstratedLocation = demonstratedOpportunityLocation(args.locationEvidence, args.requestedLocation)
  return {
    name: args.name,
    opportunity_kind: 'thread',
    platform: args.platform,
    intent_kind: demonstratedIntent.kind,
    audience_description: args.content,
    activity_level: activityLevel(args.engagement),
    engagement_count: args.engagement,
    access_type: 'public',
    location: demonstratedLocation,
    provider_location: args.requestedLocation,
    urls: [args.sourceUrl],
    participation_rules: `Review the current ${args.platform} community and thread rules. Use only public context and do not automate contact or posting.`,
    participation_rules_status: 'unverified',
    recommended_action:
      'Read the full public conversation and contribute one useful response manually when it is relevant and permitted.',
    message_angle:
      'Answer the specific buyer or seller question with practical local information before mentioning your services.',
    people_to_follow: args.people,
  }
}

export function normalizeRedditOpportunity(value: unknown, context: NormalizeContext): Candidate | null {
  const row = record(value)
  const rowType = text(row?.type ?? row?._type, 20)?.toLowerCase()
  if (!row || (rowType !== 'post' && rowType !== 'comment')) return null
  if (row._status != null && text(row._status, 20)?.toLowerCase() !== 'found') return null
  if (
    rowType === 'post'
    && (row.isNSFW === true || row.isNsfw === true || row.isLocked === true || row.isArchived === true || row.isStickied === true)
  ) return null
  const sourceUrl = safePlatformUrl(row.permalink ?? row.url, 'Reddit')
  const postTitle = text(rowType === 'comment' ? row.postTitle : row.title, 180)
  const body = text(rowType === 'comment' ? row.body : row.selfText ?? row.body, 600)
  if (!sourceUrl || !postTitle || (rowType === 'comment' && !body)) return null
  const content = body ? `${postTitle}. ${body}` : postTitle
  if (SENSITIVE_TARGETING.test(content) || sensitiveConsumerOpportunityReasons(content).length > 0) return null
  const subreddit = text(row.subreddit, 100)
  const subredditInfo = record(row.subredditInfo)
  if (subredditInfo?.isNsfw === true || subredditInfo?.isQuarantined === true) return null
  const engagement = Math.min(
    10_000_000,
    nonNegativeInteger(row.score)
      + nonNegativeInteger(rowType === 'comment' ? row.postCommentCount : row.numComments ?? row.commentCount),
  )
  const author = text(row.author, 100)
  const memberCount = nonNegativeInteger(
    rowType === 'comment' ? row.subredditSubscribers : row.subredditSubscribers ?? subredditInfo?.subscribersCount,
  )
  // Parent-post context is useful provenance but cannot manufacture the
  // comment author's intent. Fit-v7 sees only the returned comment body.
  const semanticContent = rowType === 'comment' ? body ?? '' : content
  const identity = commonIdentity({
    name: rowType === 'comment'
      ? `Reddit comment${subreddit ? ` in r/${subreddit}` : ''}`
      : postTitle,
    platform: 'Reddit',
    content: semanticContent,
    sourceUrl,
    requestedLocation: context.location,
    locationEvidence: `${semanticContent}\n${subreddit ?? ''}`,
    engagement,
    people:
      author && author !== '[deleted]'
        ? [
            {
              name: author,
              role: subreddit ? `Public contributor in r/${subreddit}` : 'Public Reddit contributor',
              profile_url: `https://www.reddit.com/user/${encodeURIComponent(author)}`,
            },
          ]
        : undefined,
  })
  const subredditLocation = scopedSubredditLocation(
    subreddit,
    context.scopedSubreddits,
    context.location,
  )
  if (subredditLocation) identity.location = subredditLocation
  identity.member_count = memberCount || null
  // clearpath/reddit-search-scraper build 0.0.66 documents `createdAt` as the
  // source creation timestamp and exposes a provider-side 30-day search
  // filter. The actor/build pair is immutable in the approved descriptor, so
  // this value may satisfy freshness while any replacement remains untrusted.
  const publishedAt = sourcePublishedAt(row.createdAt)
  identity.source_published_at = publishedAt
  const demonstratedIntent = classifyOpportunityIntent(semanticContent)
  return {
    entity_kind: 'opportunity',
    identity,
    evidence: [
      {
        claim:
          engagement > 0
            ? `The approved public source returned this Reddit ${rowType} with ${engagement} visible score and discussion signals.`
            : `The approved public source returned this Reddit ${rowType}.`,
        source_url: sourceUrl,
        observed_at: context.attemptedAt,
        confidence: calibratedOpportunityConfidence({
          content: semanticContent,
          sourceUrl,
          observedAt: publishedAt ?? '',
          attemptedAt: context.attemptedAt,
          engagement,
          location: identity.location ?? null,
        }),
        detail: {
          provider: 'apify',
          actor_id: context.actorId,
          provider_post_id: text(rowType === 'comment' ? row.postId : row.id, 200),
          provider_comment_id: rowType === 'comment' ? text(row.id, 200) : null,
          parent_id: rowType === 'comment' ? text(row.parentId, 200) : null,
          parent_post_title: rowType === 'comment' ? postTitle : null,
          source_content_type: rowType,
          subreddit,
          location_basis: subredditLocation ? 'scoped_returned_subreddit' : null,
          requested_location: context.location,
          requested_intent: context.expectedIntent ?? null,
          source_published_at: publishedAt,
          publication_time_evidence: publishedAt ? 'pinned_actor_source_timestamp' : 'missing',
          visible_engagement: engagement,
          demonstrated_intent_signals: [
            ...demonstratedIntent.buyerSignals,
            ...demonstratedIntent.sellerSignals,
            ...demonstratedIntent.localAudienceSignals,
          ],
        },
      },
    ],
  }
}

export function normalizeXOpportunity(value: unknown, context: NormalizeContext): Candidate | null {
  const row = record(value)
  if (!row) return null
  const sourceUrl = safePlatformUrl(row.postUrl, 'X')
  const content = text(row.postText, 800)
  if (
    !sourceUrl
    || !content
    || SENSITIVE_TARGETING.test(content)
    || sensitiveConsumerOpportunityReasons(content).length > 0
  ) return null
  const engagement = Math.min(
    10_000_000,
    nonNegativeInteger(row.replyCount) +
      nonNegativeInteger(row.quoteCount) +
      nonNegativeInteger(row.repostCount) +
      nonNegativeInteger(row.favouriteCount),
  )
  const author = record(row.author)
  const screenName = text(author?.screenName, 100)
  const name = text(author?.name, 120)
  const identity = commonIdentity({
    name: content.length > 110 ? `${content.slice(0, 107).trimEnd()}...` : content,
    platform: 'X',
    content,
    sourceUrl,
    requestedLocation: context.location,
    locationEvidence: `${content}\n${text(author?.description, 180) ?? ''}`,
    engagement,
    people:
      name || screenName
        ? [
            {
              name: name ?? screenName ?? 'Public X contributor',
              role: text(author?.description, 180),
              profile_url: screenName ? `https://x.com/${encodeURIComponent(screenName)}` : null,
            },
          ]
        : undefined,
  })
  identity.opportunity_kind = 'post'
  const publishedAt = sourcePublishedAt(row.timestamp)
  identity.source_published_at = publishedAt
  const demonstratedIntent = classifyOpportunityIntent(content)
  return {
    entity_kind: 'opportunity',
    identity,
    evidence: [
      {
        claim:
          engagement > 0
            ? `The approved public source returned this X post with ${engagement} visible interactions.`
            : 'The approved public source returned this X post.',
        source_url: sourceUrl,
        observed_at: context.attemptedAt,
        confidence: calibratedOpportunityConfidence({
          content,
          sourceUrl,
          observedAt: publishedAt ?? '',
          attemptedAt: context.attemptedAt,
          engagement,
          location: identity.location ?? null,
        }),
        detail: {
          provider: 'apify',
          actor_id: context.actorId,
          provider_post_id: text(row.postId, 200),
          requested_location: context.location,
          requested_intent: context.expectedIntent ?? null,
          source_published_at: publishedAt,
          visible_engagement: engagement,
          demonstrated_intent_signals: [
            ...demonstratedIntent.buyerSignals,
            ...demonstratedIntent.sellerSignals,
            ...demonstratedIntent.localAudienceSignals,
          ],
        },
      },
    ],
  }
}

export function normalizeThreadsOpportunity(value: unknown, context: NormalizeContext): Candidate | null {
  const row = record(value)
  if (!row) return null
  const legacyType = text(row.type, 30)?.toLowerCase()
  const postId = text(row.post_id ?? row.postId, 200)
  const sourceUrl = safePlatformUrl(row.post_url ?? row.url, 'Threads')
  if ((legacyType && legacyType !== 'post') || row.is_private === true || row.isPrivate === true) return null
  if (!postId || !sourceUrl) return null
  const content = text(row.text, 800)
  if (
    !sourceUrl
    || !content
    || SENSITIVE_TARGETING.test(content)
    || sensitiveConsumerOpportunityReasons(content).length > 0
  ) return null
  const engagement = Math.min(
    10_000_000,
    nonNegativeInteger(row.like_count ?? row.likeCount) +
      nonNegativeInteger(row.reply_count ?? row.replyCount) +
      nonNegativeInteger(row.repost_count ?? row.repostCount) +
      nonNegativeInteger(row.quote_count ?? row.quoteCount) +
      nonNegativeInteger(row.reshare_count),
  )
  const username = text(row.username, 100)?.replace(/^@/, '') ?? null
  const fullName = text(row.full_name ?? row.fullName, 120)
  const profileUrl = username
    ? safePlatformUrl(`https://www.threads.com/@${encodeURIComponent(username)}`, 'Threads')
    : null
  const identity = commonIdentity({
    name: content.length > 110 ? `${content.slice(0, 107).trimEnd()}...` : content,
    platform: 'Threads',
    content,
    sourceUrl,
    requestedLocation: context.location,
    locationEvidence: content,
    engagement,
    people:
      fullName || username
        ? [
            {
              name: fullName ?? username ?? 'Public Threads contributor',
              role: 'Public Threads contributor shown as secondary source context',
              profile_url: profileUrl,
            },
          ]
        : undefined,
  })
  identity.opportunity_kind = 'post'
  const publishedAt = sourcePublishedAt(row.taken_at ?? row.date)
  identity.source_published_at = publishedAt
  const demonstratedIntent = classifyOpportunityIntent(content)
  return {
    entity_kind: 'opportunity',
    identity,
    evidence: [
      {
        claim:
          engagement > 0
            ? `The approved public source returned this Threads post with ${engagement} visible interactions.`
            : 'The approved public source returned this Threads post.',
        source_url: sourceUrl,
        observed_at: context.attemptedAt,
        confidence: calibratedOpportunityConfidence({
          content,
          sourceUrl,
          observedAt: publishedAt ?? '',
          attemptedAt: context.attemptedAt,
          engagement,
          location: identity.location ?? null,
        }),
        detail: {
          provider: 'apify',
          actor_id: context.actorId,
          provider_post_id: postId,
          requested_location: context.location,
          requested_intent: context.expectedIntent ?? null,
          source_published_at: publishedAt,
          visible_engagement: engagement,
          demonstrated_intent_signals: [
            ...demonstratedIntent.buyerSignals,
            ...demonstratedIntent.sellerSignals,
            ...demonstratedIntent.localAudienceSignals,
          ],
        },
      },
    ],
  }
}

function providerUnitsFor(config: PublicSocialOpportunityConfig, maxResults: number): number {
  const estimatedUsd = config.oneTimeQuoteUsd + maxResults * config.perItemQuoteUsd
  return Math.max(APIFY_MIN_CHARGE_USD, estimatedUsd) / APIFY_MILLIDOLLAR_USD
}

function datasetCeiling(config: PublicSocialOpportunityConfig, maxChargeUsd: number): number {
  const available = Math.max(0, maxChargeUsd - config.oneTimeQuoteUsd)
  return Math.max(1, Math.min(100, Math.floor((available + 1e-9) / config.perItemQuoteUsd)))
}

function receipt(
  config: PublicSocialOpportunityConfig,
  outcome: ApifyRunOutcome,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    actor_id: outcome.actorId,
    run_id: outcome.runId,
    actor_build: config.actorBuild,
    item_count: outcome.itemCount,
    provider_status: outcome.kind,
    http_status: outcome.httpStatus,
    request_url: outcome.requestUrl,
    attempted_at: outcome.attemptedAt,
    billing_finalized: outcome.billingFinalized ?? false,
    charged_event_counts: outcome.chargedEventCounts ?? null,
    provider_cost_usd: outcome.providerCostUsd ?? null,
    pricing_model: outcome.pricingModel ?? null,
    ...extras,
  }
}

function refusal(
  config: PublicSocialOpportunityConfig,
  actorId: string,
  attemptedAt: string,
  error: string,
): AdapterResult<Candidate[]> {
  return {
    status: 'error',
    data: null,
    receipt: {
      actor_id: actorId,
      run_id: null,
      actor_build: config.actorBuild,
      item_count: 0,
      charged_event_counts: null,
      provider_status: 'disabled',
      attempted_at: attemptedAt,
      billing_finalized: false,
      provider_cost_usd: null,
      pricing_model: null,
    },
    cost_units: 0,
    error,
  }
}

export function createPublicSocialOpportunityAdapter(
  config: PublicSocialOpportunityConfig,
  deps: PublicSocialDeps = {},
): SourceAdapter {
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => new Date())
  const descriptor = publicSocialOpportunityDescriptor(config, env)
  const billingContract: ApifyFinalizedBillingContract = {
    pricingModel: 'PAY_PER_EVENT',
    eventPricesUsd: config.eventPricesUsd,
  }
  const runActor: RunActor =
    deps.runActor ??
    ((actorId, input, options) =>
      runActorWithFinalizedBilling(actorId, input, {
        ...options,
        fetchImpl: deps.fetchImpl,
        billingContract,
        finalizationDelayMs: deps.finalizationDelayMs,
        sleep: deps.sleep,
      }))

  return {
    descriptor,
    quote(plan) {
      const maxCandidates = Math.max(0, Math.min(Math.floor(plan.max_candidates), MAX_RESULTS))
      const providerUnits = maxCandidates > 0 ? providerUnitsFor(config, maxCandidates) : 0
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
    async search(plan) {
      const attemptedAt = now().toISOString()
      const actorId = configuredActor(config, env)
      const coverage = capabilityCovers(descriptor, plan)
      if (!coverage.covered) {
        return refusal(config, actorId, attemptedAt, `unsupported_capability: ${coverage.reason ?? 'not covered'}`)
      }
      if (actorId !== config.actorId) {
        return refusal(config, actorId, attemptedAt, 'provider_disabled: public social actor override is unapproved')
      }
      if (!apifyEnabled(env)) {
        return refusal(config, actorId, attemptedAt, `provider_disabled: ${APIFY_ENABLED_ENV} is not 'true'`)
      }
      const token = apifyToken(env)
      if (!token) {
        return refusal(
          config,
          actorId,
          attemptedAt,
          `provider_unconfigured: no Apify token configured (${APIFY_TOKEN_ENVS.join(' or ')})`,
        )
      }
      if (!publicSocialOpportunityApproved(config, env)) {
        return refusal(
          config,
          actorId,
          attemptedAt,
          'provider_disabled: public social terms, use, actor, or price version is unapproved',
        )
      }
      const maxCandidates = Math.max(0, Math.min(Math.floor(plan.max_candidates), MAX_RESULTS))
      if (maxCandidates <= 0) {
        return refusal(config, actorId, attemptedAt, 'bad_request: a positive opportunity cap is required')
      }
      const maxChargeUsd = Number(plan.max_charge_usd)
      if (!Number.isFinite(maxChargeUsd) || maxChargeUsd < APIFY_MIN_CHARGE_USD) {
        return refusal(config, actorId, attemptedAt, 'bad_request: a reservation-derived max charge is required')
      }
      let input: Record<string, unknown>
      let query: string
      try {
        query = queryText(plan, config.platform === 'X' || config.platform === 'Threads' ? 100 : 700)
        input = config.buildInput(plan, maxCandidates, attemptedAt)
      } catch (error) {
        return refusal(
          config,
          actorId,
          attemptedAt,
          `bad_request: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const outcome = await runActor(actorId, input, {
        token,
        build: config.actorBuild,
        timeoutMs: timeoutMs(env),
        maxItems: datasetCeiling(config, maxChargeUsd),
        maxChargeUsd,
        datasetFields: [...config.datasetFields],
        maxDatasetBodyBytes: MAX_DATASET_BODY_BYTES,
        now,
      })
      const providerReceipt = (extras: Record<string, unknown> = {}) =>
        receipt(config, outcome, {
          max_charge_usd: maxChargeUsd,
          max_opportunities: maxCandidates,
          query,
          platform: config.platform,
          ...extras,
        })
      if (outcome.status === 'ambiguous') {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt(),
          cost_units: null,
          error: outcome.error ?? 'ambiguous provider outcome',
        }
      }
      if (outcome.status === 'error') {
        const finalizedCostUnits =
          outcome.billingFinalized && outcome.providerCostUsd != null
            ? outcome.providerCostUsd / APIFY_MILLIDOLLAR_USD
            : 0
        return {
          status: 'error',
          data: null,
          receipt: providerReceipt(),
          cost_units: finalizedCostUnits,
          error: outcome.error ?? 'provider error',
        }
      }
      if (!outcome.billingFinalized || outcome.providerCostUsd == null) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt(),
          cost_units: null,
          error: 'provider_billing_unknown: public social receipt was not finalized',
        }
      }
      const counts = outcome.chargedEventCounts ?? {}
      const unexpected = Object.entries(counts).find(([event, count]) => count > 0 && !(event in config.eventPricesUsd))
      if (unexpected) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({ unexpected_charge_event: unexpected[0] }),
          cost_units: null,
          error: 'provider_billing_unknown: an unapproved public social event was charged',
        }
      }
      const unexpectedKnownResult = Object.entries(counts).find(
        ([event, count]) =>
          count > 0
          && event !== config.primaryResultEvent
          && (config.oneTimeEvent == null || event !== config.oneTimeEvent)
          && !(config.auxiliaryResultEvents ?? []).includes(event),
      )
      if (unexpectedKnownResult) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({ unexpected_charge_event: unexpectedKnownResult[0] }),
          cost_units: null,
          error: 'provider_billing_unknown: an unrequested public social result event was charged',
        }
      }
      const costUnits = outcome.providerCostUsd / APIFY_MILLIDOLLAR_USD
      if (config.oneTimeEvent != null && (counts[config.oneTimeEvent] ?? 0) !== 1) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({ billed_run_starts: counts[config.oneTimeEvent] ?? 0 }),
          cost_units: null,
          error: 'provider_billing_unknown: run-start charge did not match the approved contract',
        }
      }
      if (outcome.status === 'no_result') {
        return {
          status: 'no_result',
          data: null,
          receipt: providerReceipt(),
          cost_units: costUnits,
        }
      }
      const diagnosticRows = config.isNoResultDiagnostic
        ? outcome.items.filter((item) => config.isNoResultDiagnostic?.(item))
        : []
      const resultItems = outcome.items.filter((item) => !config.isNoResultDiagnostic?.(item))
      if (diagnosticRows.length > 0 && resultItems.length > 0) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({ diagnostic_rows: diagnosticRows.length }),
          cost_units: null,
          error: 'invalid_schema: provider mixed result rows with a zero-result diagnostic',
        }
      }
      if ((counts[config.primaryResultEvent] ?? 0) !== resultItems.length) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({
            billed_results: counts[config.primaryResultEvent] ?? 0,
          }),
          cost_units: null,
          error: 'invalid_schema: billed result count did not match the bounded dataset',
        }
      }
      for (const event of config.auxiliaryResultEvents ?? []) {
        if ((counts[event] ?? 0) !== resultItems.length) {
          return {
            status: 'ambiguous',
            data: null,
            receipt: providerReceipt({
              billed_auxiliary_results: counts[event] ?? 0,
              auxiliary_result_event: event,
            }),
            cost_units: null,
            error: 'invalid_schema: auxiliary billed result count did not match the bounded dataset',
          }
        }
      }
      if (
        diagnosticRows.length > 0
        && resultItems.length === 0
        && diagnosticRows.length === outcome.items.length
      ) {
        return {
          status: 'no_result',
          data: null,
          receipt: providerReceipt({
            diagnostic_rows: diagnosticRows.length,
            billed_results: 0,
          }),
          cost_units: costUnits,
        }
      }
      const context = {
        query,
        location: locationText(plan),
        expectedIntent: requestedOpportunityIntent(plan),
        scopedSubreddits:
          config.platform === 'Reddit' ? redditSubreddits(plan) : undefined,
        attemptedAt: outcome.attemptedAt,
        actorId,
      }
      const normalizedCandidates = resultItems
        .map((item) => config.normalize(item, context))
        .filter((candidate): candidate is Candidate => candidate != null)
      const candidates = config.platform === 'Reddit'
        ? normalizedCandidates.filter((candidate) => returnedContentMatchesRedditFilter(candidate, plan))
        : normalizedCandidates
      if (candidates.length === 0) {
        const returnedContentFiltered = config.platform === 'Reddit' ? normalizedCandidates.length : 0
        const semanticFilter =
          plan.provider_query?.reddit_returned_content_filter_version === 'semantic-intent-location-v1'
        return {
          status: normalizedCandidates.length > 0 ? 'no_result' : 'error',
          data: null,
          receipt: providerReceipt({
            parser_dropped_rows: outcome.itemCount - normalizedCandidates.length,
            ...(semanticFilter
              ? {
                  returned_content_filter_version: 'semantic-intent-location-v1',
                  returned_content_filtered_rows: returnedContentFiltered,
                }
              : { keyword_filtered_rows: returnedContentFiltered }),
          }),
          cost_units: costUnits,
          error: normalizedCandidates.length > 0
            ? 'no_result_after_returned_content_filter'
            : 'invalid_schema: provider rows contained no safe public opportunity',
        }
      }
      const delivered = candidates.slice(0, maxCandidates)
      const parserDropped = Math.max(0, resultItems.length - normalizedCandidates.length)
      const returnedContentFiltered = Math.max(0, normalizedCandidates.length - candidates.length)
      const semanticFilter =
        plan.provider_query?.reddit_returned_content_filter_version === 'semantic-intent-location-v1'
      const dropped = parserDropped + returnedContentFiltered
      const truncated = candidates.length > delivered.length
      return {
        status: dropped > 0 || truncated ? 'partial' : 'ok',
        data: delivered,
        receipt: providerReceipt({
          returned_count: delivered.length,
          parser_dropped_rows: parserDropped,
          ...(semanticFilter
            ? {
                returned_content_filter_version: 'semantic-intent-location-v1',
                returned_content_filtered_rows: returnedContentFiltered,
              }
            : { keyword_filtered_rows: returnedContentFiltered }),
          truncated,
          billed_results: counts[config.primaryResultEvent] ?? 0,
        }),
        cost_units: costUnits,
      }
    },
  }
}

export function createApifyRedditOpportunityAdapter(deps: PublicSocialDeps = {}): SourceAdapter {
  return createPublicSocialOpportunityAdapter(APIFY_REDDIT_OPPORTUNITY_CONFIG, deps)
}

export function createApifyXOpportunityAdapter(deps: PublicSocialDeps = {}): SourceAdapter {
  return createPublicSocialOpportunityAdapter(APIFY_X_OPPORTUNITY_CONFIG, deps)
}

export function createApifyThreadsOpportunityAdapter(deps: PublicSocialDeps = {}): SourceAdapter {
  return createPublicSocialOpportunityAdapter(APIFY_THREADS_OPPORTUNITY_CONFIG, deps)
}

export function apifyRedditOpportunityEnabled(env: SocialEnv = process.env): boolean {
  return publicSocialOpportunityEnabled(APIFY_REDDIT_OPPORTUNITY_CONFIG, env)
}

export function apifyXOpportunityEnabled(env: SocialEnv = process.env): boolean {
  return publicSocialOpportunityEnabled(APIFY_X_OPPORTUNITY_CONFIG, env)
}

export function apifyThreadsOpportunityEnabled(env: SocialEnv = process.env): boolean {
  return publicSocialOpportunityEnabled(APIFY_THREADS_OPPORTUNITY_CONFIG, env)
}
