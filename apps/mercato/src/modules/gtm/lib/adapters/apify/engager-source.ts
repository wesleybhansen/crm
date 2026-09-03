import {
  capabilityCovers,
  type AdapterDescriptor,
  type AdapterResult,
  type Candidate,
  type SourceAdapter,
  type SourceSearchPlan,
} from '../types'
import { creditsFromUsd } from '../../credits/markup'
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
  APIFY_ACTORS,
  extractSearchQuery,
  normalizeItems,
  postedLimitFromRecencyWindow,
} from './actors'
import {
  APIFY_LINKEDIN_ENGAGER_ADAPTER_ID,
  APIFY_LINKEDIN_REACTOR_ADAPTER_ID,
  LINKEDIN_ENGAGER_QUERY_CONTRACT_VERSION,
  linkedinEngagerQueryContract,
  type LinkedInEngagementKind,
} from '../../research/linkedin-engagement'
import {
  APIFY_DEFAULT_TIMEOUT_MS,
  APIFY_MIN_CHARGE_USD,
  runActorWithFinalizedBilling,
  type ApifyFetchLike,
  type ApifyFinalizedBillingContract,
  type ApifyRunOutcome,
} from './client'

/*
 * LinkedIn commenter and reactor discovery for social-engagement PEOPLE plays.
 *
 * This is intentionally separate from both older URL-supplied comment
 * scraping and public demand-opportunity discovery. It discovers public posts
 * from a frozen play query. Comments and reactions are distinct adapters,
 * quotes, receipts, and feature gates: a lower-intent reaction can never be
 * represented or billed as a higher-intent comment.
 *
 * Consumer records remain manual-only under policy.ts. This adapter never
 * sends, connects, or infers consent; it provides a public profile and the
 * public post that supports the result.
 */

export {
  APIFY_LINKEDIN_ENGAGER_ADAPTER_ID,
  APIFY_LINKEDIN_REACTOR_ADAPTER_ID,
  LINKEDIN_ENGAGER_QUERY_CONTRACT_VERSION,
}
export const APIFY_LINKEDIN_ENGAGER_SIGNAL = 'social_engagement'
export const APIFY_LINKEDIN_ENGAGER_ACTOR_ID = 'harvestapi/linkedin-post-search'
export const APIFY_LINKEDIN_ENGAGER_ACTOR_BUILD = '0.0.104'
export const APIFY_LINKEDIN_ENGAGER_ENABLED_ENV = 'GTM_APIFY_LINKEDIN_ENGAGER_ENABLED'
export const APIFY_LINKEDIN_REACTOR_ENABLED_ENV = 'GTM_APIFY_LINKEDIN_REACTOR_ENABLED'
export const APIFY_LINKEDIN_ENGAGER_ACTOR_ENV = 'GTM_APIFY_ACTOR_LINKEDIN_POST_SEARCH'
export const APIFY_LINKEDIN_ENGAGER_PRICE_VERSION_ENV = 'GTM_APIFY_LINKEDIN_ENGAGER_PRICE_VERSION'
export const APIFY_LINKEDIN_ENGAGER_REQUIRED_PRICE_VERSION =
  'harvestapi-linkedin-post-search-0.0.104-bronze-engagement-events-2026-09-02'

export const APIFY_LINKEDIN_ENGAGER_MAX_PEOPLE = 25
export const APIFY_LINKEDIN_ENGAGER_MAX_POSTS = 5
export const APIFY_LINKEDIN_ENGAGER_DATASET_BYTES = 2_000_000
export const APIFY_LINKEDIN_ENGAGER_DATASET_FIELDS = [
  'type',
  'id',
  'linkedinUrl',
  'content',
  'comments',
  'reactions',
  'actor',
  'commentary',
  'postId',
] as const

// Official Actor pricing and build metadata rechecked through Apify's public
// Actor API on 2026-09-01 for the BRONZE account tier.
export const APIFY_LINKEDIN_ENGAGER_EVENT_PRICES_USD = {
  'apify-actor-start': 0.00005,
  post: 0.002,
  comment: 0.002,
  reaction: 0.002,
  'no-result': 0.001,
} as const

