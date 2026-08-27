import {
  capabilityCovers,
  type AdapterDescriptor,
  type AdapterResult,
  type Candidate,
  type CandidateIdentity,
  type SourceAdapter,
  type SourceSearchPlan,
} from '../types'
import { creditsFromUsd } from '../../credits/markup'
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
import { postedLimitFromRecencyWindow, type ApifyPostedLimit } from './actors'
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
} from '../../research/opportunity-quality'

/*
 * Consumer demand-surface discovery.
 *
 * This adapter intentionally returns PUBLIC OPPORTUNITIES, not recipients:
 * LinkedIn posts and conversations that match an approved audience query.
 * It never scrapes comments or reactions, never enriches a person, and never
 * sends or posts anything. A customer can open the source and decide whether
 * a helpful manual contribution is appropriate under the platform's rules.
 */

export const APIFY_OPPORTUNITY_SOURCE_ADAPTER_ID = 'apify-linkedin-demand-opportunities'
export const APIFY_OPPORTUNITY_SOURCE_ACTOR_ID = 'harvestapi/linkedin-post-search'
export const APIFY_OPPORTUNITY_SOURCE_ACTOR_BUILD = '0.0.104'
export const APIFY_OPPORTUNITY_SOURCE_SIGNAL = 'social_engagement'
export const APIFY_OPPORTUNITY_SOURCE_ACTOR_ENV = 'GTM_APIFY_ACTOR_LINKEDIN_POST_SEARCH'
export const APIFY_OPPORTUNITY_SOURCE_PRICE_VERSION_ENV = 'GTM_APIFY_LINKEDIN_POST_SEARCH_PRICE_VERSION'
export const APIFY_OPPORTUNITY_SOURCE_REQUIRED_PRICE_VERSION =
  'harvestapi-linkedin-post-search-0.0.104-free-bronze-events-2026-08-26'

export const APIFY_OPPORTUNITY_SOURCE_MAX_POSTS = 25
export const APIFY_OPPORTUNITY_SOURCE_DATASET_BYTES = 2_000_000
export const APIFY_OPPORTUNITY_SOURCE_DATASET_FIELDS = [
  'type',
  'id',
  'linkedinUrl',
  'content',
  'author',
  'postedAt',
  'engagement',
] as const

// Official Actor metadata rechecked through Apify's public API on 2026-08-26.
// FREE and BRONZE currently share the same event prices. If the account moves
// to another tier, finalized billing fails closed until the exact version is
// reviewed and updated rather than silently using a different rate.
export const APIFY_OPPORTUNITY_SOURCE_EVENT_PRICES_USD = {
  'apify-actor-start': 0.00005,
  post: 0.002,
  'no-result': 0.001,
} as const

const APIFY_MILLIDOLLAR_USD = 0.001
const APIFY_OPPORTUNITY_SOURCE_BILLING_CONTRACT: ApifyFinalizedBillingContract = {
  pricingModel: 'PAY_PER_EVENT',
  eventPricesUsd: APIFY_OPPORTUNITY_SOURCE_EVENT_PRICES_USD,
}

type OpportunitySourceEnv = Record<string, string | undefined>

