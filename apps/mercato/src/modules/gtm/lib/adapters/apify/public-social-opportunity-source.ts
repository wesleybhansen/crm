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
  classifyOpportunityIntentV1,
  classifyOpportunityIntentV2,
  demonstratedOpportunityLocation,
  assessRealtorOpportunitySuitability,
  type DemonstratedOpportunityIntent,
  sensitiveConsumerOpportunityReasons,
} from '../../research/opportunity-quality'

const APIFY_MILLIDOLLAR_USD = 0.001
const MAX_RESULTS = 25
const MAX_DATASET_BODY_BYTES = 2_000_000
const SENSITIVE_TARGETING =
  /\b(?:bereav(?:ed|ement)|widow(?:ed|er)?|probate|divorc(?:e|ed|ing)|foreclos(?:e|ed|ure)|bankrupt(?:cy)?|tax delinquen(?:t|cy)|mortgage payoff|disab(?:led|ility)|medical|health condition|pregnan(?:t|cy)|family status|retire(?:d|ment)|elderly|senior citizen)\b/i

type SocialEnv = Record<string, string | undefined>
type SocialPlatform = 'Reddit' | 'X' | 'Threads' | 'Meetup' | 'Instagram' | 'TikTok'

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
  partitionedResultEvents?: readonly string[]
  partitionedResultEvent?(value: unknown): string | null
  perItemQuoteUsd: number
  oneTimeQuoteUsd: number
  minimumMaxChargeUsd?: number
  minimumBatch?: number
  maxBatch?: number
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
  semanticFilterVersion?: string
}

type SemanticRedditFilterVersion =
  | 'semantic-intent-location-v1'
  | 'semantic-intent-location-v2'
  | 'semantic-intent-location-v3'

function isSemanticRedditFilterVersion(value: unknown): value is SemanticRedditFilterVersion {
  return value === 'semantic-intent-location-v1'
    || value === 'semantic-intent-location-v2'
    || value === 'semantic-intent-location-v3'
}

type MeetupReturnedContentFilterVersion = 'realtor-housing-event-v1'

function isMeetupReturnedContentFilterVersion(
  value: unknown,
): value is MeetupReturnedContentFilterVersion {
  return value === 'realtor-housing-event-v1'
}

type SocialReturnedContentFilterVersion = 'realtor-public-post-v2'

function isSocialReturnedContentFilterVersion(
  value: unknown,
): value is SocialReturnedContentFilterVersion {
  return value === 'realtor-public-post-v2'
}

function validateSocialReturnedContentFilter(plan: SourceSearchPlan): void {
  if (plan.provider_query?.social_public_post_contract_version !== 'public-posts-v1') {
    throw new TypeError('public-post sourcing requires the frozen input contract')
  }
  if (!isSocialReturnedContentFilterVersion(
    plan.provider_query?.social_returned_content_filter_version,
  )) {
    throw new TypeError('public-post sourcing requires the frozen returned-content filter')
  }
  const intent = plan.provider_query?.social_filter_required_intent
  if (!['buyer_intent', 'seller_intent', 'mixed_intent', 'local_audience'].includes(String(intent))) {
    throw new TypeError('public-post sourcing requires a supported intent lane')
  }
  if (plan.provider_query?.social_filter_require_location !== true) {
    throw new TypeError('public-post sourcing requires returned-content location evidence')
  }
  if (plan.provider_query?.social_window_days !== 30) {
    throw new TypeError('public-post sourcing requires the frozen 30-day window')
  }
}

