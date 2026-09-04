import {
  THREADS_KEYWORD_SEARCH_ADAPTER_ID,
  THREADS_KEYWORD_SEARCH_URL,
  THREADS_REQUIRED_PRICE_VERSION,
  THREADS_REQUIRED_TERMS_VERSION,
  createThreadsKeywordSearchAdapter,
  normalizeThreadsKeywordSearchItem,
  safeThreadsUrl,
  threadsConnectionEnabled,
  threadsKeywordSearchEnabled,
} from '../adapters/threads/keyword-search-opportunity-source'
import type { ThreadsConnectionAccess } from '../adapters/threads/connection'
import type { SourceSearchPlan } from '../adapters/types'

const CLOCK = new Date('2026-09-02T18:00:00.000Z')
const now = () => CLOCK

const approvedEnv = {
  GTM_THREADS_KEYWORD_SEARCH_ENABLED: 'true',
  GTM_THREADS_APP_ID: '1234567890',
  GTM_THREADS_APP_SECRET: 'synthetic-app-secret',
  GTM_THREADS_CUSTOMER_USE_APPROVED: 'true',
  GTM_THREADS_KEYWORD_SEARCH_APP_REVIEW_APPROVED: 'true',
  GTM_THREADS_TERMS_VERSION: THREADS_REQUIRED_TERMS_VERSION,
  GTM_THREADS_KEYWORD_SEARCH_PRICE_VERSION: THREADS_REQUIRED_PRICE_VERSION,
}

const plan: SourceSearchPlan = {
  signal_kind: 'social_engagement',
  entity_unit: 'opportunities',
  geography: 'US',
  query: 'Austin house hunting',
  provider_query: {
    search_query: 'Austin house hunting',
    locations: ['Austin, Texas'],
    opportunity_intent_lane: 'buyer_intent',
    threads_keyword_search_contract_version: 'official-keyword-search-v1',
    threads_search_type: 'RECENT',
    social_window_days: 30,
  },
  max_candidates: 5,
  max_charge_usd: 0.01,
}

const realtorPlan: SourceSearchPlan = {
  ...plan,
  provider_query: {
    ...plan.provider_query,
    social_returned_content_filter_version: 'realtor-public-post-v2',
    social_filter_required_intent: 'buyer_intent',
    social_filter_require_location: true,
  },
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: '17890000000000001',
    text: 'Austin question: we are looking to buy a home in Austin this month. Which neighborhoods should we consider?',
    media_type: 'TEXT',
    permalink: 'https://www.threads.net/@austin_buyer/post/DAbCdEfGhIj?utm_source=ig',
    timestamp: '2026-08-30T12:00:00+0000',
    username: 'austin_buyer',
    has_replies: true,
    is_quote_post: false,
    is_reply: false,
    ...overrides,
  }
}