type OpportunitySourceRunActor = (
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

export type ApifyOpportunitySourceDeps = {
  env?: OpportunitySourceEnv
  now?: () => Date
  runActor?: OpportunitySourceRunActor
  fetchImpl?: ApifyFetchLike
  finalizationDelayMs?: number
  sleep?: (delayMs: number) => Promise<void>
}

function processEnv(): OpportunitySourceEnv {
  return process.env as unknown as OpportunitySourceEnv
}

function configuredActor(env: OpportunitySourceEnv): string {
  return (env[APIFY_OPPORTUNITY_SOURCE_ACTOR_ENV] ?? '').trim() || APIFY_OPPORTUNITY_SOURCE_ACTOR_ID
}

function timeoutMs(env: OpportunitySourceEnv): number {
  const value = Number(env[APIFY_TIMEOUT_MS_ENV])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : APIFY_DEFAULT_TIMEOUT_MS
}

export function apifyOpportunitySourceApproved(env: OpportunitySourceEnv = processEnv()): boolean {
  return (
    env[APIFY_CUSTOMER_USE_APPROVED_ENV] === 'true' &&
    (env[APIFY_TERMS_VERSION_ENV] ?? '').trim() === APIFY_REQUIRED_TERMS_VERSION &&
    (env[APIFY_PRICE_VERSION_ENV] ?? '').trim() === APIFY_REQUIRED_PRICE_VERSION &&
    (env[APIFY_OPPORTUNITY_SOURCE_PRICE_VERSION_ENV] ?? '').trim() ===
      APIFY_OPPORTUNITY_SOURCE_REQUIRED_PRICE_VERSION &&
    configuredActor(env) === APIFY_OPPORTUNITY_SOURCE_ACTOR_ID
  )
}

export function apifyOpportunitySourceEnabled(env: OpportunitySourceEnv = processEnv()): boolean {
  return apifyEnabled(env) && apifyToken(env) !== null && apifyOpportunitySourceApproved(env)
}

export function apifyOpportunitySourceDescriptor(env: OpportunitySourceEnv = processEnv()): AdapterDescriptor {
  const approved = apifyOpportunitySourceApproved(env)
  return {
    contract_version: '2',
    adapter_id: APIFY_OPPORTUNITY_SOURCE_ADAPTER_ID,
    layer: 'source',
    capabilities: [
      {
        signal_kind: APIFY_OPPORTUNITY_SOURCE_SIGNAL,
        entity_units: ['opportunities'],
        geographies: ['US'],
        channels: [],
      },
    ],
    constraints: {
      license: {
        status: approved ? 'approved' : 'provisional',
        terms_version: (env[APIFY_TERMS_VERSION_ENV] ?? '').trim() || 'unapproved',
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
      rate_limits: { requests_per_minute: 30, concurrent: 1 },
      max_batch: APIFY_OPPORTUNITY_SOURCE_MAX_POSTS,
    },
    cost_model: {
      unit: 'apify_millidollar',
      quoted_credits_per_unit: creditsFromUsd(APIFY_MILLIDOLLAR_USD),
      price_version: (env[APIFY_OPPORTUNITY_SOURCE_PRICE_VERSION_ENV] ?? '').trim() || 'unapproved',
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
    // The customer-facing record is a bounded public-post projection and can
    // be deleted by the normal candidate retention/deletion path. We do not
    // retain comments, reactions, or a provider-native people dataset here.
    dsr: { deletion_supported: true },
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized ? normalized.slice(0, max) : null
}

function safeInteger(value: unknown): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function safeLinkedInUrl(value: unknown, pathPrefix?: '/posts/' | '/in/'): string | null {
  const raw = text(value, 2_000)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (!/^(?:www\.)?linkedin\.com$/i.test(url.hostname)) return null
    if (pathPrefix && !url.pathname.toLowerCase().startsWith(pathPrefix)) return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function sourcePublishedAt(row: Record<string, unknown>): string | null {
  const posted = record(row.postedAt)
  const value = text(posted?.date, 100)
  if (!value) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function engagementCount(row: Record<string, unknown>): number {
  const engagement = record(row.engagement)
  if (!engagement) return 0
  return Math.min(
    10_000_000,
    safeInteger(engagement.likes) + safeInteger(engagement.comments) + safeInteger(engagement.shares),
  )
}

function activityLevel(count: number): NonNullable<CandidateIdentity['activity_level']> {
  if (count >= 25) return 'high'
  if (count >= 5) return 'medium'
  if (count > 0) return 'low'
  return 'unknown'
}

function opportunityName(content: string | null, authorName: string | null): string {
  if (content) {
    const compact = content.length > 110 ? `${content.slice(0, 107).trimEnd()}...` : content
    return compact
  }
  return authorName ? `LinkedIn discussion by ${authorName}` : 'LinkedIn audience discussion'
}

function safeAuthor(row: Record<string, unknown>): {
  name: string | null
  profileUrl: string | null
} {
  const author = record(row.author)
  return {
    name: text(author?.name, 120),
    profileUrl: safeLinkedInUrl(author?.linkedinUrl, '/in/'),
  }
}

export function normalizeApifyOpportunityItem(
  value: unknown,
  context: { attemptedAt: string; query: string; requestedLocation?: string | null },
): Candidate | null {
  const row = record(value)
  if (!row) return null
  if (row.type != null && text(row.type, 20)?.toLowerCase() !== 'post') return null
  const sourceUrl = safeLinkedInUrl(row.linkedinUrl, '/posts/')
  if (!sourceUrl) return null
  const content = text(row.content, 800)
  const author = safeAuthor(row)
  const authorInfo = text(record(row.author)?.info, 180)
  const interactions = engagementCount(row)
  const publishedAt = sourcePublishedAt(row)
  const demonstratedIntent = classifyOpportunityIntent(content ?? '')
  const demonstratedLocation = demonstratedOpportunityLocation(
    `${content ?? ''}\n${authorInfo ?? ''}`,
    context.requestedLocation,
  )
  const identity: CandidateIdentity = {
    name: opportunityName(content, author.name),
    opportunity_kind: 'post',
    platform: 'LinkedIn',
    intent_kind: demonstratedIntent.kind,
    audience_description: content ?? 'A public LinkedIn discussion matching the approved audience query.',
    activity_level: activityLevel(interactions),
    engagement_count: interactions,
    access_type: 'public',
    source_published_at: publishedAt,
    location: demonstratedLocation,
    provider_location: context.requestedLocation ?? null,
    urls: [sourceUrl],
    recommended_action:
      'Read the full discussion and contribute a useful response only when it is relevant and the platform rules permit it.',
    participation_rules:
      'Use only public context. Do not automate contact, post through Noli, or collect private group data.',
    message_angle: 'Address the specific question or need in the discussion with practical, locally relevant help.',
  }
  if (author.name) {
    identity.people_to_follow = [
      {
        name: author.name,
        role: authorInfo,
        profile_url: author.profileUrl,
      },
    ]
  }
  return {
    entity_kind: 'opportunity',
    identity,
    evidence: [
      {
        claim:
          interactions > 0
            ? `The approved public source returned this LinkedIn post with ${interactions} visible interactions.`
            : 'The approved public source returned this LinkedIn post.',
        source_url: sourceUrl,
        observed_at: context.attemptedAt,
        confidence: calibratedOpportunityConfidence({
          content: content ?? '',
          sourceUrl,
          observedAt: publishedAt ?? '',
          attemptedAt: context.attemptedAt,
          engagement: interactions,
          location: demonstratedLocation,
        }),
        detail: {
          provider: 'apify',
          actor_id: APIFY_OPPORTUNITY_SOURCE_ACTOR_ID,
          provider_post_id: text(row.id, 200),
          author_name: author.name,
          query: context.query.slice(0, 200),
          requested_location: context.requestedLocation ?? null,
          source_published_at: publishedAt,
          visible_interactions: interactions,
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

function postedLimit(value: unknown): ApifyPostedLimit {
  const raw = text(value, 100)
  return postedLimitFromRecencyWindow(raw)
}

function providerQueryText(plan: SourceSearchPlan): string {
  const query = plan.provider_query ?? {}
  const discovery = Array.isArray(query.source_search_keywords)
    ? query.source_search_keywords.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : null
  return (
    text(query.search_query, 200) ??
    text(discovery, 200) ??
    text(query.keywords, 200) ??
    text(query.query, 200) ??
    text(plan.query, 200) ??
    ''
  )
}

function providerLocationText(plan: SourceSearchPlan): string | null {
  const values = plan.provider_query?.locations
  if (Array.isArray(values)) {
    const location = values.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    if (location) return text(location, 180)
  }
  return text(plan.geography, 180)
}

export function buildApifyOpportunityInput(plan: SourceSearchPlan): Record<string, unknown> {
  const keywords = providerQueryText(plan)
  if (!keywords) throw new TypeError('a bounded opportunity search query is required')
  const maxPosts = Math.max(1, Math.min(Math.floor(plan.max_candidates), APIFY_OPPORTUNITY_SOURCE_MAX_POSTS))
  const recency =
    plan.provider_query?.posted_limit ?? plan.provider_query?.recency_window ?? plan.provider_query?.recency
  return {
    searchQueries: [keywords],
    maxPosts,
    postedLimit: postedLimit(recency),
    sortBy: 'relevance',
    profileScraperMode: 'short',
    startPage: 1,
    scrapeReactions: false,
    postNestedReactions: false,
    scrapeComments: false,
    postNestedComments: false,
  }
}

function providerUnitsFor(maxPosts: number): number {
  const estimatedUsd =
    APIFY_OPPORTUNITY_SOURCE_EVENT_PRICES_USD['apify-actor-start'] +
    maxPosts * APIFY_OPPORTUNITY_SOURCE_EVENT_PRICES_USD.post
  return Math.max(APIFY_MIN_CHARGE_USD, estimatedUsd) / APIFY_MILLIDOLLAR_USD
}

function datasetCeilingFor(maxChargeUsd: number): number {
  const available = Math.max(0, maxChargeUsd - APIFY_OPPORTUNITY_SOURCE_EVENT_PRICES_USD['apify-actor-start'])
  return Math.max(1, Math.min(100, Math.floor((available + 1e-9) / APIFY_OPPORTUNITY_SOURCE_EVENT_PRICES_USD.post)))
}

function receipt(
  outcome: Pick<
    ApifyRunOutcome,
    | 'actorId'
    | 'runId'
    | 'itemCount'
    | 'kind'
    | 'httpStatus'
    | 'requestUrl'
    | 'attemptedAt'
    | 'billingFinalized'
    | 'chargedEventCounts'
    | 'providerCostUsd'
    | 'pricingModel'
  >,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    actor_id: outcome.actorId,
    run_id: outcome.runId,
    actor_build: APIFY_OPPORTUNITY_SOURCE_ACTOR_BUILD,
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

function refusal(actorId: string, attemptedAt: string, error: string): AdapterResult<Candidate[]> {
  return {
    status: 'error',
    data: null,
    receipt: {
      actor_id: actorId,
      run_id: null,
      actor_build: APIFY_OPPORTUNITY_SOURCE_ACTOR_BUILD,
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

export function createApifyOpportunitySourceAdapter(deps: ApifyOpportunitySourceDeps = {}): SourceAdapter {
  const env = deps.env ?? processEnv()
  const now = deps.now ?? (() => new Date())
  const descriptor = apifyOpportunitySourceDescriptor(env)
  const runActor: OpportunitySourceRunActor =
    deps.runActor ??
    ((actorId, input, options) =>
      runActorWithFinalizedBilling(actorId, input, {
        token: options.token,
        build: options.build,
        timeoutMs: options.timeoutMs,
        maxItems: options.maxItems,
        maxChargeUsd: options.maxChargeUsd,
        datasetFields: options.datasetFields,
        maxDatasetBodyBytes: options.maxDatasetBodyBytes,
        now: options.now,
        fetchImpl: deps.fetchImpl,
        billingContract: APIFY_OPPORTUNITY_SOURCE_BILLING_CONTRACT,
        finalizationDelayMs: deps.finalizationDelayMs,
        sleep: deps.sleep,
      }))

  return {
    descriptor,
    quote(plan) {
      const maxCandidates = Math.max(0, Math.min(Math.floor(plan.max_candidates), APIFY_OPPORTUNITY_SOURCE_MAX_POSTS))
      const providerUnits = maxCandidates > 0 ? providerUnitsFor(maxCandidates) : 0
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
      const actorId = configuredActor(env)
      const coverage = capabilityCovers(descriptor, plan)
      if (!coverage.covered) {
        return refusal(actorId, attemptedAt, `unsupported_capability: ${coverage.reason ?? 'not covered'}`)
      }
      if (actorId !== APIFY_OPPORTUNITY_SOURCE_ACTOR_ID) {
        return refusal(actorId, attemptedAt, 'provider_disabled: post-search actor override is unapproved')
      }
      if (!apifyEnabled(env)) {
        return refusal(actorId, attemptedAt, `provider_disabled: ${APIFY_ENABLED_ENV} is not 'true'`)
      }
      const token = apifyToken(env)
      if (!token) {
        return refusal(
          actorId,
          attemptedAt,
          `provider_unconfigured: no Apify token configured (${APIFY_TOKEN_ENVS.join(' or ')})`,
        )
      }
      if (!apifyOpportunitySourceApproved(env)) {
        return refusal(actorId, attemptedAt, 'provider_disabled: post-search terms or price version is unapproved')
      }
      const maxCandidates = Math.max(0, Math.min(Math.floor(plan.max_candidates), APIFY_OPPORTUNITY_SOURCE_MAX_POSTS))
      if (maxCandidates <= 0) {
        return refusal(actorId, attemptedAt, 'bad_request: a positive opportunity cap is required')
      }
      const maxChargeUsd = Number(plan.max_charge_usd)
      if (!Number.isFinite(maxChargeUsd) || maxChargeUsd < APIFY_MIN_CHARGE_USD) {
        return refusal(actorId, attemptedAt, 'bad_request: a reservation-derived max charge is required')
      }
      let input: Record<string, unknown>
      try {
        input = buildApifyOpportunityInput({
          ...plan,
          max_candidates: maxCandidates,
        })
      } catch (error) {
        return refusal(actorId, attemptedAt, `bad_request: ${error instanceof Error ? error.message : String(error)}`)
      }
      const outcome = await runActor(actorId, input, {
        token,
        build: APIFY_OPPORTUNITY_SOURCE_ACTOR_BUILD,
        timeoutMs: timeoutMs(env),
        maxItems: datasetCeilingFor(maxChargeUsd),
        maxChargeUsd,
        datasetFields: [...APIFY_OPPORTUNITY_SOURCE_DATASET_FIELDS],
        maxDatasetBodyBytes: APIFY_OPPORTUNITY_SOURCE_DATASET_BYTES,
        now,
      })
      const providerReceipt = (extras: Record<string, unknown> = {}) =>
        receipt(outcome, {
          max_charge_usd: maxChargeUsd,
          max_opportunities: maxCandidates,
          query: providerQueryText(plan),
          comments_scraped: false,
          reactions_scraped: false,
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
          error: 'provider_billing_unknown: post-search receipt was not finalized',
        }
      }
      const counts = outcome.chargedEventCounts ?? {}
      const unknownCharge = Object.entries(counts).find(
        ([event, count]) => count > 0 && !(event in APIFY_OPPORTUNITY_SOURCE_EVENT_PRICES_USD),
      )
      if (unknownCharge) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({
            unexpected_charge_event: unknownCharge[0],
          }),
          cost_units: null,
          error: 'provider_billing_unknown: an unapproved post-search event was charged',
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
      if ((counts.post ?? 0) !== outcome.itemCount) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({ billed_posts: counts.post ?? 0 }),
          cost_units: null,
          error: 'invalid_schema: billed post count did not match the bounded dataset',
        }
      }
      const candidates = outcome.items
        .map((item) =>
          normalizeApifyOpportunityItem(item, {
            attemptedAt: outcome.attemptedAt,
            query: providerQueryText(plan),
            requestedLocation: providerLocationText(plan),
          }),
        )
        .filter((candidate): candidate is Candidate => candidate != null)
      if (candidates.length === 0) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({ parser_dropped_rows: outcome.itemCount }),
          cost_units: null,
          error: 'invalid_schema: provider posts contained no safe public opportunity',
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
          billed_posts: counts.post ?? 0,
        }),
        cost_units: costUnits,
      }
    },
  }
}
