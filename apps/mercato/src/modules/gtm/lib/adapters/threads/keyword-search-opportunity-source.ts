/*
 * Official Meta Threads keyword-search demand-opportunity source.
 *
 * Contract (verified against developers.facebook.com on 2026-09-02):
 * - GET https://graph.threads.net/v1.0/keyword_search
 *   q, search_type=TOP|RECENT, search_mode=KEYWORD, media_type, since, until,
 *   limit (default 25, max 100), fields=id,text,media_type,permalink,
 *   timestamp,username,has_replies,is_quote_post,is_reply
 * - Requires the connected customer's user token with `threads_basic` and
 *   `threads_keyword_search`. Without Meta App Review approval the same call
 *   silently searches only the connected user's own posts, so this adapter
 *   also fails closed on the deployment-level approval switch.
 * - No per-call provider fee. The real budget is Meta's 2,200 queries per
 *   user per rolling 24 hours; the connection reserves one query before every
 *   call and refuses when the window is exhausted.
 * - Sensitive keywords return an empty array by provider policy.
 *
 * Billing posture: the ledger requires a positive reservation, so one search
 * is quoted as one `threads_keyword_search_call` unit at $0 provider cost,
 * which prices at the one-credit floor. Timeouts are ambiguous because a query
 * may still have counted against the customer's window.
 */

import {
  capabilityCovers,
  type AdapterDescriptor,
  type AdapterResult,
  type Candidate,
  type SourceAdapter,
} from '../types'
import {
  assessSocialReturnedContent,
  boundedText,
  freshPublicPostTimestamp,
  locationText,
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
import { THREADS_GRAPH_URL, ThreadsOAuthError, type ThreadsConnectionAccess } from './connection'

export const THREADS_KEYWORD_SEARCH_ADAPTER_ID = 'threads-keyword-search-demand-opportunities'
export const THREADS_KEYWORD_SEARCH_URL = `${THREADS_GRAPH_URL}/keyword_search`
export const THREADS_ENABLED_ENV = 'GTM_THREADS_KEYWORD_SEARCH_ENABLED'
export const THREADS_CUSTOMER_USE_ENV = 'GTM_THREADS_CUSTOMER_USE_APPROVED'
export const THREADS_KEYWORD_SEARCH_APPROVED_ENV = 'GTM_THREADS_KEYWORD_SEARCH_APP_REVIEW_APPROVED'
export const THREADS_TERMS_VERSION_ENV = 'GTM_THREADS_TERMS_VERSION'
export const THREADS_PRICE_VERSION_ENV = 'GTM_THREADS_KEYWORD_SEARCH_PRICE_VERSION'
export const THREADS_TIMEOUT_MS_ENV = 'GTM_THREADS_TIMEOUT_MS'
export const THREADS_REQUIRED_TERMS_VERSION = 'meta-threads-api-terms-2026-09-02'
export const THREADS_REQUIRED_PRICE_VERSION = 'threads-keyword-search-no-provider-fee-2200-per-24h-2026-09-02'
export const THREADS_KEYWORD_SEARCH_CONTRACT_VERSION = 'official-keyword-search-v1'
export const THREADS_MAX_RESULTS = 25
export const THREADS_RETENTION_DAYS = 30
export const THREADS_DEFAULT_TIMEOUT_MS = 30_000
export const THREADS_SEARCH_FIELDS = 'id,text,media_type,permalink,timestamp,username,has_replies,is_quote_post,is_reply'

const RECEIPT_FIELDS = [
  'provider_request_id',
  'provider_status',
  'items_count',
  'search_query',
  'search_type',
  'connection_id',
  'remaining_query_budget',
  'provider_failure_class',
]

type ThreadsEnv = Record<string, string | undefined>
type ThreadsFetch = typeof fetch

export type ThreadsKeywordSearchDeps = {
  env?: ThreadsEnv
  fetchImpl?: ThreadsFetch
  now?: () => Date
  connection: ThreadsConnectionAccess
}

function envValue(env: ThreadsEnv, name: string): string {
  return (env[name] ?? '').trim()
}

export function threadsKeywordSearchApproved(env: ThreadsEnv = process.env): boolean {
  return (
    envValue(env, THREADS_CUSTOMER_USE_ENV) === 'true'
    && envValue(env, THREADS_KEYWORD_SEARCH_APPROVED_ENV) === 'true'
    && envValue(env, THREADS_TERMS_VERSION_ENV) === THREADS_REQUIRED_TERMS_VERSION
    && envValue(env, THREADS_PRICE_VERSION_ENV) === THREADS_REQUIRED_PRICE_VERSION
  )
}

/** Deployment gate only; a connected customer account is a separate runtime
 *  requirement enforced by the registry. */
export function threadsKeywordSearchEnabled(env: ThreadsEnv = process.env): boolean {
  return (
    envValue(env, THREADS_ENABLED_ENV) === 'true'
    && Boolean(envValue(env, 'GTM_THREADS_APP_ID'))
    && Boolean(envValue(env, 'GTM_THREADS_APP_SECRET'))
    && threadsKeywordSearchApproved(env)
  )
}

function timeoutMs(env: ThreadsEnv): number {
  const parsed = Number(envValue(env, THREADS_TIMEOUT_MS_ENV))
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : THREADS_DEFAULT_TIMEOUT_MS
}

export function threadsKeywordSearchDescriptor(env: ThreadsEnv = process.env): AdapterDescriptor {
  const approved = threadsKeywordSearchApproved(env)
  return {
    contract_version: '2',
    adapter_id: THREADS_KEYWORD_SEARCH_ADAPTER_ID,
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
        terms_version: envValue(env, THREADS_TERMS_VERSION_ENV) || 'unapproved',
        export: approved,
        customer_display: approved,
        outreach_allowed: approved,
        retention_days: THREADS_RETENTION_DAYS,
        audience_modes: ['business', 'consumer'],
        manual_outreach_allowed: approved,
        automated_email_allowed: false,
        public_profile_contact_allowed: approved,
        public_opportunity_use_allowed: approved,
      },
      rate_limits: { requests_per_minute: 30, concurrent: 1 },
      max_batch: THREADS_MAX_RESULTS,
    },
    cost_model: {
      unit: 'threads_keyword_search_call',
      quoted_credits_per_unit: 0,
      price_version: envValue(env, THREADS_PRICE_VERSION_ENV) || 'unapproved',
      pay_on_found: false,
    },
    evidence_policy: {
      source_url: 'required',
      observed_at: 'required',
      max_age_days: THREADS_RETENTION_DAYS,
      min_confidence: 0.72,
    },
    ambiguity_contract: {
      timeout_is_ambiguous: true,
      receipt_fields: RECEIPT_FIELDS,
    },
    dsr: { deletion_supported: true },
  }
}

