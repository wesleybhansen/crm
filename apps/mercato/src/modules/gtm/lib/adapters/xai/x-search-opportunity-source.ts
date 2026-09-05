/*
 * Official xAI X Search demand-opportunity source (discovery lane).
 *
 * Contract (frozen 2026-09-02, verified against docs.x.ai on that date):
 * - POST https://api.x.ai/v1/responses with tools: [{ type: 'x_search' }].
 *   xAI executes the search server-side, returns the model's answer with
 *   `url_citation` annotations and a top-level `citations` list, and reports
 *   billed tool invocations in
 *   `usage.server_side_tool_usage_details.x_search_calls`.
 * - Price: $5 per 1,000 X Search calls plus model tokens (grok-4.3 $1.25 in /
 *   $2.50 out per million; grok-4.6 $2.00 / $6.00). Both facts are pinned by
 *   XAI_REQUIRED_PRICE_VERSION; a different env value fails closed.
 *
 * Evidence posture: the model's answer is NEVER evidence on its own. A post is
 * kept only when its x.com status URL appears in the provider's citation set
 * for this exact call. The post id is a Twitter snowflake, so its creation
 * time is derived deterministically from the URL, not from the model. When
 * the official X API hydration gate is on, every kept post is re-read through
 * GET /2/tweets (pay-per-use, $0.005 per returned post) and the official text,
 * timestamp, and public metrics replace the model transcript. Without
 * hydration the row is explicitly labeled a model transcript of a cited post
 * and carries a lower confidence.
 *
 * Cost posture: the agent decides how many searches to run, so exact spend is
 * unknown before the call. The quote is an explicit per-lane ceiling derived
 * from the frozen max_turns / max_output_tokens contract; the settled charge
 * comes only from the returned usage object. A missing usage object makes the
 * outcome ambiguous (never silently free, never retried).
 */

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
  assessSocialReturnedContent,
  boundedText,
  freshPublicPostTimestamp,
  isoDate,
  locationText,
  millidollarUnits,
  nonNegativeInteger,
  postDisplayName,
  publicOpportunityIdentity,
  queryText,
  record,
  requestedOpportunityIntent,
  returnedContentReasonCounts,
  unsafePublicContent,
  windowDays,
} from '../public-opportunity-shared'
import { calibratedOpportunityConfidence, classifyOpportunityIntent } from '../../research/opportunity-quality'

export const XAI_X_SEARCH_ADAPTER_ID = 'xai-x-search-demand-opportunities'
export const XAI_RESPONSES_URL = 'https://api.x.ai/v1/responses'
export const X_API_POSTS_LOOKUP_URL = 'https://api.x.com/2/tweets'

export const XAI_ENABLED_ENV = 'GTM_XAI_X_SEARCH_ENABLED'
export const XAI_API_KEY_ENV = 'GTM_XAI_API_KEY'
export const XAI_CUSTOMER_USE_ENV = 'GTM_XAI_CUSTOMER_USE_APPROVED'
export const XAI_TERMS_VERSION_ENV = 'GTM_XAI_TERMS_VERSION'
export const XAI_PRICE_VERSION_ENV = 'GTM_XAI_X_SEARCH_PRICE_VERSION'
export const XAI_MODEL_ENV = 'GTM_XAI_MODEL'
export const XAI_TIMEOUT_MS_ENV = 'GTM_XAI_TIMEOUT_MS'
export const X_API_HYDRATION_ENABLED_ENV = 'GTM_X_API_HYDRATION_ENABLED'
export const X_API_BEARER_TOKEN_ENV = 'GTM_X_API_BEARER_TOKEN'
export const X_API_CUSTOMER_USE_ENV = 'GTM_X_API_CUSTOMER_USE_APPROVED'
export const X_API_PRICE_VERSION_ENV = 'GTM_X_API_PRICE_VERSION'

export const XAI_REQUIRED_TERMS_VERSION = 'xai-api-terms-2026-09-02'
export const XAI_REQUIRED_PRICE_VERSION = 'xai-x-search-5usd-per-1000-calls-grok-4.3-1.25in-2.50out-per-m-2026-09-02'
export const X_API_REQUIRED_PRICE_VERSION = 'x-api-pay-per-use-post-read-0.005-2026-09-02'
export const XAI_X_SEARCH_CONTRACT_VERSION = 'official-x-search-v1'

export const XAI_X_SEARCH_USD_PER_CALL = 0.005
export const X_API_USD_PER_POST_READ = 0.005
export const XAI_MILLIDOLLAR_USD = 0.001
export const XAI_DEFAULT_MODEL = 'grok-4.3'
export const XAI_MAX_TURNS = 3
export const XAI_MAX_OUTPUT_TOKENS = 2_000
export const XAI_MAX_RESULTS = 10
export const XAI_DEFAULT_TIMEOUT_MS = 90_000
// Quote ceiling assumptions (frozen with the price version). Two agent turns
// can each run several parallel searches; six billed calls is the observed
// upper bound the ceiling reserves for. Search results are injected into the
// context as input tokens, which is the dominant token cost.
export const XAI_CEILING_X_SEARCH_CALLS = 6
export const XAI_CEILING_INPUT_TOKENS = 40_000
export const XAI_RETENTION_DAYS = 30

