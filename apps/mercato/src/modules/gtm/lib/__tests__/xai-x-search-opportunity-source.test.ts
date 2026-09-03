import {
  XAI_CEILING_INPUT_TOKENS,
  XAI_CEILING_X_SEARCH_CALLS,
  XAI_MAX_OUTPUT_TOKENS,
  XAI_REQUIRED_PRICE_VERSION,
  XAI_REQUIRED_TERMS_VERSION,
  XAI_RESPONSES_URL,
  XAI_X_SEARCH_ADAPTER_ID,
  X_API_POSTS_LOOKUP_URL,
  X_API_REQUIRED_PRICE_VERSION,
  buildXSearchPrompt,
  createXaiXSearchOpportunityAdapter,
  extractModelPosts,
  parseXStatusUrl,
  parseXaiResponse,
  snowflakeTimestamp,
  xApiHydrationEnabled,
  xaiLaneCeilingUsd,
  xaiXSearchEnabled,
} from '../adapters/xai/x-search-opportunity-source'
import type { SourceSearchPlan } from '../adapters/types'

const CLOCK = new Date('2026-09-02T18:00:00.000Z')
const now = () => CLOCK
const TWITTER_EPOCH_MS = BigInt('1288834974657')

/** Inverse of the snowflake decode: an id whose embedded time is `date`. */
function snowflakeFor(date: Date): string {
  return ((BigInt(date.getTime()) - TWITTER_EPOCH_MS) << BigInt(22)).toString()
}

const RECENT_ID = snowflakeFor(new Date('2026-08-28T15:30:00.000Z'))
const STALE_ID = snowflakeFor(new Date('2026-06-01T15:30:00.000Z'))
const RECENT_URL = `https://x.com/austinmover/status/${RECENT_ID}`

const approvedEnv = {
  GTM_XAI_X_SEARCH_ENABLED: 'true',
  GTM_XAI_API_KEY: 'synthetic-xai-key',
  GTM_XAI_CUSTOMER_USE_APPROVED: 'true',
  GTM_XAI_TERMS_VERSION: XAI_REQUIRED_TERMS_VERSION,
  GTM_XAI_X_SEARCH_PRICE_VERSION: XAI_REQUIRED_PRICE_VERSION,
}

const hydrationEnv = {
  ...approvedEnv,
  GTM_X_API_HYDRATION_ENABLED: 'true',
  GTM_X_API_BEARER_TOKEN: 'synthetic-x-bearer',
  GTM_X_API_CUSTOMER_USE_APPROVED: 'true',
  GTM_X_API_PRICE_VERSION: X_API_REQUIRED_PRICE_VERSION,
}

const genericPlan: SourceSearchPlan = {
  signal_kind: 'social_engagement',
  entity_unit: 'opportunities',
  geography: 'US',
  query: 'Austin people looking to buy a home',
  provider_query: {
    search_query: 'people in Austin who say they are looking to buy a home or are house hunting right now',
    locations: ['Austin, Texas'],
    opportunity_intent_lane: 'buyer_intent',
    xai_x_search_contract_version: 'official-x-search-v1',
    social_window_days: 30,
  },
  max_candidates: 5,
  max_charge_usd: 0.2,
}

const realtorPlan: SourceSearchPlan = {
  ...genericPlan,
  provider_query: {
    ...genericPlan.provider_query,
    social_returned_content_filter_version: 'realtor-public-post-v2',
    social_filter_required_intent: 'buyer_intent',
    social_filter_require_location: true,
  },
}

const POST_TEXT = 'Austin question: we are looking to buy a home in Austin this month. Which neighborhoods should we consider?'

function responsesBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp_synthetic_1',
    status: 'completed',
    model: 'grok-4.3',
    output: [
      { type: 'x_search_call', id: 'xs_1', status: 'completed' },
      { type: 'x_search_call', id: 'xs_2', status: 'completed' },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({
              posts: [
                { url: RECENT_URL, handle: 'austinmover', text: POST_TEXT, why: 'first-person buyer in Austin' },
                // Never cited by the provider: must be dropped as unverifiable.
                { url: `https://x.com/inventor/status/${snowflakeFor(new Date('2026-08-29T00:00:00.000Z'))}`, handle: 'inventor', text: 'Buying a home in Austin soon!' },
              ],
            }),
            annotations: [
              { type: 'url_citation', url: RECENT_URL, title: '1', start_index: 0, end_index: 1 },
            ],
          },
        ],
      },
    ],
    citations: [RECENT_URL, 'https://example.com/not-a-post'],
    usage: {
      input_tokens: 12_000,
      output_tokens: 300,
      total_tokens: 12_300,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
      server_side_tool_usage_details: { x_search_calls: 2 },
    },
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function fetchRouter(handlers: { xai?: (init: RequestInit) => Response; x?: (url: string, init: RequestInit) => Response }) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    if (url === XAI_RESPONSES_URL) return (handlers.xai ?? (() => jsonResponse(responsesBody())))(init)
    if (url.startsWith(X_API_POSTS_LOOKUP_URL)) {
      return (handlers.x ?? (() => jsonResponse({ data: [] })))(url, init)
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('official xAI X Search opportunity source', () => {
  it('fails closed unless the switch, key, customer use, terms, price, and model all match', () => {
    expect(xaiXSearchEnabled(approvedEnv)).toBe(true)
    expect(xaiXSearchEnabled({ ...approvedEnv, GTM_XAI_X_SEARCH_ENABLED: 'false' })).toBe(false)
    expect(xaiXSearchEnabled({ ...approvedEnv, GTM_XAI_API_KEY: '' })).toBe(false)
    expect(xaiXSearchEnabled({ ...approvedEnv, GTM_XAI_CUSTOMER_USE_APPROVED: 'no' })).toBe(false)
    expect(xaiXSearchEnabled({ ...approvedEnv, GTM_XAI_TERMS_VERSION: 'stale' })).toBe(false)
    expect(xaiXSearchEnabled({ ...approvedEnv, GTM_XAI_X_SEARCH_PRICE_VERSION: 'stale' })).toBe(false)
    expect(xaiXSearchEnabled({ ...approvedEnv, GTM_XAI_MODEL: 'grok-unpriced' })).toBe(false)
    expect(xApiHydrationEnabled(approvedEnv)).toBe(false)
    expect(xApiHydrationEnabled(hydrationEnv)).toBe(true)
    expect(xApiHydrationEnabled({ ...hydrationEnv, GTM_X_API_PRICE_VERSION: 'stale' })).toBe(false)
  })

  it('is consumer-capable, manual-only, and quotes an explicit per-lane ceiling', () => {
    const adapter = createXaiXSearchOpportunityAdapter({ env: approvedEnv, now })
    expect(adapter.descriptor).toMatchObject({
      adapter_id: XAI_X_SEARCH_ADAPTER_ID,
      constraints: {
        license: {
          status: 'approved',
          audience_modes: ['business', 'consumer'],
          manual_outreach_allowed: true,
          automated_email_allowed: false,
          public_opportunity_use_allowed: true,
        },
      },
      cost_model: { unit: 'xai_millidollar', price_version: XAI_REQUIRED_PRICE_VERSION },
      dsr: { deletion_supported: true },
    })
    // 6 searches at $0.005 + 40k input tokens at $1.25/M + 2k output at $2.50/M.
    const expectedCeiling = XAI_CEILING_X_SEARCH_CALLS * 0.005
      + (XAI_CEILING_INPUT_TOKENS * 1.25 + XAI_MAX_OUTPUT_TOKENS * 2.5) / 1_000_000
    expect(xaiLaneCeilingUsd(approvedEnv)).toBeCloseTo(expectedCeiling, 6)
    expect(xaiLaneCeilingUsd(approvedEnv)).toBeCloseTo(0.085, 6)
    const quote = adapter.quote({ ...genericPlan, max_candidates: 25 })
    expect(quote.max_candidates).toBe(10)
    expect(quote.provider_units).toBeCloseTo(85, 6)
    // Hydration adds $0.005 per possible post to the ceiling.
    const hydrated = createXaiXSearchOpportunityAdapter({ env: hydrationEnv, now })
    expect(hydrated.quote({ ...genericPlan, max_candidates: 10 }).provider_units).toBeCloseTo(135, 6)
    expect(hydrated.descriptor.cost_model.price_version).toBe(`${XAI_REQUIRED_PRICE_VERSION}+${X_API_REQUIRED_PRICE_VERSION}`)
  })

  it('parses X status URLs canonically and derives post time from the snowflake id', () => {
    expect(parseXStatusUrl(`https://twitter.com/Some_User/status/${RECENT_ID}?s=20`)).toEqual({
      id: RECENT_ID,
      handle: 'Some_User',
      url: `https://x.com/Some_User/status/${RECENT_ID}`,
    })
    expect(parseXStatusUrl(`https://x.com/i/web/status/${RECENT_ID}`)).toMatchObject({ id: RECENT_ID, handle: null })
    expect(parseXStatusUrl('https://x.com/someone')).toBeNull()
    expect(parseXStatusUrl('https://example.com/status/12345678')).toBeNull()
    expect(snowflakeTimestamp('1000000000000000000')?.startsWith('2018-05-25')).toBe(true)
    expect(snowflakeTimestamp(RECENT_ID)).toBe('2026-08-28T15:30:00.000Z')
    expect(snowflakeTimestamp('20')).toBeNull()
  })

  it('keeps only model posts whose ids the provider actually cited', () => {
    const parsed = parseXaiResponse(responsesBody(), null)
    expect(parsed.xSearchCalls).toBe(2)
    expect(parsed.inputTokens).toBe(12_000)
    expect(parsed.citedIds.has(RECENT_ID)).toBe(true)
    expect(parsed.citedIds.size).toBe(1)
    const claims = extractModelPosts(parsed.text)
    expect(claims).toHaveLength(2)
    const prompt = buildXSearchPrompt(genericPlan, 'q', 5)
    expect(prompt).toContain('Never invent')
    expect(prompt).toContain('Austin, Texas')
    expect(prompt).toContain('Latest mode')
    expect(prompt).toContain('moving to Austin')
  })

  it('returns a cited post as a discovery row priced from the returned usage', async () => {
    const { fetchImpl, calls } = fetchRouter({})
    const adapter = createXaiXSearchOpportunityAdapter({ env: approvedEnv, fetchImpl, now })
    const result = await adapter.search(genericPlan)
    expect(result.status).toBe('partial')
    expect(result.data).toHaveLength(1)
    const row = result.data![0]!
    expect(row.identity.urls).toEqual([RECENT_URL])
    expect(row.identity.platform).toBe('X')
    expect(row.identity.opportunity_kind).toBe('post')
    expect(row.identity.source_published_at).toBe('2026-08-28T15:30:00.000Z')
    expect(row.identity.people_to_follow).toEqual([
      { name: '@austinmover', role: 'Public X contributor shown as secondary source context', profile_url: 'https://x.com/austinmover' },
    ])
    expect(row.evidence[0]).toMatchObject({
      source_url: RECENT_URL,
      observed_at: CLOCK.toISOString(),
      detail: {
        provider: 'xai',
        cited_by_provider: true,
        record_provenance: 'xai_model_transcript_of_cited_post',
        published_at_basis: 'snowflake_id',
      },
    })
    // 12,000 in x $1.25/M + 300 out x $2.50/M + 2 searches x $0.005 = $0.02575.
    expect(result.cost_units).toBeCloseTo(25.75, 6)
    expect(result.receipt).toMatchObject({
      provider_request_id: 'resp_synthetic_1',
      model: 'grok-4.3',
      x_search_calls: 2,
      input_tokens: 12_000,
      output_tokens: 300,
      provider_cost_usd: 0.02575,
      hydration_post_reads: 0,
      hydration_status: 'skipped',
      model_claimed_posts: 2,
      uncited_model_posts: 1,
      citation_count: 3,
      provider_cost_exceeded_quote: false,
    })
    const body = JSON.parse(String(calls[0]!.init.body))
    expect(body.tools).toEqual([{ type: 'x_search', from_date: '2026-08-03', to_date: '2026-09-02' }])
    expect(body.max_turns).toBe(3)
    expect(body.store).toBe(false)
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer synthetic-xai-key' })
  })

  it('replaces the model transcript with the official X API record when hydration is on', async () => {
    const { fetchImpl, calls } = fetchRouter({
      x: (url) => {
        expect(url).toContain(`ids=${RECENT_ID}`)
        expect(url).not.toContain('expansions')
        return jsonResponse({
          data: [
            {
              id: RECENT_ID,
              text: 'Official text: looking to buy a home in Austin this month, neighborhood tips welcome.',
              created_at: '2026-08-28T15:30:05.000Z',
              author_id: '42',
              conversation_id: RECENT_ID,
              lang: 'en',
              possibly_sensitive: false,
              public_metrics: { retweet_count: 1, reply_count: 4, like_count: 9, quote_count: 0, bookmark_count: 2, impression_count: 500 },
            },
          ],
        })
      },
    })
    const adapter = createXaiXSearchOpportunityAdapter({ env: hydrationEnv, fetchImpl, now })
    const result = await adapter.search(genericPlan)
    expect(result.status).toBe('partial')
    const row = result.data![0]!
    expect(row.identity.audience_description).toContain('Official text')
    expect(row.identity.engagement_count).toBe(14)
    expect(row.identity.source_published_at).toBe('2026-08-28T15:30:05.000Z')
    expect(row.evidence[0]!.claim).toContain('official X API')
    expect(row.evidence[0]!.detail).toMatchObject({
      record_provenance: 'x_api_v2_post_lookup',
      published_at_basis: 'x_api_created_at',
      visible_engagement: 14,
    })
    expect(result.cost_units).toBeCloseTo(30.75, 6)
    expect(result.receipt).toMatchObject({ hydration_status: 'ok', hydration_post_reads: 1, hydration_cost_usd: 0.005 })
    expect(calls[1]!.init.headers).toMatchObject({ Authorization: 'Bearer synthetic-x-bearer' })
  })

  it('drops a cited post the official X API no longer returns', async () => {
    const { fetchImpl } = fetchRouter({
      x: () => jsonResponse({ errors: [{ resource_id: RECENT_ID, detail: 'Could not find tweet', title: 'Not Found Error' }] }),
    })
    const adapter = createXaiXSearchOpportunityAdapter({ env: hydrationEnv, fetchImpl, now })
    const result = await adapter.search(genericPlan)
    expect(result.status).toBe('no_result')
    expect(result.receipt).toMatchObject({ parser_dropped_rows: 1, hydration_post_reads: 0 })
    expect(result.cost_units).toBeCloseTo(25.75, 6)
  })

  it('applies the realtor returned-content gate and drops stale or sensitive posts', async () => {
    const staleUrl = `https://x.com/older/status/${STALE_ID}`
    const sensitiveId = snowflakeFor(new Date('2026-08-30T00:00:00.000Z'))
    const sensitiveUrl = `https://x.com/sad/status/${sensitiveId}`
    const offTopicId = snowflakeFor(new Date('2026-08-31T00:00:00.000Z'))
    const offTopicUrl = `https://x.com/kitchen/status/${offTopicId}`
    const { fetchImpl } = fetchRouter({
      xai: () => jsonResponse(responsesBody({
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{
              type: 'output_text',
              text: JSON.stringify({ posts: [
                { url: RECENT_URL, text: POST_TEXT },
                { url: staleUrl, text: POST_TEXT },
                { url: sensitiveUrl, text: 'Going through a divorce and need to sell the Austin house fast.' },
                { url: offTopicUrl, text: 'A beautiful Austin kitchen inspiration board with blue cabinets.' },
              ] }),
              annotations: [],
            }],
          },
        ],
        citations: [RECENT_URL, staleUrl, sensitiveUrl, offTopicUrl],
      })),
    })
    const adapter = createXaiXSearchOpportunityAdapter({ env: approvedEnv, fetchImpl, now })
    const result = await adapter.search(realtorPlan)
    expect(result.status).toBe('partial')
    expect(result.data).toHaveLength(1)
    expect(result.data![0]!.identity.urls).toEqual([RECENT_URL])
    expect(result.receipt).toMatchObject({
      parser_dropped_rows: 2,
      returned_content_filter_version: 'realtor-public-post-v2',
      returned_content_filtered_rows: 1,
    })
  })

  it('refuses before provider contact when the plan is not frozen under the contract or under-reserved', async () => {
    const { fetchImpl, calls } = fetchRouter({})
    const adapter = createXaiXSearchOpportunityAdapter({ env: approvedEnv, fetchImpl, now })
    const unfrozen = await adapter.search({ ...genericPlan, provider_query: { ...genericPlan.provider_query, xai_x_search_contract_version: undefined } })
    expect(unfrozen.status).toBe('error')
    expect(unfrozen.error).toContain('official X Search contract')
    const underReserved = await adapter.search({ ...genericPlan, max_charge_usd: 0.01 })
    expect(underReserved.status).toBe('error')
    expect(underReserved.error).toContain('below the frozen')
    const sensitive = await adapter.search({ ...genericPlan, provider_query: { ...genericPlan.provider_query, search_query: 'Austin foreclosure homeowners' } })
    expect(sensitive.error).toContain('sensitive')
    expect(calls).toHaveLength(0)
    const disabled = createXaiXSearchOpportunityAdapter({ env: { ...approvedEnv, GTM_XAI_API_KEY: '' }, fetchImpl, now })
    expect((await disabled.search(genericPlan)).error).toContain('provider_disabled')
    expect(calls).toHaveLength(0)
  })

  it('maps rejections to zero-cost errors and unknown outcomes to ambiguous', async () => {
    const rejected = createXaiXSearchOpportunityAdapter({
      env: approvedEnv,
      fetchImpl: fetchRouter({ xai: () => jsonResponse({ error: 'invalid key' }, 401) }).fetchImpl,
      now,
    })
    const rejection = await rejected.search(genericPlan)
    expect(rejection).toMatchObject({ status: 'error', cost_units: 0 })
    expect(rejection.receipt).toMatchObject({ provider_failure_class: 'rejected', provider_status: 401 })

    const serverError = createXaiXSearchOpportunityAdapter({
      env: approvedEnv,
      fetchImpl: fetchRouter({ xai: () => new Response('bad gateway', { status: 502 }) }).fetchImpl,
      now,
    })
    expect(await serverError.search(genericPlan)).toMatchObject({ status: 'ambiguous', cost_units: null })

    const noUsage = createXaiXSearchOpportunityAdapter({
      env: approvedEnv,
      fetchImpl: fetchRouter({ xai: () => jsonResponse(responsesBody({ usage: undefined })) }).fetchImpl,
      now,
    })
    const unbilled = await noUsage.search(genericPlan)
    expect(unbilled).toMatchObject({ status: 'ambiguous', cost_units: null })
    expect(unbilled.error).toContain('usage block')

    const drift = createXaiXSearchOpportunityAdapter({
      env: approvedEnv,
      fetchImpl: fetchRouter({ xai: () => jsonResponse(responsesBody({ model: 'grok-4.6' })) }).fetchImpl,
      now,
    })
    expect((await drift.search(genericPlan)).error).toContain('grok-4.6')

    const timeout = createXaiXSearchOpportunityAdapter({
      env: { ...approvedEnv, GTM_XAI_TIMEOUT_MS: '5' },
      fetchImpl: ((_input: unknown, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })) as typeof fetch,
      now,
    })
    const timedOut = await timeout.search(genericPlan)
    expect(timedOut).toMatchObject({ status: 'ambiguous', cost_units: null })
    expect(timedOut.receipt).toMatchObject({ provider_failure_class: 'timeout' })
  })

  it('charges the observed usage even when the model returned nothing usable', async () => {
    const adapter = createXaiXSearchOpportunityAdapter({
      env: approvedEnv,
      fetchImpl: fetchRouter({ xai: () => jsonResponse(responsesBody({
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"posts":[]}', annotations: [] }] }],
        citations: [],
      })) }).fetchImpl,
      now,
    })
    const result = await adapter.search(genericPlan)
    expect(result.status).toBe('no_result')
    expect(result.error).toBe('no_result')
    expect(result.cost_units).toBeCloseTo(25.75, 6)
  })
})