function classifyRedditOpportunityIntent(
  content: string,
  version: string | undefined,
) {
  if (version === 'semantic-intent-location-v1') return classifyOpportunityIntentV1(content)
  if (version === 'semantic-intent-location-v2') return classifyOpportunityIntentV2(content)
  return classifyOpportunityIntent(content)
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

function validateRedditReturnedContentFilter(plan: SourceSearchPlan): void {
  const version = plan.provider_query?.reddit_returned_content_filter_version
  if (version == null) return
  if (!isSemanticRedditFilterVersion(version)) {
    throw new TypeError('unsupported Reddit returned-content filter version')
  }
  const intent = plan.provider_query?.reddit_filter_required_intent
  if (!['buyer_intent', 'seller_intent', 'mixed_intent', 'local_audience'].includes(String(intent))) {
    throw new TypeError('semantic Reddit returned-content filtering requires a supported intent lane')
  }
  if (typeof plan.provider_query?.reddit_filter_require_location !== 'boolean') {
    throw new TypeError('semantic Reddit returned-content filtering requires an explicit location policy')
  }
}

function returnedContentMatchesRedditFilter(candidate: Candidate, plan: SourceSearchPlan): boolean {
  const filterVersion = plan.provider_query?.reddit_returned_content_filter_version
  if (isSemanticRedditFilterVersion(filterVersion)) {
    const content = [candidate.identity.name, candidate.identity.audience_description]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
    const expected = plan.provider_query?.reddit_filter_required_intent
    const observed = classifyRedditOpportunityIntent(content, filterVersion).kind
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

function returnedContentMatchesMeetupFilter(candidate: Candidate, plan: SourceSearchPlan): boolean {
  if (!isMeetupReturnedContentFilterVersion(
    plan.provider_query?.meetup_returned_content_filter_version,
  )) return false
  const content = [candidate.identity.name, candidate.identity.audience_description]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
  const sourceUrl = candidate.identity.urls?.find((value) => typeof value === 'string') ?? null
  return assessRealtorOpportunitySuitability(
    content,
    'local_audience',
    sourceUrl,
    'event',
  ).relevant
}

type ReturnedContentAssessment = {
  matches: boolean
  reasons: string[]
}

function assessReturnedContentSocialFilter(
  candidate: Candidate,
  plan: SourceSearchPlan,
): ReturnedContentAssessment {
  if (!isSocialReturnedContentFilterVersion(
    plan.provider_query?.social_returned_content_filter_version,
  )) return { matches: false, reasons: ['unsupported_returned_content_filter'] }
  const expected = plan.provider_query?.social_filter_required_intent
  if (
    expected !== 'buyer_intent'
    && expected !== 'seller_intent'
    && expected !== 'mixed_intent'
    && expected !== 'local_audience'
  ) return { matches: false, reasons: ['unsupported_intent_lane'] }
  const content = [candidate.identity.name, candidate.identity.audience_description]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
  const requestedLocation = locationText(plan)
  const locationMatches = Boolean(
    requestedLocation
    && (
      candidate.identity.location === requestedLocation
      || demonstratedOpportunityLocation(content, requestedLocation)
    ),
  )
  if (!locationMatches) return { matches: false, reasons: ['missing_returned_location_evidence'] }
  const sourceUrl = candidate.identity.urls?.find((value) => typeof value === 'string') ?? null
  const suitability = assessRealtorOpportunitySuitability(
    content,
    expected,
    sourceUrl,
    'post',
  )
  return {
    matches: suitability.relevant,
    reasons: suitability.relevant ? [] : suitability.reasons,
  }
}

function returnedContentFilterVersion(
  platform: SocialPlatform,
  plan: SourceSearchPlan,
): string | undefined {
  const value = platform === 'Meetup'
    ? plan.provider_query?.meetup_returned_content_filter_version
    : platform === 'Instagram' || platform === 'TikTok'
      ? plan.provider_query?.social_returned_content_filter_version
      : plan.provider_query?.reddit_returned_content_filter_version
  return typeof value === 'string' ? value : undefined
}

function assessReturnedContent(
  platform: SocialPlatform,
  candidate: Candidate,
  plan: SourceSearchPlan,
): ReturnedContentAssessment {
  if (platform === 'Reddit') {
    const matches = returnedContentMatchesRedditFilter(candidate, plan)
    return { matches, reasons: matches ? [] : ['returned_content_semantic_mismatch'] }
  }
  if (platform === 'Meetup') {
    const matches = returnedContentMatchesMeetupFilter(candidate, plan)
    return { matches, reasons: matches ? [] : ['returned_content_semantic_mismatch'] }
  }
  if (platform === 'Instagram' || platform === 'TikTok') {
    return assessReturnedContentSocialFilter(candidate, plan)
  }
  return { matches: true, reasons: [] }
}

function returnedContentReasonCounts(
  assessments: Array<{ assessment: ReturnedContentAssessment }>,
): Record<string, number> {
  const counts = new Map<string, number>()
  for (const { assessment } of assessments) {
    if (assessment.matches) continue
    for (const reason of assessment.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)))
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
    validateRedditReturnedContentFilter(plan)
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

export const APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG: PublicSocialOpportunityConfig = {
  adapterId: 'apify-reddit-thread-demand-opportunities',
  platform: 'Reddit',
  enabledEnv: 'GTM_APIFY_REDDIT_THREAD_OPPORTUNITY_ENABLED',
  actorId: 'clearpath/reddit-post-comments-bulk-scraper',
  actorBuild: '0.0.60',
  actorEnv: 'GTM_APIFY_ACTOR_REDDIT_THREAD_SEARCH',
  useApprovalEnv: 'GTM_APIFY_REDDIT_THREAD_OPPORTUNITY_USE_APPROVED',
  priceVersionEnv: 'GTM_APIFY_REDDIT_THREAD_SEARCH_PRICE_VERSION',
  // Rechecked against the public Starter/Bronze contract on 2026-08-30.
  // The actor bills a dataset item plus exactly one post/comment event for
  // every returned row. A post is the most expensive possible row, so the
  // quote reserves that price for every slot and reconciles the cheaper
  // comment mix only after finalized provider event counts arrive.
  requiredPriceVersion: 'clearpath-reddit-post-comments-0.0.60-starter-events-2026-08-30',
  eventPricesUsd: {
    'apify-actor-start': 0.0005,
    'apify-default-dataset-item': 0.00001,
    'post-scraped': 0.00299,
    'comment-scraped': 0.00099,
  },
  oneTimeEvent: 'apify-actor-start',
  primaryResultEvent: 'apify-default-dataset-item',
  partitionedResultEvents: ['post-scraped', 'comment-scraped'],
  partitionedResultEvent(value) {
    const row = record(value)
    const rowType = text(row?.type ?? row?._type, 20)?.toLowerCase()
    if (rowType === 'post') return 'post-scraped'
    if (rowType === 'comment') return 'comment-scraped'
    return null
  },
  perItemQuoteUsd: 0.003,
  oneTimeQuoteUsd: 0.0005,
  minimumBatch: 2,
  maxBatch: 10,
  datasetFields: [
    '_type',
    '_status',
    '_post_id',
    'type',
    'id',
    'title',
    'selfText',
    'selftext',
    'body',
    'author',
    'subreddit',
    'score',
    'numComments',
    'num_comments',
    'commentCount',
    'createdAt',
    'created_utc',
    'permalink',
    'url',
    'isNSFW',
    'isNsfw',
    'isLocked',
    'isArchived',
    'isStickied',
    'over_18',
    'stickied',
    'locked',
    'archived',
    'isDeleted',
    'isRemoved',
    'isCommercialCommunication',
    'subredditInfo',
    'subredditSubscribers',
    'subreddit_subscribers',
    'postId',
    'postTitle',
    'postUrl',
    'postCommentCount',
    'parentId',
  ],
  buildInput(plan, maxResults) {
    validateRedditReturnedContentFilter(plan)
    if (plan.provider_query?.reddit_thread_contract_version !== 'public-post-comments-v2') {
      throw new TypeError('Reddit thread sourcing requires the frozen post-and-comment contract')
    }
    if (maxResults > 10) {
      throw new TypeError('Reddit thread sourcing is limited to 10 rows per quoted lane')
    }
    if (requestedOpportunityIntent(plan) === 'local_audience') {
      throw new TypeError('Reddit thread sourcing is limited to buyer, seller, and mixed-intent lanes')
    }
    if (plan.provider_query?.reddit_filter_require_location !== false) {
      throw new TypeError('Reddit thread sourcing requires a returned frozen-subreddit location contract')
    }
    const subreddits = redditSubreddits(plan)
    if (subreddits.length !== 1 || redditAutoDiscover(plan) || redditGlobalSearch(plan)) {
      throw new TypeError('Reddit thread sourcing requires exactly one frozen public subreddit')
    }
    const query = queryText(plan, 500)
    if (/\bsubreddit\s*:/i.test(query)) {
      throw new TypeError('Reddit thread query scope must be supplied by the frozen subreddit field')
    }
    return {
      queries: [`${query} subreddit:${subreddits[0]}`],
      maxPostsPerQuery: Math.max(1, Math.min(5, Math.floor(maxResults / 2))),
      sort: 'new',
      maxCommentsPerPost: 1,
      expandAllComments: false,
    }
  },
  normalize: normalizeRedditOpportunity,
}

export const APIFY_REDDIT_FRESH_OPPORTUNITY_CONFIG: PublicSocialOpportunityConfig = {
  adapterId: 'apify-reddit-fresh-demand-opportunities',
  platform: 'Reddit',
  enabledEnv: 'GTM_APIFY_REDDIT_FRESH_OPPORTUNITY_ENABLED',
  actorId: 'solidcode/reddit-scraper',
  actorBuild: '1.1.36',
  actorEnv: 'GTM_APIFY_ACTOR_REDDIT_FRESH_SEARCH',
  useApprovalEnv: 'GTM_APIFY_REDDIT_FRESH_OPPORTUNITY_USE_APPROVED',
  priceVersionEnv: 'GTM_APIFY_REDDIT_FRESH_SEARCH_PRICE_VERSION',
  // Rechecked against the production Starter/BRONZE account and the actor's
  // public PAY_PER_EVENT metadata on 2026-08-30. Every run charges one start
  // plus one dataset-result event per returned row. The actor applies the
  // frozen postDateLimit before writing rows, so stale results do not consume
  // the bounded paid candidate pool.
  requiredPriceVersion: 'solidcode-reddit-scraper-1.1.36-bronze-events-2026-08-30',
  eventPricesUsd: {
    'apify-actor-start': 0.01,
    'apify-default-dataset-item': 0.0022,
  },
  oneTimeEvent: 'apify-actor-start',
  primaryResultEvent: 'apify-default-dataset-item',
  perItemQuoteUsd: 0.0022,
  oneTimeQuoteUsd: 0.01,
  maxBatch: 10,
  datasetFields: [
    'recordType',
    'id',
    'fullId',
    'url',
    'permalink',
    'createdAt',
    'scrapedAt',
    'sourceQuery',
    'title',
    'text',
    'subreddit',
    'author',
    'score',
    'upvoteRatio',
    'numComments',
    'flair',
    'isNsfw',
    'isSpoiler',
    'isStickied',
    'isLocked',
  ],
  buildInput(plan, maxResults) {
    validateRedditReturnedContentFilter(plan)
    if (plan.provider_query?.reddit_fresh_contract_version !== 'public-post-search-v2') {
      throw new TypeError('fresh Reddit sourcing requires the frozen public-post search contract')
    }
    if (plan.provider_query?.reddit_search_syntax_version !== 'field-qualified-conjunctive-v2') {
      throw new TypeError('fresh Reddit sourcing requires the frozen field-qualified search syntax')
    }
    if (maxResults > 10) {
      throw new TypeError('fresh Reddit sourcing is limited to 10 rows per quoted lane')
    }
    if (requestedOpportunityIntent(plan) === 'local_audience') {
      throw new TypeError('fresh Reddit sourcing is limited to buyer, seller, and mixed-intent lanes')
    }
    if (plan.provider_query?.reddit_fresh_window_days !== 30) {
      throw new TypeError('fresh Reddit sourcing requires the frozen 30-day post window')
    }
    const subreddits = redditSubreddits(plan)
    if (subreddits.length !== 1 || redditAutoDiscover(plan) || redditGlobalSearch(plan)) {
      throw new TypeError('fresh Reddit sourcing requires exactly one frozen public subreddit')
    }
    const query = queryText(plan, 500)
    const quotedValues = query.match(/"[^"\r\n]+"/g) ?? []
    const structuralRemainder = query
      .replace(/"[^"\r\n]+"/g, '""')
      .replace(/\b(?:title|selftext):""/gi, '')
      .replace(/\b(?:AND|OR)\b/g, '')
      .replace(/[()\s]/g, '')
    if (
      quotedValues.length < 2
      || !/\btitle:"[^"\r\n]+"/i.test(query)
      || !/\bselftext:"[^"\r\n]+"/i.test(query)
      || !/\b(?:title|selftext):"[^"\r\n]*\s+[^"\r\n]*"/i.test(query)
      || structuralRemainder
    ) {
      throw new TypeError('fresh Reddit sourcing accepts only exact title/selftext field clauses joined by uppercase AND/OR')
    }
    return {
      searches: [query],
      searchCommunityName: subreddits[0],
      searchPosts: true,
      searchComments: false,
      searchCommunities: false,
      searchUsers: false,
      sort: 'new',
      time: 'month',
      postDateLimit: '30 days',
      includeNSFW: false,
      skipComments: true,
      skipCommunityInfo: true,
      maxItems: maxResults,
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

export const APIFY_MEETUP_OPPORTUNITY_CONFIG: PublicSocialOpportunityConfig = {
  adapterId: 'apify-meetup-demand-opportunities',
  platform: 'Meetup',
  enabledEnv: 'GTM_APIFY_MEETUP_OPPORTUNITY_ENABLED',
  actorId: 'filip_cicvarek/meetup-scraper',
  actorBuild: '3.0.14',
  actorEnv: 'GTM_APIFY_ACTOR_MEETUP_SEARCH',
  useApprovalEnv: 'GTM_APIFY_MEETUP_OPPORTUNITY_USE_APPROVED',
  priceVersionEnv: 'GTM_APIFY_MEETUP_SEARCH_PRICE_VERSION',
  // Rechecked against the signed-in Starter account on 2026-08-30. The
  // established actor prices BRONZE at $0.0008 per returned event with
  // platform usage included. There is no separate run-start event.
  requiredPriceVersion: 'filip-cicvarek-meetup-scraper-3.0.14-bronze-events-2026-08-30',
  eventPricesUsd: { 'apify-default-dataset-item': 0.0008 },
  oneTimeEvent: null,
  primaryResultEvent: 'apify-default-dataset-item',
  perItemQuoteUsd: 0.0008,
  oneTimeQuoteUsd: 0,
  maxBatch: 10,
  datasetFields: [
    'eventId',
    'eventName',
    'eventDescription',
    'eventType',
    'date',
    'address',
    'eventUrl',
    'organizedByGroup',
    'maxAttendees',
    'actualAttendees',
    'isPaidEvent',
    'feeAmount',
    'feeCurrency',
    'feeRequired',
    'eventShortUrl',
    'eventStatus',
    'isOnline',
    'startDateTime',
    'endDateTime',
    'durationISO',
    'timezone',
    'createdTime',
    'featuredPhotoUrl',
    'ratingAverage',
    'ratingCount',
    'reviewCount',
    'venue',
    'group',
    'hosts',
    'topics',
    'series',
  ],
  buildInput: buildMeetupInput,
  normalize: normalizeMeetupOpportunity,
}

export const APIFY_INSTAGRAM_OPPORTUNITY_CONFIG: PublicSocialOpportunityConfig = {
  adapterId: 'apify-instagram-demand-opportunities',
  platform: 'Instagram',
  enabledEnv: 'GTM_APIFY_INSTAGRAM_OPPORTUNITY_ENABLED',
  actorId: 'apify/instagram-scraper',
  actorBuild: '0.0.775',
  actorEnv: 'GTM_APIFY_ACTOR_INSTAGRAM_SEARCH',
  useApprovalEnv: 'GTM_APIFY_INSTAGRAM_OPPORTUNITY_USE_APPROVED',
  priceVersionEnv: 'GTM_APIFY_INSTAGRAM_SEARCH_PRICE_VERSION',
  requiredPriceVersion: 'apify-instagram-scraper-0.0.775-bronze-events-2026-08-30',
  eventPricesUsd: { result: 0.0023 },
  oneTimeEvent: null,
  primaryResultEvent: 'result',
  perItemQuoteUsd: 0.0023,
  oneTimeQuoteUsd: 0,
  maxBatch: 10,
  datasetFields: [
    'id',
    'type',
    'shortCode',
    'caption',
    'url',
    'commentsCount',
    'likesCount',
    'videoPlayCount',
    'timestamp',
    'ownerUsername',
    'ownerFullName',
    'ownerId',
    'isSponsored',
    'locationName',
  ],
  buildInput: buildInstagramInput,
  normalize: normalizeInstagramOpportunity,
}

export const APIFY_TIKTOK_OPPORTUNITY_CONFIG: PublicSocialOpportunityConfig = {
  adapterId: 'apify-tiktok-demand-opportunities',
  platform: 'TikTok',
  enabledEnv: 'GTM_APIFY_TIKTOK_OPPORTUNITY_ENABLED',
  actorId: 'clockworks/tiktok-scraper',
  actorBuild: '0.0.600',
  actorEnv: 'GTM_APIFY_ACTOR_TIKTOK_SEARCH',
  useApprovalEnv: 'GTM_APIFY_TIKTOK_OPPORTUNITY_USE_APPROVED',
  priceVersionEnv: 'GTM_APIFY_TIKTOK_SEARCH_PRICE_VERSION',
  requiredPriceVersion: 'clockworks-tiktok-scraper-0.0.600-bronze-events-2026-08-30',
  eventPricesUsd: {
    'actor-start': 0.001,
    result: 0.003,
    'filter-applied': 0.001,
  },
  oneTimeEvent: 'actor-start',
  primaryResultEvent: 'result',
  auxiliaryResultEvents: ['filter-applied'],
  perItemQuoteUsd: 0.004,
  oneTimeQuoteUsd: 0.001,
  minimumMaxChargeUsd: 0.5,
  maxBatch: 10,
  datasetFields: [
    'id',
    'text',
    'createTime',
    'createTimeISO',
    'webVideoUrl',
    'locationCreated',
    'isAd',
    'isSponsored',
    'diggCount',
    'shareCount',
    'playCount',
    'commentCount',
    'authorMeta',
    'locationMeta',
    'error',
    'errorCode',
  ],
  buildInput: buildTikTokInput,
  normalize: normalizeTikTokOpportunity,
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
      max_batch: config.maxBatch ?? MAX_RESULTS,
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

function meetupLocation(plan: SourceSearchPlan): string {
  const value = text(plan.provider_query?.meetup_location, 180)
  if (!value) throw new TypeError('Meetup requires a frozen city and state location')
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2) throw new TypeError('Meetup location must include city and state')
  return `${parts[0]}, ${parts[1]}`
}

function requiredMeetupContract(plan: SourceSearchPlan): void {
  const expected: Array<[string, unknown]> = [
    ['meetup_contract_version', 'public-events-v2'],
    ['meetup_event_type', 'PHYSICAL'],
    ['meetup_country', 'us'],
    ['meetup_radius_miles', 25],
    ['meetup_window_days', 30],
    ['meetup_min_rsvp_count', 1],
    ['meetup_sort', 'RELEVANCE'],
  ]
  for (const [field, value] of expected) {
    if (plan.provider_query?.[field] !== value) {
      throw new TypeError(`Meetup ${field} does not match the frozen public-events contract`)
    }
  }
  if (requestedOpportunityIntent(plan) !== 'local_audience') {
    throw new TypeError('Meetup is limited to the local-audience opportunity lane')
  }
  if (!isMeetupReturnedContentFilterVersion(
    plan.provider_query?.meetup_returned_content_filter_version,
  )) {
    throw new TypeError('unsupported Meetup returned-content filter version')
  }
}

function buildMeetupInput(
  plan: SourceSearchPlan,
  maxResults: number,
  attemptedAt: string,
): Record<string, unknown> {
  requiredMeetupContract(plan)
  if (maxResults > 10) throw new TypeError('Meetup is limited to 10 results per quoted lane')
  const [city, state] = meetupLocation(plan).split(',').map((part) => part.trim())
  const start = new Date(attemptedAt)
  if (!Number.isFinite(start.getTime())) throw new TypeError('Meetup requires a valid attempt time')
  const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1_000)
  return {
    mode: 'events',
    searchKeyword: queryText(plan, 100),
    city,
    state,
    country: 'us',
    eventType: 'PHYSICAL',
    radius: 25,
    startDateRange: start.toISOString(),
    endDateRange: end.toISOString(),
    minRsvpCount: 1,
    sortBy: 'RELEVANCE',
    maxResults,
  }
}

function buildInstagramInput(
  plan: SourceSearchPlan,
  maxResults: number,
  attemptedAt: string,
): Record<string, unknown> {
  validateSocialReturnedContentFilter(plan)
  if (maxResults > 10) throw new TypeError('Instagram is limited to 10 results per quoted lane')
  const query = queryText(plan, 100)
  if (!/^#[A-Za-z0-9_]{2,80}$/.test(query)) {
    throw new TypeError('Instagram public-post research requires one bounded hashtag')
  }
  const attempted = new Date(attemptedAt)
  if (!Number.isFinite(attempted.getTime())) {
    throw new TypeError('Instagram requires a valid attempt time')
  }
  const newerThan = new Date(attempted.getTime() - 30 * 24 * 60 * 60 * 1_000)
  return {
    resultsType: 'posts',
    search: query,
    searchType: 'hashtag',
    searchLimit: 1,
    resultsLimit: maxResults,
    onlyPostsNewerThan: newerThan.toISOString().slice(0, 10),
    addParentData: false,
  }
}

function buildTikTokInput(
  plan: SourceSearchPlan,
  maxResults: number,
): Record<string, unknown> {
  validateSocialReturnedContentFilter(plan)
  if (maxResults > 10) throw new TypeError('TikTok is limited to 10 results per quoted lane')
  return {
    searchQueries: [queryText(plan, 100)],
    resultsPerPage: maxResults,
    searchSection: '/video',
    videoSearchDateFilter: 'PAST_MONTH',
    scrapeRelatedSearchWords: false,
    scrapeRelatedVideos: false,
    scrapeAdditionalAuthorMeta: false,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSlideshowImages: false,
    shouldDownloadAvatars: false,
    shouldDownloadMusicCovers: false,
    downloadSubtitlesOptions: 'NEVER_DOWNLOAD_SUBTITLES',
    aiVideoDescription: false,
    aiVideoSummary: false,
    commentsPerPost: 0,
    topLevelCommentsPerPost: 0,
    maxRepliesPerComment: 0,
  }
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
    if (platform === 'Meetup' && host !== 'meetup.com' && !host.endsWith('.meetup.com')) return null
    if (platform === 'Instagram' && host !== 'instagram.com') return null
    if (platform === 'TikTok' && host !== 'tiktok.com' && !host.endsWith('.tiktok.com')) return null
    url.protocol = 'https:'
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function safePublicPostUrl(value: unknown, platform: 'Instagram' | 'TikTok'): string | null {
  const sourceUrl = safePlatformUrl(value, platform)
  if (!sourceUrl) return null
  const pathname = new URL(sourceUrl).pathname
  if (platform === 'Instagram' && !/^\/(?:p|reel|tv)\/[^/]+\/?$/i.test(pathname)) return null
  if (platform === 'TikTok' && !/^\/@[^/]+\/video\/\d+\/?$/i.test(pathname)) return null
  return sourceUrl
}

function meetupTopicNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => text(record(item)?.name, 100))
    .filter((item): item is string => item != null)
    .slice(0, 12)
}

function meetupPeople(
  group: Record<string, unknown> | null,
  hostsValue: unknown,
): CandidateIdentity['people_to_follow'] {
  const people: NonNullable<CandidateIdentity['people_to_follow']> = []
  const organizerName = text(group?.organizerName, 120)
  const organizerProfileUrl = safePlatformUrl(group?.organizerProfileUrl, 'Meetup')
  if (organizerName) {
    people.push({
      name: organizerName,
      role: 'Public Meetup group organizer shown as secondary source context',
      profile_url: organizerProfileUrl,
    })
  }
  if (Array.isArray(hostsValue)) {
    for (const item of hostsValue) {
      const host = record(item)
      const name = text(host?.name, 120)
      if (!name || people.some((person) => person.name.toLowerCase() === name.toLowerCase())) continue
      people.push({
        name,
        role: 'Public Meetup event host shown as secondary source context',
        profile_url: safePlatformUrl(host?.memberUrl, 'Meetup'),
      })
      if (people.length >= 5) break
    }
  }
  return people.length > 0 ? people : undefined
}

export function normalizeMeetupOpportunity(value: unknown, context: NormalizeContext): Candidate | null {
  const row = record(value)
  if (!row || !context.location) return null
  const eventId = text(row.eventId, 200)
  const eventName = text(row.eventName, 180)
  const description = text(row.eventDescription, 1_200)
  const sourceUrl = safePlatformUrl(row.eventUrl ?? row.eventShortUrl, 'Meetup')
  const eventType = text(row.eventType, 40)?.toUpperCase()
  const status = text(row.eventStatus, 40)?.toLowerCase()
  if (
    !eventId
    || !eventName
    || !description
    || !sourceUrl
    || eventType !== 'PHYSICAL'
    || row.isOnline === true
    || !status
    || !['active', 'upcoming', 'scheduled', 'published'].includes(status)
  ) return null

  const attemptedAt = new Date(context.attemptedAt)
  const eventStart = sourcePublishedAt(row.startDateTime ?? row.date)
  if (!eventStart) return null
  const eventDate = new Date(eventStart)
  if (
    !Number.isFinite(attemptedAt.getTime())
    || !Number.isFinite(eventDate.getTime())
    || eventDate.getTime() <= attemptedAt.getTime()
    || eventDate.getTime() > attemptedAt.getTime() + 30 * 24 * 60 * 60 * 1_000
  ) return null

  const venue = record(row.venue)
  const venueCity = text(venue?.city, 120)
  const venueState = text(venue?.state, 120)
  const venueCountry = text(venue?.country, 20)?.toLowerCase()
  const returnedLocation = [venueCity, venueState, venueCountry].filter(Boolean).join(', ')
  const demonstratedLocation = demonstratedOpportunityLocation(returnedLocation, context.location)
  if (!demonstratedLocation || !['us', 'usa', 'united states'].includes(venueCountry ?? '')) return null

  const group = record(row.group)
  const groupName = text(group?.name ?? row.organizedByGroup, 180)
  const topics = meetupTopicNames(row.topics)
  const content = [eventName, description, groupName, ...topics].filter(Boolean).join('. ')
  if (SENSITIVE_TARGETING.test(content) || sensitiveConsumerOpportunityReasons(content).length > 0) return null
  const engagement = Math.min(10_000_000, nonNegativeInteger(row.actualAttendees))
  const memberCount = Math.min(10_000_000, nonNegativeInteger(group?.memberCount))
  const paid = row.isPaidEvent === true || row.feeRequired === true
  const publishedAt = sourcePublishedAt(row.createdTime)
  const demonstratedIntent = classifyOpportunityIntent(content)
  const identity = commonIdentity({
    name: eventName,
    platform: 'Meetup',
    content,
    sourceUrl,
    requestedLocation: context.location,
    locationEvidence: returnedLocation,
    engagement,
    demonstratedIntent,
    people: meetupPeople(group, row.hosts),
  })
  identity.opportunity_kind = 'event'
  identity.location = demonstratedLocation
  identity.city = venueCity
  identity.region = venueState
  identity.country_code = 'US'
  identity.member_count = memberCount || null
  identity.access_type = paid ? 'ticketed' : 'public'
  identity.source_published_at = publishedAt
  identity.event_start_at = eventStart
  identity.participation_rules = 'Review the current public event details, host requirements, ticket terms, and Meetup community rules before participating.'
  identity.participation_rules_status = 'unverified'
  identity.recommended_action = 'Open the public event page, confirm it is still active and appropriate, then attend or contact the organizer manually under the posted rules.'
  identity.message_angle = 'Offer practical local housing guidance that directly helps the event audience; do not infer individual buying or selling intent.'
  return {
    entity_kind: 'opportunity',
    identity,
    evidence: [
      {
        claim: engagement > 0
          ? `The approved public source returned this upcoming Meetup event with ${engagement} visible RSVPs or attendees.`
          : 'The approved public source returned this upcoming Meetup event.',
        source_url: sourceUrl,
        observed_at: context.attemptedAt,
        confidence: calibratedOpportunityConfidence({
          content,
          sourceUrl,
          observedAt: publishedAt ?? eventStart,
          attemptedAt: context.attemptedAt,
          engagement,
          location: demonstratedLocation,
        }),
        detail: {
          provider: 'apify',
          actor_id: context.actorId,
          provider_event_id: eventId,
          requested_location: context.location,
          requested_intent: context.expectedIntent ?? null,
          structured_venue: {
            name: text(venue?.name, 180),
            city: venueCity,
            state: venueState,
            country: venueCountry,
          },
          group_name: groupName,
          topic_names: topics,
          event_start_at: eventStart,
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
  demonstratedIntent?: ReturnType<typeof classifyOpportunityIntent>
}): CandidateIdentity {
  const demonstratedIntent = args.demonstratedIntent ?? classifyOpportunityIntent(args.content)
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
  const rowType = text(row?.recordType ?? row?.type ?? row?._type, 20)?.toLowerCase()
  if (!row || (rowType !== 'post' && rowType !== 'comment')) return null
  if (row._status != null && text(row._status, 20)?.toLowerCase() !== 'found') return null
  if (
    row.isNSFW === true
    || row.isNsfw === true
    || row.over_18 === true
    || row.isLocked === true
    || row.locked === true
    || row.isArchived === true
    || row.archived === true
    || row.isStickied === true
    || row.stickied === true
    || row.isDeleted === true
    || row.isRemoved === true
    || row.isCommercialCommunication === true
  ) return null
  const sourceUrl = safePlatformUrl(row.permalink ?? row.url, 'Reddit')
  const postTitle = text(rowType === 'comment' ? row.postTitle : row.title, 180)
  const body = text(
    rowType === 'comment'
      ? row.body ?? row.text
      : row.selfText ?? row.selftext ?? row.body ?? row.text,
    600,
  )
  if (!sourceUrl || (rowType === 'post' && !postTitle) || (rowType === 'comment' && !body)) return null
  const content = rowType === 'comment'
    ? body ?? ''
    : body
      ? `${postTitle}. ${body}`
      : postTitle ?? ''
  if (SENSITIVE_TARGETING.test(content) || sensitiveConsumerOpportunityReasons(content).length > 0) return null
  const subredditFromPath = (() => {
    try {
      const match = new URL(sourceUrl).pathname.match(/^\/r\/([^/]+)/i)
      return match?.[1] ? decodeURIComponent(match[1]) : null
    } catch {
      return null
    }
  })()
  const subreddit = text(row.subreddit, 100) ?? text(subredditFromPath, 100)
  const subredditInfo = record(row.subredditInfo)
  if (subredditInfo?.isNsfw === true || subredditInfo?.isQuarantined === true) return null
  const engagement = Math.min(
    10_000_000,
    nonNegativeInteger(row.score)
      + nonNegativeInteger(
        rowType === 'comment'
          ? row.postCommentCount
          : row.numComments ?? row.num_comments ?? row.commentCount,
      ),
  )
  const author = text(row.author, 100)
  const memberCount = nonNegativeInteger(
    rowType === 'comment'
      ? row.subredditSubscribers ?? row.subreddit_subscribers
      : row.subredditSubscribers ?? row.subreddit_subscribers ?? subredditInfo?.subscribersCount,
  )
  // Parent-post context is useful provenance but cannot manufacture the
  // comment author's intent. Fit-v7 sees only the returned comment body.
  const semanticContent = rowType === 'comment' ? body ?? '' : content
  const demonstratedIntent = classifyRedditOpportunityIntent(
    semanticContent,
    context.semanticFilterVersion,
  )
  const identity = commonIdentity({
    name: rowType === 'comment'
      ? `Reddit comment${subreddit ? ` in r/${subreddit}` : ''}`
      : postTitle ?? '',
    platform: 'Reddit',
    content: semanticContent,
    sourceUrl,
    requestedLocation: context.location,
    locationEvidence: `${semanticContent}\n${subreddit ?? ''}`,
    engagement,
    demonstratedIntent,
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
  // The pinned search actor documents `createdAt`; the pinned thread actor
  // documents `created_utc` for posts and `createdAt` for comments. The exact
  // actor/build pair is immutable in each approved descriptor, so only those
  // returned source timestamps may satisfy the downstream freshness gate.
  const publishedAt = sourcePublishedAt(row.createdAt ?? row.created_utc)
  identity.source_published_at = publishedAt
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
          provider_post_id: text(
            rowType === 'comment' ? row.postId ?? row._post_id : row._post_id ?? row.id,
            200,
          ),
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

function freshPublicPostTimestamp(value: unknown, attemptedAt: string): string | null {
  const publishedAt = sourcePublishedAt(value)
  if (!publishedAt) return null
  const published = new Date(publishedAt).getTime()
  const attempted = new Date(attemptedAt).getTime()
  if (!Number.isFinite(published) || !Number.isFinite(attempted)) return null
  if (published > attempted || published < attempted - 30 * 24 * 60 * 60 * 1_000) return null
  return publishedAt
}

export function normalizeInstagramOpportunity(value: unknown, context: NormalizeContext): Candidate | null {
  const row = record(value)
  if (!row || row.isSponsored === true) return null
  const providerPostId = text(row.id ?? row.shortCode, 200)
  const sourceUrl = safePublicPostUrl(row.url, 'Instagram')
  const content = text(row.caption, 1_200)
  const publishedAt = freshPublicPostTimestamp(row.timestamp, context.attemptedAt)
  if (
    !providerPostId
    || !sourceUrl
    || !content
    || !publishedAt
    || SENSITIVE_TARGETING.test(content)
    || sensitiveConsumerOpportunityReasons(content).length > 0
  ) return null
  const engagement = Math.min(
    10_000_000,
    nonNegativeInteger(row.likesCount) + nonNegativeInteger(row.commentsCount),
  )
  const username = text(row.ownerUsername, 100)?.replace(/^@/, '') ?? null
  const fullName = text(row.ownerFullName, 120)
  const returnedLocation = text(row.locationName, 180) ?? ''
  const demonstratedIntent = classifyOpportunityIntent(content)
  const identity = commonIdentity({
    name: content.length > 110 ? `${content.slice(0, 107).trimEnd()}...` : content,
    platform: 'Instagram',
    content,
    sourceUrl,
    requestedLocation: context.location,
    locationEvidence: `${content}\n${returnedLocation}`,
    engagement,
    demonstratedIntent,
    people:
      fullName || username
        ? [{
            name: fullName ?? username ?? 'Public Instagram contributor',
            role: 'Public Instagram author shown as secondary source context',
            profile_url: username
              ? safePlatformUrl(`https://www.instagram.com/${encodeURIComponent(username)}/`, 'Instagram')
              : null,
          }]
        : undefined,
  })
  identity.opportunity_kind = 'post'
  identity.source_published_at = publishedAt
  identity.participation_rules = 'Review the current public Instagram post, account, and community rules before participating. Do not automate consumer contact or posting.'
  identity.recommended_action = 'Open the current public post and contribute useful information manually only when participation is relevant and permitted.'
  return {
    entity_kind: 'opportunity',
    identity,
    evidence: [{
      claim: engagement > 0
        ? `The approved public source returned this Instagram post with ${engagement} visible likes and comments.`
        : 'The approved public source returned this Instagram post.',
      source_url: sourceUrl,
      observed_at: context.attemptedAt,
      confidence: calibratedOpportunityConfidence({
        content,
        sourceUrl,
        observedAt: publishedAt,
        attemptedAt: context.attemptedAt,
        engagement,
        location: identity.location ?? null,
      }),
      detail: {
        provider: 'apify',
        actor_id: context.actorId,
        provider_post_id: providerPostId,
        requested_location: context.location,
        requested_intent: context.expectedIntent ?? null,
        returned_location: returnedLocation || null,
        source_published_at: publishedAt,
        visible_engagement: engagement,
        demonstrated_intent_signals: [
          ...demonstratedIntent.buyerSignals,
          ...demonstratedIntent.sellerSignals,
          ...demonstratedIntent.localAudienceSignals,
        ],
      },
    }],
  }
}

export function normalizeTikTokOpportunity(value: unknown, context: NormalizeContext): Candidate | null {
  const row = record(value)
  const author = record(row?.authorMeta)
  if (
    !row
    || row.error != null
    || row.errorCode != null
    || row.isAd === true
    || row.isSponsored === true
    || author?.privateAccount === true
  ) return null
  const providerPostId = text(row.id, 200)
  const sourceUrl = safePublicPostUrl(row.webVideoUrl, 'TikTok')
  const content = text(row.text, 1_200)
  const publishedAt = freshPublicPostTimestamp(
    row.createTimeISO ?? row.createTime,
    context.attemptedAt,
  )
  if (
    !providerPostId
    || !sourceUrl
    || !content
    || !publishedAt
    || SENSITIVE_TARGETING.test(content)
    || sensitiveConsumerOpportunityReasons(content).length > 0
  ) return null
  const engagement = Math.min(
    10_000_000,
    nonNegativeInteger(row.diggCount)
      + nonNegativeInteger(row.commentCount)
      + nonNegativeInteger(row.shareCount),
  )
  const locationMeta = record(row.locationMeta)
  const returnedLocation = [
    text(locationMeta?.locationName, 180),
    text(locationMeta?.address, 180),
    text(locationMeta?.city, 120),
    text(row.locationCreated, 120),
  ].filter((part): part is string => part != null).join(', ')
  const username = text(author?.name, 100)?.replace(/^@/, '') ?? null
  const fullName = text(author?.nickName, 120)
  const demonstratedIntent = classifyOpportunityIntent(content)
  const identity = commonIdentity({
    name: content.length > 110 ? `${content.slice(0, 107).trimEnd()}...` : content,
    platform: 'TikTok',
    content,
    sourceUrl,
    requestedLocation: context.location,
    locationEvidence: `${content}\n${returnedLocation}`,
    engagement,
    demonstratedIntent,
    people:
      fullName || username
        ? [{
            name: fullName ?? username ?? 'Public TikTok contributor',
            role: 'Public TikTok author shown as secondary source context',
            profile_url: safePlatformUrl(author?.profileUrl, 'TikTok'),
          }]
        : undefined,
  })
  identity.opportunity_kind = 'post'
  identity.source_published_at = publishedAt
  identity.participation_rules = 'Review the current public TikTok post, account, and community rules before participating. Do not automate consumer contact or posting.'
  identity.recommended_action = 'Open the current public post and contribute useful information manually only when participation is relevant and permitted.'
  return {
    entity_kind: 'opportunity',
    identity,
    evidence: [{
      claim: engagement > 0
        ? `The approved public source returned this TikTok post with ${engagement} visible likes, comments, and shares.`
        : 'The approved public source returned this TikTok post.',
      source_url: sourceUrl,
      observed_at: context.attemptedAt,
      confidence: calibratedOpportunityConfidence({
        content,
        sourceUrl,
        observedAt: publishedAt,
        attemptedAt: context.attemptedAt,
        engagement,
        location: identity.location ?? null,
      }),
      detail: {
        provider: 'apify',
        actor_id: context.actorId,
        provider_post_id: providerPostId,
        requested_location: context.location,
        requested_intent: context.expectedIntent ?? null,
        returned_location: returnedLocation || null,
        source_published_at: publishedAt,
        visible_engagement: engagement,
        demonstrated_intent_signals: [
          ...demonstratedIntent.buyerSignals,
          ...demonstratedIntent.sellerSignals,
          ...demonstratedIntent.localAudienceSignals,
        ],
      },
    }],
  }
}

function providerUnitsFor(config: PublicSocialOpportunityConfig, maxResults: number): number {
  const estimatedUsd = config.oneTimeQuoteUsd + maxResults * config.perItemQuoteUsd
  return Math.max(APIFY_MIN_CHARGE_USD, config.minimumMaxChargeUsd ?? 0, estimatedUsd)
    / APIFY_MILLIDOLLAR_USD
}

function datasetCeiling(config: PublicSocialOpportunityConfig, maxChargeUsd: number): number {
  const available = Math.max(0, maxChargeUsd - config.oneTimeQuoteUsd)
  return Math.max(
    1,
    Math.min(config.maxBatch ?? 100, Math.floor((available + 1e-9) / config.perItemQuoteUsd)),
  )
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
      const requestedCandidates = Math.max(
        0,
        Math.min(Math.floor(plan.max_candidates), config.maxBatch ?? MAX_RESULTS),
      )
      const maxCandidates = requestedCandidates >= (config.minimumBatch ?? 1)
        ? requestedCandidates
        : 0
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
      const maxCandidates = Math.max(
        0,
        Math.min(Math.floor(plan.max_candidates), config.maxBatch ?? MAX_RESULTS),
      )
      if (maxCandidates <= 0) {
        return refusal(config, actorId, attemptedAt, 'bad_request: a positive opportunity cap is required')
      }
      if (maxCandidates < (config.minimumBatch ?? 1)) {
        return refusal(config, actorId, attemptedAt, 'bad_request: opportunity cap is below the provider batch minimum')
      }
      const maxChargeUsd = Number(plan.max_charge_usd)
      const minimumMaxChargeUsd = Math.max(
        APIFY_MIN_CHARGE_USD,
        config.minimumMaxChargeUsd ?? 0,
      )
      if (!Number.isFinite(maxChargeUsd) || maxChargeUsd < minimumMaxChargeUsd) {
        return refusal(config, actorId, attemptedAt, 'bad_request: a reservation-derived max charge is required')
      }
      let input: Record<string, unknown>
      let query: string
      try {
        query = queryText(
          plan,
          ['X', 'Threads', 'Instagram', 'TikTok'].includes(config.platform) ? 100 : 700,
        )
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
          && !(config.auxiliaryResultEvents ?? []).includes(event)
          && !(config.partitionedResultEvents ?? []).includes(event),
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
      if ((config.partitionedResultEvents?.length ?? 0) > 0) {
        if (!config.partitionedResultEvent) {
          return {
            status: 'ambiguous',
            data: null,
            receipt: providerReceipt(),
            cost_units: null,
            error: 'invalid_schema: partitioned result billing has no row classifier',
          }
        }
        const expectedPartitionCounts = Object.fromEntries(
          config.partitionedResultEvents!.map((event) => [event, 0]),
        ) as Record<string, number>
        for (const item of resultItems) {
          const event = config.partitionedResultEvent(item)
          if (!event || !(event in expectedPartitionCounts)) {
            return {
              status: 'ambiguous',
              data: null,
              receipt: providerReceipt({ unclassified_result_rows: 1 }),
              cost_units: null,
              error: 'invalid_schema: provider row did not match an approved billed result class',
            }
          }
          expectedPartitionCounts[event] += 1
        }
        for (const event of config.partitionedResultEvents!) {
          if ((counts[event] ?? 0) !== expectedPartitionCounts[event]) {
            return {
              status: 'ambiguous',
              data: null,
              receipt: providerReceipt({
                billed_partitioned_results: counts[event] ?? 0,
                expected_partitioned_results: expectedPartitionCounts[event],
                partitioned_result_event: event,
              }),
              cost_units: null,
              error: 'invalid_schema: partitioned billed result count did not match the bounded dataset',
            }
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
        location: config.platform === 'Meetup' ? meetupLocation(plan) : locationText(plan),
        expectedIntent: requestedOpportunityIntent(plan),
        scopedSubreddits:
          config.platform === 'Reddit' ? redditSubreddits(plan) : undefined,
        attemptedAt: outcome.attemptedAt,
        actorId,
        semanticFilterVersion:
          typeof plan.provider_query?.reddit_returned_content_filter_version === 'string'
            ? plan.provider_query.reddit_returned_content_filter_version
            : undefined,
      }
      const normalizedCandidates = resultItems
        .map((item) => config.normalize(item, context))
        .filter((candidate): candidate is Candidate => candidate != null)
      const filtersReturnedContent = config.platform === 'Reddit'
        || config.platform === 'Meetup'
        || config.platform === 'Instagram'
        || config.platform === 'TikTok'
      const assessedCandidates = normalizedCandidates.map((candidate) => ({
        candidate,
        assessment: filtersReturnedContent
          ? assessReturnedContent(config.platform, candidate, plan)
          : { matches: true, reasons: [] },
      }))
      const candidates = assessedCandidates
        .filter(({ assessment }) => assessment.matches)
        .map(({ candidate }) => candidate)
      const filterReasonCounts = returnedContentReasonCounts(assessedCandidates)
      if (candidates.length === 0) {
        const returnedContentFiltered = filtersReturnedContent ? normalizedCandidates.length : 0
        const semanticFilterVersion = returnedContentFilterVersion(config.platform, plan)
        const semanticFilter = isSemanticRedditFilterVersion(semanticFilterVersion)
          || isMeetupReturnedContentFilterVersion(semanticFilterVersion)
          || isSocialReturnedContentFilterVersion(semanticFilterVersion)
        return {
          status: normalizedCandidates.length > 0 ? 'no_result' : 'error',
          data: null,
          receipt: providerReceipt({
            parser_dropped_rows: outcome.itemCount - normalizedCandidates.length,
            ...(semanticFilter
              ? {
                  returned_content_filter_version: semanticFilterVersion,
                  returned_content_filtered_rows: returnedContentFiltered,
                  returned_content_filter_reasons: filterReasonCounts,
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
      const semanticFilterVersion = returnedContentFilterVersion(config.platform, plan)
      const semanticFilter = isSemanticRedditFilterVersion(semanticFilterVersion)
        || isMeetupReturnedContentFilterVersion(semanticFilterVersion)
        || isSocialReturnedContentFilterVersion(semanticFilterVersion)
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
                returned_content_filter_version: semanticFilterVersion,
                returned_content_filtered_rows: returnedContentFiltered,
                returned_content_filter_reasons: filterReasonCounts,
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

export function createApifyRedditThreadOpportunityAdapter(
  deps: PublicSocialDeps = {},
): SourceAdapter {
  return createPublicSocialOpportunityAdapter(APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG, deps)
}

export function createApifyRedditFreshOpportunityAdapter(
  deps: PublicSocialDeps = {},
): SourceAdapter {
  return createPublicSocialOpportunityAdapter(APIFY_REDDIT_FRESH_OPPORTUNITY_CONFIG, deps)
}

export function createApifyXOpportunityAdapter(deps: PublicSocialDeps = {}): SourceAdapter {
  return createPublicSocialOpportunityAdapter(APIFY_X_OPPORTUNITY_CONFIG, deps)
}

export function createApifyThreadsOpportunityAdapter(deps: PublicSocialDeps = {}): SourceAdapter {
  return createPublicSocialOpportunityAdapter(APIFY_THREADS_OPPORTUNITY_CONFIG, deps)
}

export function createApifyMeetupOpportunityAdapter(deps: PublicSocialDeps = {}): SourceAdapter {
  return createPublicSocialOpportunityAdapter(APIFY_MEETUP_OPPORTUNITY_CONFIG, deps)
}

export function createApifyInstagramOpportunityAdapter(deps: PublicSocialDeps = {}): SourceAdapter {
  return createPublicSocialOpportunityAdapter(APIFY_INSTAGRAM_OPPORTUNITY_CONFIG, deps)
}

export function createApifyTikTokOpportunityAdapter(deps: PublicSocialDeps = {}): SourceAdapter {
  return createPublicSocialOpportunityAdapter(APIFY_TIKTOK_OPPORTUNITY_CONFIG, deps)
}

export function apifyRedditOpportunityEnabled(env: SocialEnv = process.env): boolean {
  return publicSocialOpportunityEnabled(APIFY_REDDIT_OPPORTUNITY_CONFIG, env)
}

export function apifyRedditThreadOpportunityEnabled(env: SocialEnv = process.env): boolean {
  return publicSocialOpportunityEnabled(APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG, env)
}

export function apifyRedditFreshOpportunityEnabled(env: SocialEnv = process.env): boolean {
  return publicSocialOpportunityEnabled(APIFY_REDDIT_FRESH_OPPORTUNITY_CONFIG, env)
}

export function apifyXOpportunityEnabled(env: SocialEnv = process.env): boolean {
  return publicSocialOpportunityEnabled(APIFY_X_OPPORTUNITY_CONFIG, env)
}

export function apifyThreadsOpportunityEnabled(env: SocialEnv = process.env): boolean {
  return publicSocialOpportunityEnabled(APIFY_THREADS_OPPORTUNITY_CONFIG, env)
}

export function apifyMeetupOpportunityEnabled(env: SocialEnv = process.env): boolean {
  return publicSocialOpportunityEnabled(APIFY_MEETUP_OPPORTUNITY_CONFIG, env)
}

export function apifyInstagramOpportunityEnabled(env: SocialEnv = process.env): boolean {
  return publicSocialOpportunityEnabled(APIFY_INSTAGRAM_OPPORTUNITY_CONFIG, env)
}

export function apifyTikTokOpportunityEnabled(env: SocialEnv = process.env): boolean {
  return publicSocialOpportunityEnabled(APIFY_TIKTOK_OPPORTUNITY_CONFIG, env)
}