export const XAI_MODEL_PRICES_USD_PER_MILLION: Record<string, { input: number; output: number }> = {
  'grok-4.3': { input: 1.25, output: 2.5 },
  'grok-4.6': { input: 2.0, output: 6.0 },
}

const RECEIPT_FIELDS = [
  'provider_request_id',
  'provider_status',
  'model',
  'x_search_calls',
  'input_tokens',
  'output_tokens',
  'provider_cost_usd',
  'hydration_post_reads',
  'hydration_cost_usd',
  'citation_count',
  'search_query',
  'provider_failure_class',
]

type XaiEnv = Record<string, string | undefined>
type XaiFetch = typeof fetch

export type XaiXSearchDeps = {
  env?: XaiEnv
  fetchImpl?: XaiFetch
  now?: () => Date
}

function envValue(env: XaiEnv, name: string): string {
  return (env[name] ?? '').trim()
}

export function xaiModel(env: XaiEnv = process.env): string {
  const requested = envValue(env, XAI_MODEL_ENV) || XAI_DEFAULT_MODEL
  return requested in XAI_MODEL_PRICES_USD_PER_MILLION ? requested : ''
}

export function xaiXSearchApproved(env: XaiEnv = process.env): boolean {
  return (
    envValue(env, XAI_CUSTOMER_USE_ENV) === 'true'
    && envValue(env, XAI_TERMS_VERSION_ENV) === XAI_REQUIRED_TERMS_VERSION
    && envValue(env, XAI_PRICE_VERSION_ENV) === XAI_REQUIRED_PRICE_VERSION
    && xaiModel(env) !== ''
  )
}

export function xaiXSearchEnabled(env: XaiEnv = process.env): boolean {
  return (
    envValue(env, XAI_ENABLED_ENV) === 'true'
    && Boolean(envValue(env, XAI_API_KEY_ENV))
    && xaiXSearchApproved(env)
  )
}

/** Official X API record hydration is a separately gated sub-capability. A
 *  partially configured gate never hydrates (and never charges). */
export function xApiHydrationEnabled(env: XaiEnv = process.env): boolean {
  return (
    envValue(env, X_API_HYDRATION_ENABLED_ENV) === 'true'
    && Boolean(envValue(env, X_API_BEARER_TOKEN_ENV))
    && envValue(env, X_API_CUSTOMER_USE_ENV) === 'true'
    && envValue(env, X_API_PRICE_VERSION_ENV) === X_API_REQUIRED_PRICE_VERSION
  )
}

function timeoutMs(env: XaiEnv): number {
  const parsed = Number(envValue(env, XAI_TIMEOUT_MS_ENV))
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : XAI_DEFAULT_TIMEOUT_MS
}

/** Per-lane provider ceiling in USD for the configured model. */
export function xaiLaneCeilingUsd(env: XaiEnv = process.env, hydratedPosts = 0): number {
  const model = xaiModel(env) || XAI_DEFAULT_MODEL
  const prices = XAI_MODEL_PRICES_USD_PER_MILLION[model] ?? XAI_MODEL_PRICES_USD_PER_MILLION[XAI_DEFAULT_MODEL]!
  const search = XAI_CEILING_X_SEARCH_CALLS * XAI_X_SEARCH_USD_PER_CALL
  const tokens =
    (XAI_CEILING_INPUT_TOKENS * prices.input + XAI_MAX_OUTPUT_TOKENS * prices.output) / 1_000_000
  const hydration = hydratedPosts * X_API_USD_PER_POST_READ
  return Math.round((search + tokens + hydration) * 1e6) / 1e6
}

export function xaiXSearchDescriptor(env: XaiEnv = process.env): AdapterDescriptor {
  const approved = xaiXSearchApproved(env)
  const hydration = xApiHydrationEnabled(env)
  return {
    contract_version: '2',
    adapter_id: XAI_X_SEARCH_ADAPTER_ID,
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
        terms_version: envValue(env, XAI_TERMS_VERSION_ENV) || 'unapproved',
        export: approved,
        customer_display: approved,
        outreach_allowed: approved,
        retention_days: XAI_RETENTION_DAYS,
        audience_modes: ['business', 'consumer'],
        manual_outreach_allowed: approved,
        automated_email_allowed: false,
        public_profile_contact_allowed: approved,
        public_opportunity_use_allowed: approved,
      },
      rate_limits: { requests_per_minute: 20, concurrent: 2 },
      max_batch: XAI_MAX_RESULTS,
    },
    cost_model: {
      unit: 'xai_millidollar',
      quoted_credits_per_unit: creditsFromUsd(XAI_MILLIDOLLAR_USD),
      // Both frozen price facts travel in one identifier so a change to
      // either the xAI rate card or the X API read price re-quotes every plan.
      price_version: approved
        ? `${envValue(env, XAI_PRICE_VERSION_ENV)}${hydration ? `+${envValue(env, X_API_PRICE_VERSION_ENV)}` : ''}`
        : 'unapproved',
      pay_on_found: false,
    },
    evidence_policy: {
      source_url: 'required',
      observed_at: 'required',
      max_age_days: XAI_RETENTION_DAYS,
      min_confidence: 0.7,
    },
    ambiguity_contract: {
      timeout_is_ambiguous: true,
      receipt_fields: RECEIPT_FIELDS,
    },
    dsr: { deletion_supported: true },
  }
}

