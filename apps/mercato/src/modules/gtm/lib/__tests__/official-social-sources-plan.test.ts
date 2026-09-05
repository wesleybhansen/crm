import { sourceAdapterRegistry } from '../adapters/registry'
import { selectedProviderCatalog } from '../adapters/provider-catalog'
import {
  XAI_REQUIRED_PRICE_VERSION,
  XAI_REQUIRED_TERMS_VERSION,
  XAI_X_SEARCH_ADAPTER_ID,
  createXaiXSearchOpportunityAdapter,
} from '../adapters/xai/x-search-opportunity-source'
import {
  THREADS_KEYWORD_SEARCH_ADAPTER_ID,
  THREADS_REQUIRED_PRICE_VERSION,
  THREADS_REQUIRED_TERMS_VERSION,
  createThreadsKeywordSearchAdapter,
} from '../adapters/threads/keyword-search-opportunity-source'
import type { ThreadsConnectionAccess } from '../adapters/threads/connection'
import { buildOpportunityQueryLanes, opportunitySourceRouting } from '../research/opportunity-query-lanes'
import { buildSourcePlan, type PlanPlayInput } from '../research/plan'

const xaiEnv = {
  GTM_XAI_X_SEARCH_ENABLED: 'true',
  GTM_XAI_API_KEY: 'k',
  GTM_XAI_CUSTOMER_USE_APPROVED: 'true',
  GTM_XAI_TERMS_VERSION: XAI_REQUIRED_TERMS_VERSION,
  GTM_XAI_X_SEARCH_PRICE_VERSION: XAI_REQUIRED_PRICE_VERSION,
}

const threadsEnv = {
  GTM_THREADS_KEYWORD_SEARCH_ENABLED: 'true',
  GTM_THREADS_APP_ID: '1234567890',
  GTM_THREADS_APP_SECRET: 's',
  GTM_THREADS_CUSTOMER_USE_APPROVED: 'true',
  GTM_THREADS_KEYWORD_SEARCH_APP_REVIEW_APPROVED: 'true',
  GTM_THREADS_TERMS_VERSION: THREADS_REQUIRED_TERMS_VERSION,
  GTM_THREADS_KEYWORD_SEARCH_PRICE_VERSION: THREADS_REQUIRED_PRICE_VERSION,
}

const connection: ThreadsConnectionAccess = {
  connectionId: '33333333-3333-4333-8333-333333333333',
  providerUserId: '1',
  username: 'c',
  scopes: ['threads_basic', 'threads_keyword_search'],
  remainingQueries: () => 100,
  reserveQuery: async () => true,
  getAccessToken: async () => 't',
  markInvalid: async () => undefined,
  recordUse: async () => undefined,
}

const realtorPlay: PlanPlayInput = {
  marketType: 'b2c',
  audience: 'Austin home buyers and sellers',
  signal: 'People publicly discussing buying or selling a home in Austin',
  geography: 'Austin, Texas',
  entityUnit: 'post',
  signalKind: 'social_engagement',
  ladderStage: 'research',
  providerQuery: { opportunity_intent_lane: 'buyer_intent', locations: ['Austin, Texas'] },
} as unknown as PlanPlayInput

const genericPlay: PlanPlayInput = {
  ...realtorPlay,
  audience: 'Austin dog owners',
  signal: 'People publicly asking for a dog walker in Austin',
  providerQuery: { locations: ['Austin, Texas'] },
} as unknown as PlanPlayInput