const THREADS_HOSTS = new Set(['threads.com', 'threads.net'])

export function safeThreadsUrl(value: unknown): string | null {
  const raw = boundedText(value, 2_000)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (!THREADS_HOSTS.has(host)) return null
    url.protocol = 'https:'
    url.hostname = 'www.threads.com'
    url.hash = ''
    url.search = ''
    return url.toString()
  } catch {
    return null
  }
}

export type ThreadsNormalizeContext = {
  query: string
  location: string | null
  expectedIntent: ReturnType<typeof requestedOpportunityIntent>
  attemptedAt: string
  windowDays: number
  providerRequestId: string | null
}

export function normalizeThreadsKeywordSearchItem(value: unknown, context: ThreadsNormalizeContext): Candidate | null {
  const row = record(value)
  if (!row) return null
  const postId = boundedText(row.id, 60)
  const sourceUrl = safeThreadsUrl(row.permalink)
  const content = boundedText(row.text, 800)
  if (!postId || !sourceUrl || !content || unsafePublicContent(content)) return null
  const publishedAt = freshPublicPostTimestamp(row.timestamp, context.attemptedAt, context.windowDays)
  if (!publishedAt) return null
  const username = boundedText(row.username, 100)?.replace(/^@/, '') ?? null
  const profileUrl = username ? `https://www.threads.com/@${encodeURIComponent(username)}` : null
  // Keyword search returns no counts; has_replies is the only engagement hint.
  const engagement = row.has_replies === true ? 1 : 0
  const identity = publicOpportunityIdentity({
    name: postDisplayName(content),
    platform: 'Threads',
    content,
    sourceUrl,
    requestedLocation: context.location,
    locationEvidence: content,
    engagement,
    people: username
      ? [{
          name: `@${username}`,
          role: 'Public Threads contributor shown as secondary source context',
          profile_url: profileUrl,
        }]
      : undefined,
  })
  identity.source_published_at = publishedAt
  const demonstratedIntent = classifyOpportunityIntent(content)
  return {
    entity_kind: 'opportunity',
    identity,
    evidence: [
      {
        claim: row.is_reply === true
          ? 'The official Threads keyword search returned this public reply.'
          : 'The official Threads keyword search returned this public post.',
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
          provider: 'meta_threads',
          provider_request_id: context.providerRequestId,
          provider_post_id: postId,
          record_provenance: 'threads_api_keyword_search',
          media_type: boundedText(row.media_type, 20),
          is_reply: row.is_reply === true,
          is_quote_post: row.is_quote_post === true,
          has_replies: row.has_replies === true,
          requested_location: context.location,
          requested_intent: context.expectedIntent,
          source_published_at: publishedAt,
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

export function createThreadsKeywordSearchAdapter(deps: ThreadsKeywordSearchDeps): SourceAdapter {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => new Date())
  const connection = deps.connection
  const descriptor = threadsKeywordSearchDescriptor(env)

  const baseReceipt = (extras: Record<string, unknown>) => ({
    provider_request_id: null,
    provider_status: null,
    items_count: 0,
    search_query: null,
    search_type: null,
    connection_id: connection.connectionId,
    remaining_query_budget: connection.remainingQueries(),
    provider_failure_class: null,
    contract_version: THREADS_KEYWORD_SEARCH_CONTRACT_VERSION,
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
      const maxCandidates = Math.max(0, Math.min(Math.floor(plan.max_candidates), THREADS_MAX_RESULTS))
      const providerUnits = maxCandidates > 0 ? 1 : 0
      return {
        max_candidates: maxCandidates,
        provider_units: providerUnits,
        billable_unit: descriptor.cost_model.unit,
        expected_candidates: { low: 0, high: maxCandidates, basis: 'provider_quote' },
        quoted_credits_per_unit: descriptor.cost_model.quoted_credits_per_unit,
        estimated_credits_before_markup: 0,
      }
    },
    async search(plan) {
      const attemptedAt = now().toISOString()
      const coverage = capabilityCovers(descriptor, plan)
      if (!coverage.covered) return refusal(attemptedAt, `unsupported_capability: ${coverage.reason ?? 'not covered'}`)
      if (!threadsKeywordSearchEnabled(env)) {
        return refusal(attemptedAt, 'provider_disabled: Threads keyword search switch, app, terms, price, or App Review gate is not approved')
      }
      if (plan.provider_query?.threads_keyword_search_contract_version !== THREADS_KEYWORD_SEARCH_CONTRACT_VERSION) {
        return refusal(attemptedAt, 'bad_request: plan was not frozen under the official Threads keyword-search contract')
      }
      if (!connection.scopes.includes('threads_keyword_search')) {
        return refusal(attemptedAt, 'provider_unauthorized: the connected Threads account did not grant keyword search')
      }
      const maxCandidates = Math.max(0, Math.min(Math.floor(plan.max_candidates), THREADS_MAX_RESULTS))
      if (maxCandidates <= 0) return refusal(attemptedAt, 'bad_request: a positive opportunity cap is required')
      let query: string
      try {
        query = queryText(plan, 100)
      } catch (error) {
        return refusal(attemptedAt, `bad_request: ${error instanceof Error ? error.message : String(error)}`)
      }
      const searchType = plan.provider_query?.threads_search_type === 'TOP' ? 'TOP' : 'RECENT'
      const days = windowDays(plan)
      let accessToken: string
      try {
        accessToken = await connection.getAccessToken()
      } catch (error) {
        return refusal(
          attemptedAt,
          `provider_unauthorized: ${error instanceof Error ? error.message : 'Threads token unavailable'}`,
        )
      }
      if (!(await connection.reserveQuery())) {
        return refusal(attemptedAt, 'provider_rate_limited: the connected Threads account has no keyword-search budget left in this 24-hour window')
      }
      const url = new URL(THREADS_KEYWORD_SEARCH_URL)
      url.searchParams.set('q', query)
      url.searchParams.set('search_type', searchType)
      url.searchParams.set('search_mode', 'KEYWORD')
      url.searchParams.set('fields', THREADS_SEARCH_FIELDS)
      url.searchParams.set('limit', String(maxCandidates))
      url.searchParams.set('since', String(Math.floor((Date.parse(attemptedAt) - days * 86_400_000) / 1_000)))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs(env))
      let response: Response
      try {
        response = await fetchImpl(url.toString(), {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
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
            search_type: searchType,
            provider_failure_class: timeout ? 'timeout' : 'transport',
            attempted_at: attemptedAt,
          }),
          cost_units: null,
          error: timeout ? 'provider_timeout: Threads request timed out' : `provider_transport: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      clearTimeout(timer)
      const providerRequestId = response.headers.get('x-fb-trace-id') ?? response.headers.get('x-fb-request-id')
      const body = record(await response.json().catch(() => null))
      const graphError = record(body?.error)
      const graphCode = Number(graphError?.code)
      const receiptCore = {
        provider_request_id: providerRequestId,
        provider_status: response.status,
        search_query: query,
        search_type: searchType,
        window_days: days,
        attempted_at: attemptedAt,
        provider_error_code: Number.isFinite(graphCode) ? graphCode : null,
        remaining_query_budget: connection.remainingQueries(),
      }
      if (response.status === 401 || graphCode === 190 || graphCode === 102) {
        await connection.markInvalid(`threads_${response.status}_${Number.isFinite(graphCode) ? graphCode : 'auth'}`)
        return {
          status: 'error',
          data: null,
          receipt: baseReceipt({ ...receiptCore, provider_failure_class: 'unauthorized' }),
          cost_units: 0,
          error: 'provider_unauthorized: Threads rejected the connected account token; reconnect required',
        }
      }
      if (response.status === 403 || graphCode === 10 || graphCode === 200) {
        return {
          status: 'error',
          data: null,
          receipt: baseReceipt({ ...receiptCore, provider_failure_class: 'permission_denied' }),
          cost_units: 0,
          error: 'provider_unauthorized: Threads denied keyword search for this app or account',
        }
      }
      if (response.status === 429 || graphCode === 4 || graphCode === 17 || graphCode === 613) {
        return {
          status: 'error',
          data: null,
          receipt: baseReceipt({ ...receiptCore, provider_failure_class: 'rate_limited' }),
          cost_units: 0,
          error: 'provider_rate_limited: Threads throttled keyword search',
        }
      }
      if (response.status >= 500) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: baseReceipt({ ...receiptCore, provider_failure_class: 'server_error' }),
          cost_units: null,
          error: `provider_unknown: Threads responded ${response.status}`,
        }
      }
      if (!response.ok || !body || !Array.isArray(body.data)) {
        return {
          status: 'error',
          data: null,
          receipt: baseReceipt({ ...receiptCore, provider_failure_class: 'invalid_schema' }),
          cost_units: 1,
          error: `invalid_schema: Threads responded ${response.status} without a data array`,
        }
      }
      await connection.recordUse()
      const items = body.data
      if (items.length === 0) {
        return {
          status: 'no_result',
          data: null,
          receipt: baseReceipt({ ...receiptCore, items_count: 0, returned_count: 0 }),
          cost_units: 1,
        }
      }
      const context: ThreadsNormalizeContext = {
        query,
        location: locationText(plan),
        expectedIntent: requestedOpportunityIntent(plan),
        attemptedAt,
        windowDays: days,
        providerRequestId,
      }
      const normalized = items
        .map((item) => normalizeThreadsKeywordSearchItem(item, context))
        .filter((candidate): candidate is Candidate => candidate != null)
      const assessed = normalized.map((candidate) => ({
        candidate,
        assessment: assessSocialReturnedContent(candidate, plan),
      }))
      const kept = assessed.filter(({ assessment }) => assessment.matches).map(({ candidate }) => candidate)
      const parserDropped = items.length - normalized.length
      const filtered = normalized.length - kept.length
      const filterReasons = returnedContentReasonCounts(assessed)
      const filterFields = {
        items_count: items.length,
        parser_dropped_rows: parserDropped,
        returned_content_filter_version: plan.provider_query?.social_returned_content_filter_version ?? null,
        returned_content_filtered_rows: filtered,
        returned_content_filter_reasons: filterReasons,
      }
      if (kept.length === 0) {
        return {
          status: 'no_result',
          data: null,
          receipt: baseReceipt({ ...receiptCore, ...filterFields, returned_count: 0 }),
          cost_units: 1,
          error: normalized.length > 0
            ? 'no_result_after_returned_content_filter'
            : 'no_result_after_public_post_screen',
        }
      }
      const delivered = kept.slice(0, maxCandidates)
      const truncated = kept.length > delivered.length
      return {
        status: parserDropped > 0 || filtered > 0 || truncated ? 'partial' : 'ok',
        data: delivered,
        receipt: baseReceipt({ ...receiptCore, ...filterFields, returned_count: delivered.length, truncated }),
        cost_units: 1,
      }
    },
  }
}