// ---------------------------------------------------------------------------
// X status URL handling
// ---------------------------------------------------------------------------

const X_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com', 'mobile.x.com'])
const TWITTER_EPOCH_MS = BigInt('1288834974657')
const SNOWFLAKE_TIME_SHIFT = BigInt(22)

export type XStatusRef = { id: string; handle: string | null; url: string }

/** Canonical https://x.com/<handle>/status/<id> reference, or null for any
 *  URL that is not an X post. `/i/status/<id>` and `/i/web/status/<id>` are
 *  accepted with a null handle. */
export function parseXStatusUrl(value: unknown): XStatusRef | null {
  const raw = boundedText(value, 2_000)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (!X_HOSTS.has(host)) return null
    const parts = url.pathname.split('/').filter(Boolean)
    const statusIndex = parts.findIndex((part) => part === 'status' || part === 'statuses')
    if (statusIndex < 0) return null
    const id = parts[statusIndex + 1] ?? ''
    if (!/^\d{5,25}$/.test(id)) return null
    const first = parts[0] ?? ''
    const handle = statusIndex === 1 && /^[A-Za-z0-9_]{1,15}$/.test(first) && first.toLowerCase() !== 'i'
      ? first
      : null
    return {
      id,
      handle,
      url: handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/status/${id}`,
    }
  } catch {
    return null
  }
}

/** Post creation time derived from the snowflake id. Deterministic and
 *  independent of anything the model says. */
export function snowflakeTimestamp(id: string): string | null {
  if (!/^\d+$/.test(id)) return null
  try {
    const ms = (BigInt(id) >> SNOWFLAKE_TIME_SHIFT) + TWITTER_EPOCH_MS
    const date = new Date(Number(ms))
    if (!Number.isFinite(date.getTime())) return null
    // Anything at or within a day of the epoch is a tiny non-snowflake id.
    if (date.getTime() <= Number(TWITTER_EPOCH_MS) + 86_400_000) return null
    return date.toISOString()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export type XaiParsedResponse = {
  requestId: string | null
  status: string | null
  model: string | null
  text: string
  citedIds: Set<string>
  citedRefs: Map<string, XStatusRef>
  citationCount: number
  xSearchCalls: number | null
  inputTokens: number | null
  outputTokens: number | null
}

export function parseXaiResponse(body: unknown, headerRequestId: string | null): XaiParsedResponse {
  const root = record(body) ?? {}
  const citedRefs = new Map<string, XStatusRef>()
  let citationCount = 0
  const addCitation = (value: unknown) => {
    const ref = parseXStatusUrl(value)
    citationCount += 1
    if (ref && !citedRefs.has(ref.id)) citedRefs.set(ref.id, ref)
    else if (ref && ref.handle && !citedRefs.get(ref.id)?.handle) citedRefs.set(ref.id, ref)
  }
  const citations = Array.isArray(root.citations) ? root.citations : []
  for (const citation of citations) {
    if (typeof citation === 'string') addCitation(citation)
    else addCitation(record(citation)?.url)
  }
  const texts: string[] = []
  let xSearchCallItems = 0
  const output = Array.isArray(root.output) ? root.output : []
  for (const item of output) {
    const row = record(item)
    if (!row) continue
    if (row.type === 'x_search_call') xSearchCallItems += 1
    if (row.type !== 'message') continue
    const content = Array.isArray(row.content) ? row.content : []
    for (const part of content) {
      const block = record(part)
      if (!block || block.type !== 'output_text') continue
      if (typeof block.text === 'string') texts.push(block.text)
      const annotations = Array.isArray(block.annotations) ? block.annotations : []
      for (const annotation of annotations) {
        const note = record(annotation)
        if (note?.type === 'url_citation') addCitation(note.url)
      }
    }
  }
  const usage = record(root.usage)
  const toolUsage = record(usage?.server_side_tool_usage_details)
  const reportedCalls = toolUsage && Number.isSafeInteger(Number(toolUsage.x_search_calls))
    ? nonNegativeInteger(toolUsage.x_search_calls)
    : null
  return {
    requestId: boundedText(root.id, 200) ?? headerRequestId,
    status: boundedText(root.status, 40),
    model: boundedText(root.model, 80),
    text: texts.join('\n'),
    citedIds: new Set(citedRefs.keys()),
    citedRefs,
    citationCount,
    // The billed count is authoritative; the output items are only a floor
    // used when the usage block omits the tool breakdown.
    xSearchCalls: reportedCalls ?? (usage ? xSearchCallItems : null),
    inputTokens: usage && Number.isFinite(Number(usage.input_tokens)) ? nonNegativeInteger(usage.input_tokens) : null,
    outputTokens: usage && Number.isFinite(Number(usage.output_tokens)) ? nonNegativeInteger(usage.output_tokens) : null,
  }
}

export type ModelPostClaim = { url: string; text: string | null; handle: string | null }

/** Lenient extraction of the JSON post list from the model text. Anything
 *  that is not a well-formed x.com status URL is dropped here; citation
 *  cross-validation happens in the adapter. */
export function extractModelPosts(text: string): ModelPostClaim[] {
  const claims: ModelPostClaim[] = []
  const seen = new Set<string>()
  const push = (url: unknown, body: unknown, handle: unknown) => {
    const ref = parseXStatusUrl(url)
    if (!ref || seen.has(ref.id)) return
    seen.add(ref.id)
    claims.push({
      url: ref.url,
      text: boundedText(body, 800),
      handle: ref.handle ?? (boundedText(handle, 15)?.replace(/^@/, '') ?? null),
    })
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
      const posts = record(parsed)?.posts
      if (Array.isArray(posts)) {
        for (const item of posts) {
          const row = record(item)
          if (row) push(row.url, row.text, row.handle)
        }
      }
    } catch {
      // fall through to the URL scan below
    }
  }
  if (claims.length === 0) {
    for (const match of text.matchAll(/https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^\s)\]"'<>]+/g)) {
      push(match[0], null, null)
    }
  }
  return claims
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const INTENT_GUIDANCE: Record<string, { goal: string; phrases: string }> = {
  buyer_intent: {
    goal: 'the author appears to be personally buying, searching for, or about to move into a home in or around the area',
    phrases: '"house hunting", "looking at houses", "looking to buy a house", "put in an offer", "under contract", "got pre-approved", "first house", "closing on our house", "moving to <market>"',
  },
  seller_intent: {
    goal: 'the author appears to be personally selling, listing, or deciding whether to sell their home in or around the area',
    phrases: '"selling my house", "selling our home", "listing our house", "thinking about selling", "what is my house worth", "need to sell before we move", "moving out of <market>"',
  },
  mixed_intent: {
    goal: 'the author appears to be personally selling one home and buying another, or planning a move that involves both, in or around the area',
    phrases: '"sell before we buy", "sell and buy", "upsizing", "downsizing", "moving up", "next house", "moving to <market>"',
  },
  local_audience: {
    goal: 'the author is a local homeowner or resident talking about neighborhood life, community events, HOA matters, or housing workshops in the area',
    phrases: '"our neighborhood", "HOA", "homeowners meeting", "homebuyer workshop", "first-time buyer class", "neighbors in <market>"',
  },
}

const GENERIC_GUIDANCE = {
  goal: 'the author personally expresses the need or interest described in the search topic',
  phrases: 'quoted first-person phrases people would actually write about the topic',
}

/* The INTENT_GUIDANCE table above is the realtor calibration: "house hunting",
 * "selling my house", "HOA". It used to apply to ANY play that named an intent
 * lane, so a founder-audience play with buyer_intent sent the agent looking for
 * home buyers, and the run of 2026-09-05 came back with house-hunting posts for
 * an incubator. The realtor table is now used only when the lane carries the
 * realtor returned-content contract. Every other play gets guidance built from
 * its own keywords, which the lanes now pass through. */
const GENERIC_LANE_GOAL: Record<string, string> = {
  buyer_intent: 'the author personally wants, is looking for, or is asking how to get what the search topic describes',
  seller_intent: 'the author is personally trying to sell, offload, or find a buyer for what the search topic describes',
  mixed_intent: 'the author is personally in the middle of the situation the search topic describes and asking about it',
  local_audience: 'the author is taking part in, asking about, or organising a public group, event, or community around the search topic',
}

function isRealtorLane(plan: SourceSearchPlan): boolean {
  return plan.provider_query?.social_returned_content_filter_version === 'realtor-public-post-v2'
}

function genericGuidance(plan: SourceSearchPlan, intent: string | null): { goal: string; phrases: string } {
  const keywords = Array.isArray(plan.provider_query?.generic_filter_keywords)
    ? (plan.provider_query!.generic_filter_keywords as unknown[])
        .filter((value): value is string => typeof value === 'string' && value.trim().length >= 3)
        .slice(0, 6)
    : []
  const phrases = keywords.length > 0
    ? keywords.map((keyword) => `"${keyword.trim()}"`).join(', ')
    : GENERIC_GUIDANCE.phrases
  const goal = (intent && GENERIC_LANE_GOAL[intent]) || GENERIC_GUIDANCE.goal
  return { goal, phrases }
}

/*
 * The model decides how to search, so the prompt teaches it what worked in
 * the owner calibration (2026-09-03): several searches, latest first, replies
 * included, first-person phrase variants bound to the market, personal
 * accounts over businesses, and recall over precision because fit-v7 and a
 * human review make the final call downstream. The restrictive first version
 * of this prompt returned zero posts on lanes where the search itself had
 * surfaced real buyers.
 */
export function buildXSearchPrompt(plan: SourceSearchPlan, query: string, maxResults: number): string {
  const location = locationText(plan)
  const intent = requestedOpportunityIntent(plan)
  const guidance = isRealtorLane(plan) && intent && INTENT_GUIDANCE[intent]
    ? INTENT_GUIDANCE[intent]
    : genericGuidance(plan, intent)
  const market = location ? location.split(',')[0]?.trim() || location : 'the area'
  const phrases = guidance.phrases.replace(/<market>/g, market)
  return [
    `You are a research assistant finding recent public X posts by ordinary people. Use the X search tool several times (you have up to ${XAI_MAX_TURNS} turns): search in Latest mode, include replies, and try distinct first-person phrasings such as ${phrases}${location ? ` combined with ${market} or its nearby suburbs` : ''}. Prefer posts from personal accounts over businesses.`,
    `Search topic: ${query}`,
    location ? `Geography: ${location}.` : '',
    `Goal: posts where ${guidance.goal} within the last ${windowDays(plan)} days. Include a post when it is plausibly relevant; do not require certainty, a downstream human review makes the final call. Exclude agents, brokers, lenders, listing feeds, advertisers, news accounts, market commentary, and bots.`,
    'Skip posts about bereavement, divorce, foreclosure, bankruptcy, medical or financial hardship, or other sensitive personal circumstances.',
    `Return ONLY a JSON object of the form {"posts":[{"url":"https://x.com/<handle>/status/<id>","handle":"<handle>","text":"<verbatim post text, max 500 chars>","first_person":true,"location_evidence":"<the words that place the author in the area>","why":"<one sentence>"}]} with up to ${maxResults} posts, most relevant first.`,
    'Only include posts you actually retrieved with the X search tool. Never invent, paraphrase, or guess URLs. If nothing at all is relevant return {"posts":[]}.',
  ].filter(Boolean).join('\n')
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

type HydratedPost = {
  id: string
  text: string | null
  createdAt: string | null
  engagement: number
  conversationId: string | null
  lang: string | null
  possiblySensitive: boolean
}

type HydrationOutcome =
  | { status: 'ok'; posts: Map<string, HydratedPost>; returned: number; requestId: string | null }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; reason: string; httpStatus: number | null }
  | { status: 'ambiguous'; reason: string }

async function hydrateThroughXApi(
  ids: string[],
  env: XaiEnv,
  fetchImpl: XaiFetch,
  timeout: number,
): Promise<HydrationOutcome> {
  if (!xApiHydrationEnabled(env)) return { status: 'skipped', reason: 'x_api_hydration_disabled' }
  if (ids.length === 0) return { status: 'skipped', reason: 'no_cited_posts' }
  const url = new URL(X_API_POSTS_LOOKUP_URL)
  url.searchParams.set('ids', ids.slice(0, 100).join(','))
  // No user expansions: a user object is a separately billed "User read".
  url.searchParams.set('tweet.fields', 'created_at,public_metrics,conversation_id,lang,possibly_sensitive,author_id')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${envValue(env, X_API_BEARER_TOKEN_ENV)}` },
      signal: controller.signal,
    })
    const requestId = response.headers.get('x-transaction-id') ?? response.headers.get('x-request-id')
    if (response.status === 401 || response.status === 403) {
      return { status: 'error', reason: `x_api_unauthorized_${response.status}`, httpStatus: response.status }
    }
    if (response.status === 429) {
      return { status: 'error', reason: 'x_api_rate_limited', httpStatus: 429 }
    }
    if (response.status >= 500) {
      // A 5xx after the request may or may not have been metered.
      return { status: 'ambiguous', reason: `x_api_server_error_${response.status}` }
    }
    const body = record(await response.json().catch(() => null))
    if (!response.ok || !body) {
      return { status: 'error', reason: `x_api_http_${response.status}`, httpStatus: response.status }
    }
    const posts = new Map<string, HydratedPost>()
    const data = Array.isArray(body.data) ? body.data : []
    for (const item of data) {
      const row = record(item)
      const id = boundedText(row?.id, 40)
      if (!row || !id) continue
      const metrics = record(row.public_metrics) ?? {}
      posts.set(id, {
        id,
        text: boundedText(row.text, 800),
        createdAt: boundedText(row.created_at, 40),
        engagement: Math.min(
          10_000_000,
          nonNegativeInteger(metrics.reply_count)
            + nonNegativeInteger(metrics.retweet_count)
            + nonNegativeInteger(metrics.repost_count)
            + nonNegativeInteger(metrics.like_count)
            + nonNegativeInteger(metrics.quote_count),
        ),
        conversationId: boundedText(row.conversation_id, 40),
        lang: boundedText(row.lang, 10),
        possiblySensitive: row.possibly_sensitive === true,
      })
    }
    return { status: 'ok', posts, returned: data.length, requestId }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { status: 'ambiguous', reason: 'x_api_timeout' }
    }
    return { status: 'ambiguous', reason: `x_api_transport: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    clearTimeout(timer)
  }
}

function usageCostUsd(parsed: XaiParsedResponse, model: string): number | null {
  if (parsed.inputTokens == null || parsed.outputTokens == null || parsed.xSearchCalls == null) return null
  const prices = XAI_MODEL_PRICES_USD_PER_MILLION[model]
  if (!prices) return null
  // Cached input tokens are cheaper, but the settled charge stays conservative
  // by pricing every input token at the full rate.
  const tokens = (parsed.inputTokens * prices.input + parsed.outputTokens * prices.output) / 1_000_000
  const searches = parsed.xSearchCalls * XAI_X_SEARCH_USD_PER_CALL
  return Math.round((tokens + searches) * 1e8) / 1e8
}

export function createXaiXSearchOpportunityAdapter(deps: XaiXSearchDeps = {}): SourceAdapter {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => new Date())
  const descriptor = xaiXSearchDescriptor(env)

  const baseReceipt = (extras: Record<string, unknown>) => ({
    provider_request_id: null,
    provider_status: null,
    model: xaiModel(env) || null,
    x_search_calls: null,
    input_tokens: null,
    output_tokens: null,
    provider_cost_usd: null,
    hydration_post_reads: 0,
    hydration_cost_usd: 0,
    citation_count: 0,
    search_query: null,
    provider_failure_class: null,
    contract_version: XAI_X_SEARCH_CONTRACT_VERSION,
    ...extras,
  })

  const refusal = (attemptedAt: string, error: string): AdapterResult<Candidate[]> => ({
    status: 'error',
    data: null,
    receipt: baseReceipt({ provider_failure_class: 'refused_before_provider_contact', attempted_at: attemptedAt }),
    cost_units: 0,
    error,
  })

  return {
    descriptor,
    quote(plan) {
      const maxCandidates = Math.max(0, Math.min(Math.floor(plan.max_candidates), XAI_MAX_RESULTS))
      const hydrated = xApiHydrationEnabled(env) ? maxCandidates : 0
      const providerUnits = maxCandidates > 0 ? millidollarUnits(xaiLaneCeilingUsd(env, hydrated), XAI_MILLIDOLLAR_USD) : 0
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
      const coverage = capabilityCovers(descriptor, plan)
      if (!coverage.covered) return refusal(attemptedAt, `unsupported_capability: ${coverage.reason ?? 'not covered'}`)
      if (!xaiXSearchEnabled(env)) {
        return refusal(attemptedAt, 'provider_disabled: xAI X Search switch, key, terms, price, or model gate is not approved')
      }
      if (plan.provider_query?.xai_x_search_contract_version !== XAI_X_SEARCH_CONTRACT_VERSION) {
        return refusal(attemptedAt, 'bad_request: plan was not frozen under the official X Search contract')
      }
      const maxCandidates = Math.max(0, Math.min(Math.floor(plan.max_candidates), XAI_MAX_RESULTS))
      if (maxCandidates <= 0) return refusal(attemptedAt, 'bad_request: a positive opportunity cap is required')
      const maxChargeUsd = Number(plan.max_charge_usd)
      const hydrationOn = xApiHydrationEnabled(env)
      const ceiling = xaiLaneCeilingUsd(env, hydrationOn ? maxCandidates : 0)
      if (!Number.isFinite(maxChargeUsd) || maxChargeUsd + 1e-9 < ceiling) {
        return refusal(attemptedAt, 'bad_request: reservation is below the frozen X Search lane ceiling')
      }
      let query: string
      try {
        query = queryText(plan, 240)
      } catch (error) {
        return refusal(attemptedAt, `bad_request: ${error instanceof Error ? error.message : String(error)}`)
      }
      const model = xaiModel(env)
      const days = windowDays(plan)
      const attempted = new Date(attemptedAt)
      const fromDate = isoDate(new Date(attempted.getTime() - days * 86_400_000))
      const toDate = isoDate(attempted)
      const requestBody = {
        model,
        input: [{ role: 'user', content: buildXSearchPrompt(plan, query, maxCandidates) }],
        tools: [{ type: 'x_search', from_date: fromDate, to_date: toDate }],
        max_turns: XAI_MAX_TURNS,
        max_output_tokens: XAI_MAX_OUTPUT_TOKENS,
        temperature: 0,
        store: false,
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs(env))
      let response: Response
      try {
        response = await fetchImpl(XAI_RESPONSES_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${envValue(env, XAI_API_KEY_ENV)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        })
      } catch (error) {
        clearTimeout(timer)
        const timeout = error instanceof Error && error.name === 'AbortError'
        return {
          status: 'ambiguous',
          data: null,
          receipt: baseReceipt({
            search_query: query,
            provider_failure_class: timeout ? 'timeout' : 'transport',
            attempted_at: attemptedAt,
          }),
          cost_units: null,
          error: timeout ? 'provider_timeout: xAI request timed out' : `provider_transport: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      clearTimeout(timer)
      const headerRequestId = response.headers.get('x-request-id')
      const rawBody = await response.json().catch(() => null)
      if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404 || response.status === 422 || response.status === 429) {
        return {
          status: 'error',
          data: null,
          receipt: baseReceipt({
            provider_request_id: headerRequestId,
            provider_status: response.status,
            search_query: query,
            provider_failure_class: response.status === 429 ? 'rate_limited' : 'rejected',
            provider_error: boundedText(record(rawBody)?.error ?? record(record(rawBody)?.error)?.message, 300),
            attempted_at: attemptedAt,
          }),
          cost_units: 0,
          error: `provider_rejected: xAI responded ${response.status}`,
        }
      }
      if (!response.ok || !rawBody) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: baseReceipt({
            provider_request_id: headerRequestId,
            provider_status: response.status,
            search_query: query,
            provider_failure_class: 'unknown_outcome',
            attempted_at: attemptedAt,
          }),
          cost_units: null,
          error: `provider_unknown: xAI responded ${response.status} without a readable body`,
        }
      }
      const parsed = parseXaiResponse(rawBody, headerRequestId)
      const providerCostUsd = usageCostUsd(parsed, model)
      const receiptCore = {
        provider_request_id: parsed.requestId,
        provider_status: response.status,
        provider_response_status: parsed.status,
        model: parsed.model ?? model,
        x_search_calls: parsed.xSearchCalls,
        input_tokens: parsed.inputTokens,
        output_tokens: parsed.outputTokens,
        provider_cost_usd: providerCostUsd,
        citation_count: parsed.citationCount,
        cited_x_posts: parsed.citedIds.size,
        search_query: query,
        window_days: days,
        max_charge_usd: maxChargeUsd,
        lane_ceiling_usd: ceiling,
        attempted_at: attemptedAt,
      }
      if (providerCostUsd == null) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: baseReceipt({ ...receiptCore, provider_failure_class: 'usage_unreported' }),
          cost_units: null,
          error: 'provider_billing_unknown: xAI usage block did not report tokens and search calls',
        }
      }
      if (parsed.model && parsed.model !== model && !parsed.model.startsWith(`${model}-`)) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: baseReceipt({ ...receiptCore, provider_failure_class: 'model_drift' }),
          cost_units: null,
          error: `provider_billing_unknown: xAI served ${parsed.model} instead of the priced ${model}`,
        }
      }
      let costUsd = providerCostUsd
      const claims = extractModelPosts(parsed.text)
      const cited = claims.filter((claim) => {
        const ref = parseXStatusUrl(claim.url)
        return ref != null && parsed.citedIds.has(ref.id)
      })
      const uncited = claims.length - cited.length

      // Optional deterministic record retrieval through the official X API.
      let hydration: HydrationOutcome = { status: 'skipped', reason: hydrationOn ? 'no_cited_posts' : 'x_api_hydration_disabled' }
      if (hydrationOn && cited.length > 0) {
        hydration = await hydrateThroughXApi(
          cited.slice(0, maxCandidates).map((claim) => parseXStatusUrl(claim.url)!.id),
          env,
          fetchImpl,
          timeoutMs(env),
        )
        if (hydration.status === 'ambiguous') {
          return {
            status: 'ambiguous',
            data: null,
            receipt: baseReceipt({ ...receiptCore, provider_failure_class: 'hydration_unknown', hydration_error: hydration.reason }),
            cost_units: null,
            error: `provider_billing_unknown: ${hydration.reason}`,
          }
        }
      }
      const hydratedPosts = hydration.status === 'ok' ? hydration.posts : new Map<string, HydratedPost>()
      const hydrationReads = hydration.status === 'ok' ? hydration.returned : 0
      const hydrationCostUsd = Math.round(hydrationReads * X_API_USD_PER_POST_READ * 1e8) / 1e8
      costUsd = Math.round((costUsd + hydrationCostUsd) * 1e8) / 1e8
      const costUnits = millidollarUnits(costUsd, XAI_MILLIDOLLAR_USD)
      const receipt = (extras: Record<string, unknown> = {}) => baseReceipt({
        ...receiptCore,
        provider_cost_usd: costUsd,
        xai_cost_usd: providerCostUsd,
        hydration_status: hydration.status,
        hydration_reason: hydration.status === 'ok' ? null : hydration.reason,
        hydration_post_reads: hydrationReads,
        hydration_cost_usd: hydrationCostUsd,
        hydration_request_id: hydration.status === 'ok' ? hydration.requestId : null,
        model_claimed_posts: claims.length,
        uncited_model_posts: uncited,
        provider_cost_exceeded_quote: costUsd > maxChargeUsd + 1e-9,
        ...extras,
      })

      const requestedLocation = locationText(plan)
      const expectedIntent = requestedOpportunityIntent(plan)
      const normalized: Candidate[] = []
      let parserDropped = 0
      for (const claim of cited) {
        const ref = parseXStatusUrl(claim.url)!
        const official = hydratedPosts.get(ref.id) ?? null
        if (hydration.status === 'ok' && !official) {
          // The provider definitively did not return this id (deleted,
          // protected, or suspended). It cannot be shown as a live destination.
          parserDropped += 1
          continue
        }
        if (official?.possiblySensitive) {
          parserDropped += 1
          continue
        }
        const content = official?.text ?? claim.text
        if (!content || unsafePublicContent(content)) {
          parserDropped += 1
          continue
        }
        const publishedAt = freshPublicPostTimestamp(
          official?.createdAt ?? snowflakeTimestamp(ref.id),
          attemptedAt,
          days,
        )
        if (!publishedAt) {
          parserDropped += 1
          continue
        }
        const handle = ref.handle ?? claim.handle
        const engagement = official?.engagement ?? 0
        const identity = publicOpportunityIdentity({
          name: postDisplayName(content),
          platform: 'X',
          content,
          sourceUrl: ref.url,
          requestedLocation,
          locationEvidence: content,
          engagement,
          people: handle
            ? [{
                name: `@${handle}`,
                role: 'Public X contributor shown as secondary source context',
                profile_url: `https://x.com/${encodeURIComponent(handle)}`,
              }]
            : undefined,
        })
        identity.source_published_at = publishedAt
        const demonstratedIntent = classifyOpportunityIntent(content)
        const baseConfidence = calibratedOpportunityConfidence({
          content,
          sourceUrl: ref.url,
          observedAt: publishedAt,
          attemptedAt,
          engagement,
          location: identity.location ?? null,
        })
        normalized.push({
          entity_kind: 'opportunity',
          identity,
          evidence: [
            {
              claim: official
                ? engagement > 0
                  ? `The official X API returned this public post with ${engagement} visible interactions after xAI X Search cited it.`
                  : 'The official X API returned this public post after xAI X Search cited it.'
                : 'xAI X Search cited this public post; the text is the model transcript of the cited post pending official retrieval.',
              source_url: ref.url,
              observed_at: attemptedAt,
              // A model transcript is weaker than an official record.
              confidence: official ? baseConfidence : Math.round(baseConfidence * 0.85 * 1000) / 1000,
              detail: {
                provider: 'xai',
                model,
                provider_request_id: parsed.requestId,
                provider_post_id: ref.id,
                record_provenance: official ? 'x_api_v2_post_lookup' : 'xai_model_transcript_of_cited_post',
                cited_by_provider: true,
                requested_location: requestedLocation,
                requested_intent: expectedIntent,
                source_published_at: publishedAt,
                published_at_basis: official?.createdAt ? 'x_api_created_at' : 'snowflake_id',
                visible_engagement: engagement,
                conversation_id: official?.conversationId ?? null,
                language: official?.lang ?? null,
                demonstrated_intent_signals: [
                  ...demonstratedIntent.buyerSignals,
                  ...demonstratedIntent.sellerSignals,
                  ...demonstratedIntent.localAudienceSignals,
                ],
              },
            },
          ],
        })
      }
      const assessed = normalized.map((candidate) => ({
        candidate,
        assessment: assessSocialReturnedContent(candidate, plan),
      }))
      const kept = assessed.filter(({ assessment }) => assessment.matches).map(({ candidate }) => candidate)
      const filtered = normalized.length - kept.length
      const filterReasons = returnedContentReasonCounts(assessed)
      // Bounded calibration diagnostics: which cited posts the realtor gate
      // dropped and why, so the lane can be tuned from receipts alone.
      const filteredExamples = assessed
        .filter(({ assessment }) => !assessment.matches)
        .slice(0, 5)
        .map(({ candidate, assessment }) => ({
          url: candidate.identity.urls?.[0] ?? null,
          reasons: assessment.reasons,
          text: (candidate.identity.audience_description ?? '').slice(0, 140),
        }))
      if (kept.length === 0) {
        return {
          status: 'no_result',
          data: null,
          receipt: receipt({
            parser_dropped_rows: parserDropped,
            returned_content_filter_version: plan.provider_query?.social_returned_content_filter_version ?? null,
            returned_content_filtered_rows: filtered,
            returned_content_filter_reasons: filterReasons,
            filtered_examples: filteredExamples,
            returned_count: 0,
          }),
          cost_units: costUnits,
          error: cited.length === 0
            ? (claims.length > 0 ? 'no_result_after_citation_validation' : 'no_result')
            : 'no_result_after_returned_content_filter',
        }
      }
      const delivered = kept.slice(0, maxCandidates)
      const truncated = kept.length > delivered.length
      return {
        status: parserDropped > 0 || filtered > 0 || truncated || uncited > 0 ? 'partial' : 'ok',
        data: delivered,
        receipt: receipt({
          returned_count: delivered.length,
          parser_dropped_rows: parserDropped,
          returned_content_filter_version: plan.provider_query?.social_returned_content_filter_version ?? null,
          returned_content_filtered_rows: filtered,
          returned_content_filter_reasons: filterReasons,
          filtered_examples: filteredExamples,
          truncated,
        }),
        cost_units: costUnits,
      }
    },
  }
}