describe('official X and Threads sources: registry, lanes, routing, and plan', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('registers xAI on its deployment gate and Threads only with a resolved customer grant', () => {
    process.env = { ...saved, NODE_ENV: 'production', OM_TEST_MODE: undefined, ...xaiEnv, ...threadsEnv }
    const withoutGrant = sourceAdapterRegistry()
    expect(Object.keys(withoutGrant)).toContain(XAI_X_SEARCH_ADAPTER_ID)
    expect(Object.keys(withoutGrant)).not.toContain(THREADS_KEYWORD_SEARCH_ADAPTER_ID)
    const withGrant = sourceAdapterRegistry({ threadsConnection: connection })
    expect(Object.keys(withGrant)).toContain(THREADS_KEYWORD_SEARCH_ADAPTER_ID)
    process.env = { ...saved, NODE_ENV: 'production', OM_TEST_MODE: undefined, ...xaiEnv, ...threadsEnv, GTM_THREADS_KEYWORD_SEARCH_APP_REVIEW_APPROVED: 'false' }
    expect(Object.keys(sourceAdapterRegistry({ threadsConnection: connection }))).not.toContain(THREADS_KEYWORD_SEARCH_ADAPTER_ID)
  })

  it('freezes contract-bearing lanes for both official sources', () => {
    const xLanes = buildOpportunityQueryLanes(realtorPlay, XAI_X_SEARCH_ADAPTER_ID)
    expect(xLanes).toHaveLength(3)
    expect(xLanes[0]!.query).toBe('people in Austin who say they are looking to buy a home or are house hunting right now')
    expect(xLanes[0]!.providerQuery).toMatchObject({
      query_lane_version: 'opportunity-query-v96',
      xai_x_search_contract_version: 'official-x-search-v1',
      social_public_post_contract_version: 'official-public-posts-v1',
      social_window_days: 30,
      social_returned_content_filter_version: 'realtor-public-post-v2',
      social_filter_required_intent: 'buyer_intent',
      social_filter_require_location: true,
      opportunity_intent_lane: 'buyer_intent',
    })
    const threadsLanes = buildOpportunityQueryLanes(realtorPlay, THREADS_KEYWORD_SEARCH_ADAPTER_ID)
    expect(threadsLanes.map((lane) => lane.query)).toEqual(['Austin house hunting', 'Austin first time home buyer', 'moving to Austin buying a house'])
    expect(threadsLanes[0]!.providerQuery).toMatchObject({
      threads_keyword_search_contract_version: 'official-keyword-search-v1',
      threads_search_type: 'RECENT',
      social_returned_content_filter_version: 'realtor-public-post-v2',
    })
    // Generic plays keep the authored seeds, bound to the market, and carry no
    // realtor returned-content gate.
    const generic = buildOpportunityQueryLanes(genericPlay, THREADS_KEYWORD_SEARCH_ADAPTER_ID)
    expect(generic.length).toBeGreaterThan(0)
    expect(generic[0]!.query.toLowerCase()).toContain('austin')
    expect(generic[0]!.providerQuery.social_returned_content_filter_version).toBeUndefined()
    expect(generic[0]!.providerQuery.threads_keyword_search_contract_version).toBe('official-keyword-search-v1')
    expect(opportunitySourceRouting(realtorPlay, XAI_X_SEARCH_ADAPTER_ID)).toEqual({ eligible: true, reason: null })
    expect(opportunitySourceRouting(realtorPlay, THREADS_KEYWORD_SEARCH_ADAPTER_ID)).toEqual({ eligible: true, reason: null })
  })

  it('names the lanes it had no raw capacity for instead of dropping them silently', () => {
    const xai = createXaiXSearchOpportunityAdapter({ env: xaiEnv })
    const threads = createThreadsKeywordSearchAdapter({ env: threadsEnv, connection })
    const plan = buildSourcePlan(realtorPlay, [xai, threads], { targetAccepted: 5, maxRawCandidates: 1 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const capacity = plan.unsupportedDimensions.filter((entry) => entry.dimension === 'capacity')
    expect(capacity.length).toBeGreaterThan(0)
    expect(capacity[0]!.reason).toMatch(/raise maxRawCandidates above 1/)
    // Still one entry per adapter, never one per lane.
    expect(new Set(capacity.map((entry) => entry.adapter_id)).size).toBe(capacity.length)
  })

  it('prices both sources into a frozen plan with the Threads lane at the credit floor', () => {
    const xai = createXaiXSearchOpportunityAdapter({ env: xaiEnv })
    const threads = createThreadsKeywordSearchAdapter({ env: threadsEnv, connection })
    const plan = buildSourcePlan(realtorPlay, [xai, threads], { targetAccepted: 5, maxRawCandidates: 30 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const xaiBatches = plan.adapterPlan.filter((batch) => batch.adapter_id === XAI_X_SEARCH_ADAPTER_ID)
    const threadsBatches = plan.adapterPlan.filter((batch) => batch.adapter_id === THREADS_KEYWORD_SEARCH_ADAPTER_ID)
    expect(xaiBatches.length).toBeGreaterThan(0)
    expect(threadsBatches.length).toBeGreaterThan(0)
    for (const batch of threadsBatches) {
      expect(batch.providerUnits).toBe(1)
      expect(batch.estimatedCredits).toBe(1)
      expect(batch.providerQuery?.threads_keyword_search_contract_version).toBe('official-keyword-search-v1')
    }
    for (const batch of xaiBatches) {
      expect(batch.providerUnits).toBeCloseTo(85, 6)
      // 85 millidollars x 250 credits x 2 markup.
      expect(batch.estimatedCredits).toBe(42_500)
      expect(batch.providerQuery?.xai_x_search_contract_version).toBe('official-x-search-v1')
    }
    expect(plan.unsupportedDimensions).toEqual([])
  })

  it('publishes the three official-source catalog rows without runtime fields', () => {
    const catalog = selectedProviderCatalog(2)
    const ids = catalog.items.map((row) => row.id)
    expect(ids).toEqual(expect.arrayContaining(['xai-x-search-discovery', 'x-api-post-lookup', 'threads-keyword-search']))
    const xai = catalog.items.find((row) => row.id === 'xai-x-search-discovery')!
    expect(xai.provider).toBe('xAI')
    expect(xai.provider_usd_per_unit).toBeCloseTo(0.085, 6)
    expect(xai.estimated_noli_credits_per_unit).toBe(42_500)
    const x = catalog.items.find((row) => row.id === 'x-api-post-lookup')!
    expect(x).toMatchObject({ provider: 'X', provider_usd_per_unit: 0.005, estimated_noli_credits_per_unit: 2_500 })
    const threads = catalog.items.find((row) => row.id === 'threads-keyword-search')!
    expect(threads).toMatchObject({ provider: 'Meta', provider_usd_per_unit: 0, estimated_noli_credits_per_unit: 1 })
  })
})