const APIFY_MILLIDOLLAR_USD = 0.001
const BILLING_CONTRACT: ApifyFinalizedBillingContract = {
  pricingModel: 'PAY_PER_EVENT',
  eventPricesUsd: APIFY_LINKEDIN_ENGAGER_EVENT_PRICES_USD,
}

type EngagerEnv = Record<string, string | undefined>
type EngagerRunActor = (
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

export type ApifyLinkedInEngagerDeps = {
  env?: EngagerEnv
  now?: () => Date
  runActor?: EngagerRunActor
  fetchImpl?: ApifyFetchLike
  finalizationDelayMs?: number
  sleep?: (delayMs: number) => Promise<void>
}

function processEnv(): EngagerEnv {
  return process.env as unknown as EngagerEnv
}

function configuredActor(env: EngagerEnv): string {
  return (env[APIFY_LINKEDIN_ENGAGER_ACTOR_ENV] ?? '').trim() || APIFY_LINKEDIN_ENGAGER_ACTOR_ID
}

function timeoutMs(env: EngagerEnv): number {
  const value = Number(env[APIFY_TIMEOUT_MS_ENV])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : APIFY_DEFAULT_TIMEOUT_MS
}

export function apifyLinkedInEngagerApproved(env: EngagerEnv = processEnv()): boolean {
  return (
    apifyCustomerUseApproved(env) &&
    configuredActor(env) === APIFY_LINKEDIN_ENGAGER_ACTOR_ID &&
    (env[APIFY_LINKEDIN_ENGAGER_PRICE_VERSION_ENV] ?? '').trim() ===
      APIFY_LINKEDIN_ENGAGER_REQUIRED_PRICE_VERSION
  )
}

export function apifyLinkedInEngagerEnabled(env: EngagerEnv = processEnv()): boolean {
  return (
    env[APIFY_LINKEDIN_ENGAGER_ENABLED_ENV] === 'true' &&
    apifyEnabled(env) &&
    apifyToken(env) !== null &&
    apifyLinkedInEngagerApproved(env)
  )
}

export function apifyLinkedInReactorEnabled(env: EngagerEnv = processEnv()): boolean {
  return (
    env[APIFY_LINKEDIN_REACTOR_ENABLED_ENV] === 'true' &&
    apifyEnabled(env) &&
    apifyToken(env) !== null &&
    apifyLinkedInEngagerApproved(env)
  )
}

function descriptorFor(
  engagementKind: LinkedInEngagementKind,
  env: EngagerEnv = processEnv(),
): AdapterDescriptor {
  const approved = apifyLinkedInEngagerApproved(env)
  return {
    contract_version: '2',
    adapter_id:
      engagementKind === 'comment'
        ? APIFY_LINKEDIN_ENGAGER_ADAPTER_ID
        : APIFY_LINKEDIN_REACTOR_ADAPTER_ID,
    layer: 'source',
    capabilities: [
      {
        signal_kind: APIFY_LINKEDIN_ENGAGER_SIGNAL,
        entity_units: ['people'],
        geographies: ['US'],
        channels: ['linkedin'],
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
        // Business only (review 2026-09-02, H3). Consumer audience rights
        // require a per-subject provider deletion path; none exists for a
        // marketplace actor run (privacy/deletion.ts reports every Apify
        // provider as not_supported), so the consumer flags below stay off
        // until SPEC-069 rights are backed by an implementation.
        audience_modes: ['business'],
        manual_outreach_allowed: approved,
        automated_email_allowed: false,
        public_profile_contact_allowed: false,
        public_opportunity_use_allowed: false,
      },
      rate_limits: { requests_per_minute: 30, concurrent: 1 },
      max_batch: APIFY_LINKEDIN_ENGAGER_MAX_PEOPLE,
    },
    cost_model: {
      unit: 'apify_millidollar',
      quoted_credits_per_unit: creditsFromUsd(APIFY_MILLIDOLLAR_USD),
      price_version: (env[APIFY_LINKEDIN_ENGAGER_PRICE_VERSION_ENV] ?? '').trim() || 'unapproved',
      pay_on_found: false,
    },
    evidence_policy: {
      source_url: 'required',
      observed_at: 'required',
      max_age_days: 30,
      min_confidence: 0.8,
    },
    ambiguity_contract: {
      timeout_is_ambiguous: true,
      receipt_fields: ['actor_id', 'run_id', 'item_count', 'charged_event_counts'],
    },
    // No per-subject deletion endpoint exists on a marketplace actor run, and
    // no code implemented one when this read `true`: the flag alone unlocked
    // the consumer audience gate in adapterAudienceRights (review 2026-09-02,
    // H3). Set to what the DSR executor can actually do.
    dsr: { deletion_supported: false },
  }
}

export function apifyLinkedInEngagerDescriptor(env: EngagerEnv = processEnv()): AdapterDescriptor {
  return descriptorFor('comment', env)
}

export function apifyLinkedInReactorDescriptor(env: EngagerEnv = processEnv()): AdapterDescriptor {
  return descriptorFor('reaction', env)
}

function normalizedQuery(plan: SourceSearchPlan): string {
  const contract = linkedinEngagerQueryContract(plan.provider_query)
  if (!contract.ok) throw new TypeError(contract.reason)
  return contract.value.query
}

function requestedPosts(maxCandidates: number): number {
  return Math.max(1, Math.min(APIFY_LINKEDIN_ENGAGER_MAX_POSTS, Math.ceil(maxCandidates / 5)))
}

function requestedComments(maxCandidates: number, maxPosts: number): number {
  return Math.max(1, Math.ceil(maxCandidates / maxPosts))
}

export function buildApifyLinkedInEngagerInput(plan: SourceSearchPlan): Record<string, unknown> {
  const contract = linkedinEngagerQueryContract(plan.provider_query)
  if (!contract.ok) throw new TypeError(contract.reason)
  const query = contract.value.query
  const recency = typeof plan.provider_query?.recency_window === 'string'
    ? plan.provider_query.recency_window
    : null
  const parsed = extractSearchQuery(`${query} recency:${postedLimitFromRecencyWindow(recency)}`)
  if (!parsed.ok) throw new TypeError(parsed.reason)
  const maxCandidates = Math.max(1, Math.min(Math.floor(plan.max_candidates), APIFY_LINKEDIN_ENGAGER_MAX_PEOPLE))
  const maxPosts = requestedPosts(maxCandidates)
  const input: Record<string, unknown> = {
    searchQueries: [parsed.search.keywords],
    maxPosts,
    postedLimit: parsed.search.postedLimit,
    sortBy: 'relevance',
  }
  if (contract.value.engagementKind === 'comment') {
    return {
      ...input,
      scrapeComments: true,
      postNestedComments: true,
      maxComments: requestedComments(maxCandidates, maxPosts),
      commentsProfileScraperMode: 'short',
      scrapeReactions: false,
      postNestedReactions: false,
    }
  }
  return {
    ...input,
    scrapeComments: false,
    postNestedComments: false,
    scrapeReactions: true,
    postNestedReactions: true,
    maxReactions: requestedComments(maxCandidates, maxPosts),
    reactionsProfileScraperMode: 'short',
  }
}

function providerUnitsFor(maxCandidates: number, engagementKind: LinkedInEngagementKind): number {
  const maxPosts = requestedPosts(maxCandidates)
  const estimatedUsd =
    APIFY_LINKEDIN_ENGAGER_EVENT_PRICES_USD['apify-actor-start'] +
    maxPosts * APIFY_LINKEDIN_ENGAGER_EVENT_PRICES_USD.post +
    maxCandidates * APIFY_LINKEDIN_ENGAGER_EVENT_PRICES_USD[engagementKind]
  return Math.max(APIFY_MIN_CHARGE_USD, estimatedUsd) / APIFY_MILLIDOLLAR_USD
}

function datasetCeilingFor(maxChargeUsd: number): number {
  const available = Math.max(0, maxChargeUsd - APIFY_LINKEDIN_ENGAGER_EVENT_PRICES_USD['apify-actor-start'])
  const cheapestItem = Math.min(
    APIFY_LINKEDIN_ENGAGER_EVENT_PRICES_USD.post,
    APIFY_LINKEDIN_ENGAGER_EVENT_PRICES_USD.comment,
    APIFY_LINKEDIN_ENGAGER_EVENT_PRICES_USD.reaction,
  )
  return Math.max(1, Math.min(100, Math.floor((available + 1e-9) / cheapestItem)))
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
    actor_build: APIFY_LINKEDIN_ENGAGER_ACTOR_BUILD,
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
      actor_build: APIFY_LINKEDIN_ENGAGER_ACTOR_BUILD,
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

function createAdapter(
  engagementKind: LinkedInEngagementKind,
  deps: ApifyLinkedInEngagerDeps = {},
): SourceAdapter {
  const env = deps.env ?? processEnv()
  const now = deps.now ?? (() => new Date())
  const descriptor = descriptorFor(engagementKind, env)
  const runActor: EngagerRunActor =
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
        billingContract: BILLING_CONTRACT,
        finalizationDelayMs: deps.finalizationDelayMs,
        sleep: deps.sleep,
      }))

  return {
    descriptor,
    quote(plan) {
      const contract = linkedinEngagerQueryContract(plan.provider_query)
      if (!contract.ok) throw new TypeError(contract.reason)
      if (contract.value.engagementKind !== engagementKind) {
        throw new TypeError(`LinkedIn ${engagementKind} adapter requires engagement_kind '${engagementKind}'`)
      }
      const maxCandidates = Math.max(
        0,
        Math.min(Math.floor(plan.max_candidates), APIFY_LINKEDIN_ENGAGER_MAX_PEOPLE),
      )
      const providerUnits = maxCandidates > 0 ? providerUnitsFor(maxCandidates, engagementKind) : 0
      return {
        max_candidates: maxCandidates,
        provider_units: providerUnits,
        billable_unit: descriptor.cost_model.unit,
        expected_candidates: { low: 0, high: maxCandidates, basis: 'provider_quote' },
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
      if (actorId !== APIFY_LINKEDIN_ENGAGER_ACTOR_ID) {
        return refusal(actorId, attemptedAt, 'provider_disabled: LinkedIn post-search actor override is unapproved')
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
      if (!apifyLinkedInEngagerApproved(env)) {
        return refusal(actorId, attemptedAt, 'provider_disabled: LinkedIn engager terms or price version is unapproved')
      }
      const maxCandidates = Math.max(
        0,
        Math.min(Math.floor(plan.max_candidates), APIFY_LINKEDIN_ENGAGER_MAX_PEOPLE),
      )
      if (maxCandidates <= 0) return refusal(actorId, attemptedAt, 'bad_request: a positive people cap is required')
      const maxChargeUsd = Number(plan.max_charge_usd)
      if (!Number.isFinite(maxChargeUsd) || maxChargeUsd < APIFY_MIN_CHARGE_USD) {
        return refusal(actorId, attemptedAt, 'bad_request: a reservation-derived max charge is required')
      }
      let input: Record<string, unknown>
      try {
        const contract = linkedinEngagerQueryContract(plan.provider_query)
        if (!contract.ok) throw new TypeError(contract.reason)
        if (contract.value.engagementKind !== engagementKind) {
          throw new TypeError(`LinkedIn ${engagementKind} adapter requires engagement_kind '${engagementKind}'`)
        }
        input = buildApifyLinkedInEngagerInput({ ...plan, max_candidates: maxCandidates })
      } catch (error) {
        return refusal(actorId, attemptedAt, `bad_request: ${error instanceof Error ? error.message : String(error)}`)
      }
      const outcome = await runActor(actorId, input, {
        token,
        build: APIFY_LINKEDIN_ENGAGER_ACTOR_BUILD,
        timeoutMs: timeoutMs(env),
        maxItems: datasetCeilingFor(maxChargeUsd),
        maxChargeUsd,
        datasetFields: [...APIFY_LINKEDIN_ENGAGER_DATASET_FIELDS],
        maxDatasetBodyBytes: APIFY_LINKEDIN_ENGAGER_DATASET_BYTES,
        now,
      })
      const providerReceipt = (extras: Record<string, unknown> = {}) => {
        const contract = linkedinEngagerQueryContract(plan.provider_query)
        return receipt(outcome, {
          max_charge_usd: maxChargeUsd,
          max_people: maxCandidates,
          query: normalizedQuery(plan),
          query_contract_version: LINKEDIN_ENGAGER_QUERY_CONTRACT_VERSION,
          engagement_topics: contract.ok ? contract.value.topics : [],
          engagement_kind: engagementKind,
          comments_scraped: engagementKind === 'comment',
          reactions_scraped: engagementKind === 'reaction',
          ...extras,
        })
      }
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
        const costUnits = outcome.billingFinalized && outcome.providerCostUsd != null
          ? outcome.providerCostUsd / APIFY_MILLIDOLLAR_USD
          : 0
        return {
          status: 'error',
          data: null,
          receipt: providerReceipt(),
          cost_units: costUnits,
          error: outcome.error ?? 'provider error',
        }
      }
      if (!outcome.billingFinalized || outcome.providerCostUsd == null) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt(),
          cost_units: null,
          error: 'provider_billing_unknown: LinkedIn engager receipt was not finalized',
        }
      }
      const counts = outcome.chargedEventCounts ?? {}
      const unexpectedCharge = Object.entries(counts).find(
        ([event, count]) => count > 0 && !(event in APIFY_LINKEDIN_ENGAGER_EVENT_PRICES_USD),
      )
      if (unexpectedCharge) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({ unexpected_charge_event: unexpectedCharge[0] }),
          cost_units: null,
          error: 'provider_billing_unknown: an unapproved LinkedIn engager event was charged',
        }
      }
      const offModeCharge = engagementKind === 'comment' ? counts.reaction : counts.comment
      if ((offModeCharge ?? 0) > 0) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({
            unexpected_engagement_charge: engagementKind === 'comment' ? 'reaction' : 'comment',
          }),
          cost_units: null,
          error: 'provider_billing_unknown: an off-contract LinkedIn engagement event was charged',
        }
      }
      const costUnits = outcome.providerCostUsd / APIFY_MILLIDOLLAR_USD
      if (outcome.status === 'no_result') {
        return { status: 'no_result', data: null, receipt: providerReceipt(), cost_units: costUnits }
      }
      const billedDatasetItems = (counts.post ?? 0) + (counts[engagementKind] ?? 0)
      if (billedDatasetItems !== outcome.itemCount) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({ billed_dataset_items: billedDatasetItems }),
          cost_units: null,
          error: `invalid_schema: billed post/${engagementKind} count did not match the bounded dataset`,
        }
      }
      const normalized = normalizeItems('linkedin_post_search', outcome.items, { observedAt: outcome.attemptedAt })
      const candidates = normalized.candidates
        .filter((candidate) => candidate.evidence.some(
          (row) => row.detail?.engagement_kind === engagementKind,
        ))
        .slice(0, maxCandidates)
      if (candidates.length === 0) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({ dropped_items: normalized.dropped }),
          cost_units: null,
          error: `invalid_schema: billed LinkedIn ${engagementKind}s produced no usable public identity`,
        }
      }
      return {
        status: normalized.dropped > 0 ? 'partial' : 'ok',
        data: candidates,
        receipt: providerReceipt({
          returned_count: candidates.length,
          dropped_items: normalized.dropped,
          skipped_child_rows: normalized.skippedChildRows ?? 0,
          truncated: normalized.candidates.length > candidates.length,
        }),
        cost_units: costUnits,
      }
    },
  }
}

export function createApifyLinkedInEngagerAdapter(deps: ApifyLinkedInEngagerDeps = {}): SourceAdapter {
  return createAdapter('comment', deps)
}

export function createApifyLinkedInReactorAdapter(deps: ApifyLinkedInEngagerDeps = {}): SourceAdapter {
  return createAdapter('reaction', deps)
}

// Guard the actor build used above against an accidental split from the
// shared normalizer's reviewed contract.
if (APIFY_ACTORS.linkedin_post_search.actorBuild !== APIFY_LINKEDIN_ENGAGER_ACTOR_BUILD) {
  throw new Error('LinkedIn engager actor build is not aligned with the reviewed post-search normalizer')
}