function connection(overrides: Partial<ThreadsConnectionAccess> & { remaining?: number; token?: string } = {}) {
  const state = { remaining: overrides.remaining ?? 1_500, reserved: 0, invalid: null as string | null, used: 0 }
  const access: ThreadsConnectionAccess = {
    connectionId: '11111111-1111-4111-8111-111111111111',
    providerUserId: '99001',
    username: 'noli_customer',
    scopes: ['threads_basic', 'threads_keyword_search'],
    remainingQueries: () => state.remaining - state.reserved,
    reserveQuery: async () => {
      if (state.remaining - state.reserved <= 0) return false
      state.reserved += 1
      return true
    },
    getAccessToken: async () => overrides.token ?? 'synthetic-long-lived-token',
    markInvalid: async (reason) => {
      state.invalid = reason
    },
    recordUse: async () => {
      state.used += 1
    },
    ...overrides,
  }
  return { access, state }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function fetchWith(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('official Threads keyword-search opportunity source', () => {
  it('fails closed unless every deployment gate including Meta App Review approval matches', () => {
    expect(threadsKeywordSearchEnabled(approvedEnv)).toBe(true)
    expect(threadsKeywordSearchEnabled({ ...approvedEnv, GTM_THREADS_KEYWORD_SEARCH_ENABLED: 'false' })).toBe(false)
    expect(threadsKeywordSearchEnabled({ ...approvedEnv, GTM_THREADS_APP_SECRET: '' })).toBe(false)
    expect(threadsKeywordSearchEnabled({ ...approvedEnv, GTM_THREADS_KEYWORD_SEARCH_APP_REVIEW_APPROVED: 'false' })).toBe(false)
    expect(threadsKeywordSearchEnabled({ ...approvedEnv, GTM_THREADS_TERMS_VERSION: 'stale' })).toBe(false)
    expect(threadsKeywordSearchEnabled({ ...approvedEnv, GTM_THREADS_KEYWORD_SEARCH_PRICE_VERSION: 'stale' })).toBe(false)
  })

  it('lets customers connect an account before App Review while search stays gated on approval', () => {
    const preApproval = { ...approvedEnv, GTM_THREADS_KEYWORD_SEARCH_APP_REVIEW_APPROVED: 'false' }
    expect(threadsConnectionEnabled(preApproval)).toBe(true)
    expect(threadsKeywordSearchEnabled(preApproval)).toBe(false)
    expect(threadsConnectionEnabled({ ...preApproval, GTM_THREADS_APP_SECRET: '' })).toBe(false)
    expect(threadsConnectionEnabled({ ...preApproval, GTM_THREADS_CUSTOMER_USE_APPROVED: 'false' })).toBe(false)
  })

  it('quotes one zero-dollar call unit per lane and declares consumer manual-only rights', () => {
    const adapter = createThreadsKeywordSearchAdapter({ env: approvedEnv, now, connection: connection().access })
    expect(adapter.descriptor).toMatchObject({
      adapter_id: THREADS_KEYWORD_SEARCH_ADAPTER_ID,
      constraints: { license: { status: 'approved', audience_modes: ['business', 'consumer'], automated_email_allowed: false } },
      cost_model: { unit: 'threads_keyword_search_call', quoted_credits_per_unit: 0 },
    })
    expect(adapter.quote({ ...plan, max_candidates: 40 })).toMatchObject({ max_candidates: 25, provider_units: 1 })
    expect(adapter.quote({ ...plan, max_candidates: 0 })).toMatchObject({ max_candidates: 0, provider_units: 0 })
  })

  it('normalizes the official post shape with a canonical threads.com permalink', () => {
    expect(safeThreadsUrl('https://www.threads.net/@a/post/XYZ?utm=1#frag')).toBe('https://www.threads.com/@a/post/XYZ')
    expect(safeThreadsUrl('https://example.com/@a/post/XYZ')).toBeNull()
    const candidate = normalizeThreadsKeywordSearchItem(post(), {
      query: 'Austin house hunting',
      location: 'Austin, Texas',
      expectedIntent: 'buyer_intent',
      attemptedAt: CLOCK.toISOString(),
      windowDays: 30,
      providerRequestId: 'trace-1',
    })
    expect(candidate).not.toBeNull()
    expect(candidate!.identity).toMatchObject({
      platform: 'Threads',
      opportunity_kind: 'post',
      urls: ['https://www.threads.com/@austin_buyer/post/DAbCdEfGhIj'],
      source_published_at: '2026-08-30T12:00:00.000Z',
      intent_kind: 'buyer_intent',
      location: 'Austin, Texas',
    })
    expect(candidate!.evidence[0]).toMatchObject({
      claim: 'The official Threads keyword search returned this public post.',
      detail: { provider: 'meta_threads', provider_post_id: '17890000000000001', record_provenance: 'threads_api_keyword_search', has_replies: true },
    })
    expect(normalizeThreadsKeywordSearchItem(post({ timestamp: '2026-06-01T12:00:00+0000' }), {
      query: 'q', location: null, expectedIntent: null, attemptedAt: CLOCK.toISOString(), windowDays: 30, providerRequestId: null,
    })).toBeNull()
    expect(normalizeThreadsKeywordSearchItem(post({ text: 'Widowed and selling the Austin house.' }), {
      query: 'q', location: null, expectedIntent: null, attemptedAt: CLOCK.toISOString(), windowDays: 30, providerRequestId: null,
    })).toBeNull()
  })

  it('reserves a query on the connected account and returns official rows', async () => {
    const { access, state } = connection()
    const { fetchImpl, calls } = fetchWith(() => jsonResponse({ data: [post(), post({ id: '2', text: 'A beautiful Austin kitchen inspiration board with blue cabinets.', permalink: 'https://www.threads.com/@k/post/K1' })] }, 200, { 'x-fb-trace-id': 'trace-9' }))
    const adapter = createThreadsKeywordSearchAdapter({ env: approvedEnv, fetchImpl, now, connection: access })
    const result = await adapter.search(realtorPlan)
    expect(result.status).toBe('partial')
    expect(result.data).toHaveLength(1)
    expect(result.cost_units).toBe(1)
    expect(result.receipt).toMatchObject({
      provider_request_id: 'trace-9',
      provider_status: 200,
      items_count: 2,
      returned_count: 1,
      returned_content_filtered_rows: 1,
      search_query: 'Austin house hunting',
      search_type: 'RECENT',
      connection_id: access.connectionId,
    })
    expect(state.reserved).toBe(1)
    expect(state.used).toBe(1)
    const url = new URL(calls[0]!.url)
    expect(url.origin + url.pathname).toBe(THREADS_KEYWORD_SEARCH_URL)
    expect(url.searchParams.get('q')).toBe('Austin house hunting')
    expect(url.searchParams.get('search_type')).toBe('RECENT')
    expect(url.searchParams.get('limit')).toBe('5')
    expect(url.searchParams.get('fields')).toContain('permalink')
    expect(Number(url.searchParams.get('since'))).toBe(Math.floor((CLOCK.getTime() - 30 * 86_400_000) / 1_000))
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer synthetic-long-lived-token' })
  })

  it('refuses without provider contact when the window budget or grant is missing', async () => {
    const exhausted = connection({ remaining: 0 })
    const { fetchImpl, calls } = fetchWith(() => jsonResponse({ data: [] }))
    const adapter = createThreadsKeywordSearchAdapter({ env: approvedEnv, fetchImpl, now, connection: exhausted.access })
    const budget = await adapter.search(plan)
    expect(budget).toMatchObject({ status: 'error', cost_units: 0 })
    expect(budget.error).toContain('provider_rate_limited')

    const ungranted = connection({ scopes: ['threads_basic'] })
    const scoped = createThreadsKeywordSearchAdapter({ env: approvedEnv, fetchImpl, now, connection: ungranted.access })
    expect((await scoped.search(plan)).error).toContain('did not grant keyword search')

    const unfrozen = await adapter.search({ ...plan, provider_query: { ...plan.provider_query, threads_keyword_search_contract_version: 'other' } })
    expect(unfrozen.error).toContain('official Threads keyword-search contract')

    const unapproved = createThreadsKeywordSearchAdapter({
      env: { ...approvedEnv, GTM_THREADS_KEYWORD_SEARCH_APP_REVIEW_APPROVED: 'false' },
      fetchImpl,
      now,
      connection: connection().access,
    })
    expect((await unapproved.search(plan)).error).toContain('provider_disabled')
    expect(calls).toHaveLength(0)
  })

  it('marks the connection for reauthorization on a rejected token and never charges', async () => {
    const { access, state } = connection()
    const { fetchImpl } = fetchWith(() => jsonResponse({ error: { message: 'Invalid OAuth access token', type: 'OAuthException', code: 190 } }, 400))
    const adapter = createThreadsKeywordSearchAdapter({ env: approvedEnv, fetchImpl, now, connection: access })
    const result = await adapter.search(plan)
    expect(result).toMatchObject({ status: 'error', cost_units: 0 })
    expect(result.error).toContain('reconnect required')
    expect(state.invalid).toBe('threads_400_190')
  })

  it('treats empty data as no_result, 5xx and timeouts as ambiguous, and throttling as a free error', async () => {
    const empty = createThreadsKeywordSearchAdapter({ env: approvedEnv, fetchImpl: fetchWith(() => jsonResponse({ data: [] })).fetchImpl, now, connection: connection().access })
    expect(await empty.search(plan)).toMatchObject({ status: 'no_result', cost_units: 1 })

    const server = createThreadsKeywordSearchAdapter({ env: approvedEnv, fetchImpl: fetchWith(() => new Response('', { status: 503 })).fetchImpl, now, connection: connection().access })
    expect(await server.search(plan)).toMatchObject({ status: 'ambiguous', cost_units: null })

    const throttled = createThreadsKeywordSearchAdapter({ env: approvedEnv, fetchImpl: fetchWith(() => jsonResponse({ error: { code: 4 } }, 400)).fetchImpl, now, connection: connection().access })
    expect(await throttled.search(plan)).toMatchObject({ status: 'error', cost_units: 0 })

    const timeout = createThreadsKeywordSearchAdapter({
      env: { ...approvedEnv, GTM_THREADS_TIMEOUT_MS: '5' },
      fetchImpl: ((_input: unknown, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })) as typeof fetch,
      now,
      connection: connection().access,
    })
    const timedOut = await timeout.search(plan)
    expect(timedOut).toMatchObject({ status: 'ambiguous', cost_units: null })
    expect(timedOut.receipt).toMatchObject({ provider_failure_class: 'timeout' })
  })
})
