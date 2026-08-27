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
  APIFY_CUSTOMER_USE_APPROVED_ENV,
  APIFY_ENABLED_ENV,
  APIFY_PRICE_VERSION_ENV,
  APIFY_REQUIRED_PRICE_VERSION,
  APIFY_REQUIRED_TERMS_VERSION,
  APIFY_TERMS_VERSION_ENV,
  APIFY_TIMEOUT_MS_ENV,
  APIFY_TOKEN_ENVS,
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

const APIFY_MILLIDOLLAR_USD = 0.001
const MAX_RESULTS = 25
const MAX_DATASET_BODY_BYTES = 2_000_000
const SENSITIVE_TARGETING =
  /\b(?:bereav(?:ed|ement)|widow(?:ed|er)?|probate|divorc(?:e|ed|ing)|foreclos(?:e|ed|ure)|bankrupt(?:cy)?|tax delinquen(?:t|cy)|mortgage payoff|disab(?:led|ility)|medical|health condition|pregnan(?:t|cy)|family status|retire(?:d|ment)|elderly|senior citizen)\b/i
const BUYER_INTENT =
  /\b(?:buy(?:ing)?|buyer|house hunt|home search|first[- ]time home|moving to|move to|relocat(?:e|ing|ion)|looking for (?:a )?(?:home|house|condo))\b/i
const SELLER_INTENT =
  /\b(?:sell(?:ing)?|seller|list(?:ing)? (?:a|my|our|the)? ?(?:home|house|property)|home valuation|home worth|prepare (?:a|my|our|the)? ?(?:home|house) for sale)\b/i

type SocialEnv = Record<string, string | undefined>
type SocialPlatform = 'Reddit' | 'X'

export type PublicSocialOpportunityConfig = {
  adapterId: string
  platform: SocialPlatform
  actorId: string
  actorBuild: string
  actorEnv: string
  useApprovalEnv: string
  priceVersionEnv: string
  requiredPriceVersion: string
  eventPricesUsd: Record<string, number>
  primaryResultEvent: string
  perItemQuoteUsd: number
  oneTimeQuoteUsd: number
  datasetFields: readonly string[]
  buildInput(plan: SourceSearchPlan, maxResults: number): Record<string, unknown>
  normalize(value: unknown, context: NormalizeContext): Candidate | null
}

type NormalizeContext = {
  query: string
  location: string | null
  attemptedAt: string
  actorId: string
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
  requiredPriceVersion: 'clearpath-reddit-search-0.0.66-events-2026-08-26',
  eventPricesUsd: {
    'apify-actor-start': 0.00099,
    'apify-default-dataset-item': 0.00001,
    'result-scraped': 0.00099,
  },
  primaryResultEvent: 'result-scraped',
  // Reserve the documented primary result plus the platform dataset event.
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
  ],
  buildInput(plan, maxResults) {
    return {
      query: queryText(plan, 700),
      maxResults,
      contentType: 'posts',
      sort: 'new',
      timeFilter: redditTimeFilter(plan),
      autoDiscoverSubreddits: true,
      maxSubreddits: 10,
    }
  },
  normalize: normalizeRedditOpportunity,
}

export const APIFY_X_OPPORTUNITY_CONFIG: PublicSocialOpportunityConfig = {
  adapterId: 'apify-x-demand-opportunities',
  platform: 'X',
  actorId: 'scraper_one/x-posts-search',
  actorBuild: '0.0.153',
  actorEnv: 'GTM_APIFY_ACTOR_X_POST_SEARCH',
  useApprovalEnv: 'GTM_APIFY_X_OPPORTUNITY_USE_APPROVED',
  priceVersionEnv: 'GTM_APIFY_X_POST_SEARCH_PRICE_VERSION',
  // The production Apify account is on FREE. Actor metadata rechecked through
  // Apify's public API on 2026-08-27: FREE is $0.025 once per run and
  // $0.00125 per result. Other tiers are cheaper, but a plan change must update
  // this exact contract instead of silently changing the reservation math.
  requiredPriceVersion: 'scraper-one-x-post-search-0.0.153-free-events-2026-08-27',
  eventPricesUsd: { init: 0.025, 'result-item': 0.00125 },
  primaryResultEvent: 'result-item',
  perItemQuoteUsd: 0.00125,
  oneTimeQuoteUsd: 0.025,
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
    envValue(env, APIFY_CUSTOMER_USE_APPROVED_ENV) === 'true' &&
    envValue(env, APIFY_TERMS_VERSION_ENV) === APIFY_REQUIRED_TERMS_VERSION &&
    envValue(env, APIFY_PRICE_VERSION_ENV) === APIFY_REQUIRED_PRICE_VERSION &&
    envValue(env, config.useApprovalEnv) === 'true' &&
    envValue(env, config.priceVersionEnv) === config.requiredPriceVersion &&
    configuredActor(config, env) === config.actorId
  )
}

export function publicSocialOpportunityEnabled(
  config: PublicSocialOpportunityConfig,
  env: SocialEnv = process.env,
): boolean {
  return apifyEnabled(env) && apifyToken(env) !== null && publicSocialOpportunityApproved(config, env)
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
  if (/hour|1h/.test(raw)) return 'hour'
  if (/week|7d|\b7 days?\b/.test(raw)) return 'week'
  if (/today|24h|day/.test(raw)) return 'day'
  if (/year|365d/.test(raw)) return 'year'
  return 'month'
}

function intentKind(content: string, query: string): NonNullable<CandidateIdentity['intent_kind']> {
  const haystack = `${content} ${query}`
  const buyer = BUYER_INTENT.test(haystack)
  const seller = SELLER_INTENT.test(haystack)
  if (buyer && seller) return 'mixed_intent'
  if (buyer) return 'buyer_intent'
  if (seller) return 'seller_intent'
  return 'local_audience'
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
    url.protocol = 'https:'
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function isoDate(value: unknown, fallback: string): string {
  const numeric = Number(value)
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1_000)
    : new Date(String(value ?? ''))
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback
}

function commonIdentity(args: {
  name: string
  platform: SocialPlatform
  content: string
  query: string
  sourceUrl: string
  location: string | null
  engagement: number
  people?: CandidateIdentity['people_to_follow']
}): CandidateIdentity {
  return {
    name: args.name,
    opportunity_kind: 'thread',
    platform: args.platform,
    intent_kind: intentKind(args.content, args.query),
    audience_description: args.content,
    activity_level: activityLevel(args.engagement),
    engagement_count: args.engagement,
    access_type: 'public',
    location: args.location,
    provider_location: args.location,
    urls: [args.sourceUrl],
    participation_rules: `Review the current ${args.platform} community and thread rules. Use only public context and do not automate contact or posting.`,
    recommended_action:
      'Read the full public conversation and contribute one useful response manually when it is relevant and permitted.',
    message_angle:
      'Answer the specific buyer or seller question with practical local information before mentioning your services.',
    people_to_follow: args.people,
  }
}

export function normalizeRedditOpportunity(value: unknown, context: NormalizeContext): Candidate | null {
  const row = record(value)
  if (!row || text(row._type, 20)?.toLowerCase() !== 'post') return null
  if (row.isNsfw === true || row.isLocked === true || row.isArchived === true) return null
  const sourceUrl = safePlatformUrl(row.permalink, 'Reddit')
  const title = text(row.title, 180)
  if (!sourceUrl || !title) return null
  const body = text(row.body, 600)
  const content = body ? `${title}. ${body}` : title
  if (SENSITIVE_TARGETING.test(content)) return null
  const subreddit = text(row.subreddit, 100)
  const subredditInfo = record(row.subredditInfo)
  if (subredditInfo?.isNsfw === true || subredditInfo?.isQuarantined === true) return null
  const engagement = Math.min(10_000_000, nonNegativeInteger(row.score) + nonNegativeInteger(row.commentCount))
  const author = text(row.author, 100)
  const memberCount = nonNegativeInteger(subredditInfo?.subscribersCount)
  const identity = commonIdentity({
    name: title,
    platform: 'Reddit',
    content,
    query: context.query,
    sourceUrl,
    location: context.location,
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
  identity.member_count = memberCount || null
  return {
    entity_kind: 'opportunity',
    identity,
    evidence: [
      {
        claim:
          engagement > 0
            ? `Public Reddit discussion matched the approved demand query and showed ${engagement} visible score and comment signals.`
            : 'Public Reddit discussion matched the approved demand query.',
        source_url: sourceUrl,
        observed_at: isoDate(row.createdAt, context.attemptedAt),
        confidence: engagement > 0 ? 0.9 : 0.82,
        detail: {
          provider: 'apify',
          actor_id: context.actorId,
          provider_post_id: text(row.id, 200),
          subreddit,
          visible_engagement: engagement,
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
  if (!sourceUrl || !content || SENSITIVE_TARGETING.test(content)) return null
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
    query: context.query,
    sourceUrl,
    location: context.location,
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
  return {
    entity_kind: 'opportunity',
    identity,
    evidence: [
      {
        claim:
          engagement > 0
            ? `Public X post matched the approved demand query and showed ${engagement} visible interactions.`
            : 'Public X post matched the approved demand query.',
        source_url: sourceUrl,
        observed_at: isoDate(row.timestamp, context.attemptedAt),
        confidence: engagement > 0 ? 0.88 : 0.8,
        detail: {
          provider: 'apify',
          actor_id: context.actorId,
          provider_post_id: text(row.postId, 200),
          visible_engagement: engagement,
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
        query = queryText(plan, config.platform === 'X' ? 100 : 700)
        input = config.buildInput(plan, maxCandidates)
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
        return {
          status: 'error',
          data: null,
          receipt: providerReceipt(),
          cost_units: 0,
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
      const costUnits = outcome.providerCostUsd / APIFY_MILLIDOLLAR_USD
      if (outcome.status === 'no_result') {
        return {
          status: 'no_result',
          data: null,
          receipt: providerReceipt(),
          cost_units: costUnits,
        }
      }
      if ((counts[config.primaryResultEvent] ?? 0) !== outcome.itemCount) {
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
      const context = {
        query,
        location: locationText(plan),
        attemptedAt: outcome.attemptedAt,
        actorId,
      }
      const candidates = outcome.items
        .map((item) => config.normalize(item, context))
        .filter((candidate): candidate is Candidate => candidate != null)
      if (candidates.length === 0) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({ parser_dropped_rows: outcome.itemCount }),
          cost_units: null,
          error: 'invalid_schema: provider rows contained no safe public opportunity',
        }
      }
      const delivered = candidates.slice(0, maxCandidates)
      const dropped = Math.max(0, outcome.itemCount - candidates.length)
      const truncated = candidates.length > delivered.length
      return {
        status: dropped > 0 || truncated ? 'partial' : 'ok',
        data: delivered,
        receipt: providerReceipt({
          returned_count: delivered.length,
          parser_dropped_rows: dropped,
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

export function apifyRedditOpportunityEnabled(env: SocialEnv = process.env): boolean {
  return publicSocialOpportunityEnabled(APIFY_REDDIT_OPPORTUNITY_CONFIG, env)
}

export function apifyXOpportunityEnabled(env: SocialEnv = process.env): boolean {
  return publicSocialOpportunityEnabled(APIFY_X_OPPORTUNITY_CONFIG, env)
}
