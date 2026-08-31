import type { ApifyRunOutcome } from '../adapters/apify/client'
import {
  APIFY_FACEBOOK_OPPORTUNITY_CONFIG,
  createApifyFacebookOpportunityAdapter,
  normalizeFacebookOpportunity,
  publicSocialOpportunityApproved,
  publicSocialOpportunityEnabled,
} from '../adapters/apify/public-social-opportunity-source'
import { APIFY_REQUIRED_PRICE_VERSION, APIFY_REQUIRED_TERMS_VERSION } from '../adapters/apify/source'
import type { SourceSearchPlan } from '../adapters/types'
import {
  buildOpportunityQueryLanes,
  opportunitySourceRouting,
} from '../research/opportunity-query-lanes'

const CLOCK = new Date('2026-08-31T19:00:00.000Z')
const now = () => CLOCK

function approvedEnv(overrides: Record<string, string> = {}) {
  const config = APIFY_FACEBOOK_OPPORTUNITY_CONFIG
  return {
    GTM_APIFY_ENABLED: 'true',
    GTM_APIFY_ACCOUNT_TIER: 'BRONZE',
    GTM_APIFY_TOKEN: 'synthetic-facebook-token',
    GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
    GTM_APIFY_TERMS_VERSION: APIFY_REQUIRED_TERMS_VERSION,
    GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
    [config.enabledEnv!]: 'true',
    [config.useApprovalEnv]: 'true',
    [config.priceVersionEnv]: config.requiredPriceVersion,
    ...overrides,
  }
}

function plan(query = 'Austin first time home buyer'): SourceSearchPlan {
  return {
    signal_kind: 'social_engagement',
    entity_unit: 'opportunities',
    geography: 'US',
    query,
    provider_query: {
      query_lane_version: 'opportunity-query-v74',
      source_query_lane_id: 'buyer_intent:1',
      opportunity_intent_lane: 'buyer_intent',
      search_query: query,
      source_search_keywords: [query],
      locations: ['Austin, Texas'],
      social_public_post_contract_version: 'public-posts-v1',
      social_returned_content_filter_version: 'realtor-public-post-v2',
      social_filter_required_intent: 'buyer_intent',
      social_filter_require_location: true,
      social_window_days: 30,
      facebook_search_contract_version: 'public-search-posts-v1',
      facebook_search_type: 'posts',
    },
    max_candidates: 10,
    max_charge_usd: 0.01,
  }
}

function facebookPost(overrides: Record<string, unknown> = {}) {
  return {
    type: 'post',
    name: 'Austin Public Homebuyers',
    facebookId: 'facebook-post-1',
    postId: 'facebook-post-1',
    url: 'https://www.facebook.com/groups/austinhomebuyers/posts/facebook-post-1/',
    profileUrl: 'https://www.facebook.com/austin.public.author',
    snippet: 'Austin, Texas question',
    description: 'We are looking to buy a home in Austin, Texas this month. Which neighborhoods should we consider?',
    authorName: 'Austin Public Author',
    timestamp: '2026-08-29T16:00:00.000Z',
    isPrivate: false,
    isSponsored: false,
    ...overrides,
  }
}

function outcome(
  item: Record<string, unknown>,
  overrides: Partial<ApifyRunOutcome> = {},
): ApifyRunOutcome {
  return {
    kind: 'ok',
    status: 'ok',
    items: [item],
    actorId: APIFY_FACEBOOK_OPPORTUNITY_CONFIG.actorId,
    runId: 'synthetic-facebook-run',
    itemCount: 1,
    httpStatus: 201,
    retryAfterSeconds: null,
    bodySnippet: null,
    requestUrl: 'https://api.apify.com/v2/acts/redacted/runs?token=[redacted]',
    attemptedAt: CLOCK.toISOString(),
    error: null,
    billingFinalized: true,
    chargedEventCounts: {
      'apify-actor-start': 1,
      'apify-default-dataset-item': 1,
    },
    providerCostUsd: 0.0055,
    pricingModel: 'PAY_PER_EVENT',
    ...overrides,
  }
}

describe('Apify Facebook public-post opportunities', () => {
  it('pins the exact posts-only actor, build, Starter rates, and bounded quote', () => {
    expect(APIFY_FACEBOOK_OPPORTUNITY_CONFIG).toMatchObject({
      actorId: 'scrapesmith/facebook-search-scraper',
      actorBuild: '0.0.6',
      requiredPriceVersion: 'scrapesmith-facebook-search-0.0.6-starter-events-2026-08-31',
      eventPricesUsd: {
        'apify-actor-start': 0.005,
        'apify-default-dataset-item': 0.0005,
      },
      perItemQuoteUsd: 0.0005,
      oneTimeQuoteUsd: 0.005,
      maxBatch: 10,
    })
  })

  it('fails closed unless every capability, source-use, actor, and price gate matches', () => {
    const config = APIFY_FACEBOOK_OPPORTUNITY_CONFIG
    const env = approvedEnv()
    expect(publicSocialOpportunityApproved(config, env)).toBe(true)
    expect(publicSocialOpportunityEnabled(config, env)).toBe(true)
    expect(publicSocialOpportunityEnabled(config, {
      ...env,
      [config.enabledEnv!]: 'false',
    })).toBe(false)
    expect(publicSocialOpportunityApproved(config, {
      ...env,
      [config.priceVersionEnv]: 'stale',
    })).toBe(false)
    expect(publicSocialOpportunityApproved(config, {
      ...env,
      [config.actorEnv]: 'another/actor',
    })).toBe(false)
  })

  it('routes only realtor plays and emits three frozen source-specific lanes', () => {
    const realtorPlay = {
      audience: 'Austin first-time home buyers',
      signal: 'People publicly asking for help buying a home',
      geography: 'Austin, Texas',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
    }
    expect(opportunitySourceRouting(
      realtorPlay,
      APIFY_FACEBOOK_OPPORTUNITY_CONFIG.adapterId,
    )).toEqual({ eligible: true, reason: null })
    const lanes = buildOpportunityQueryLanes(
      realtorPlay,
      APIFY_FACEBOOK_OPPORTUNITY_CONFIG.adapterId,
    )
    expect(lanes.map((lane) => lane.query)).toEqual([
      'Austin first time home buyer',
      'Austin house hunting',
      'moving to Austin home',
    ])
    expect(lanes.every((lane) =>
      lane.providerQuery.query_lane_version === 'opportunity-query-v74'
      && lane.providerQuery.facebook_search_contract_version === 'public-search-posts-v1'
      && lane.providerQuery.facebook_search_type === 'posts'
      && lane.providerQuery.social_returned_content_filter_version === 'realtor-public-post-v2'
      && lane.providerQuery.social_filter_require_location === true
      && lane.providerQuery.social_window_days === 30
    )).toBe(true)
    expect(opportunitySourceRouting(
      {
        audience: 'Austin restaurant diners',
        signal: 'People discussing dinner plans',
        geography: 'Austin, Texas',
        providerQuery: { opportunity_intent_lane: 'local_audience' },
      },
      APIFY_FACEBOOK_OPPORTUNITY_CONFIG.adapterId,
    ).eligible).toBe(false)
  })

  it('builds the exact metered input and accepts only returned-content evidence', async () => {
    const runActor = jest.fn(async () => outcome(facebookPost()))
    const adapter = createApifyFacebookOpportunityAdapter({ env: approvedEnv(), now, runActor })
    const searchPlan = plan()

    expect(adapter.quote(searchPlan)).toMatchObject({
      max_candidates: 10,
      provider_units: 10,
    })
    const result = await adapter.search(searchPlan)
    expect(runActor).toHaveBeenCalledWith(
      APIFY_FACEBOOK_OPPORTUNITY_CONFIG.actorId,
      {
        queries: ['Austin first time home buyer'],
        searchType: 'posts',
        maxResultsPerQuery: 10,
      },
      expect.objectContaining({
        build: '0.0.6',
        maxChargeUsd: 0.01,
        maxItems: 10,
      }),
    )
    expect(result).toMatchObject({
      status: 'ok',
      cost_units: 5.5,
      data: [{
        identity: {
          platform: 'Facebook',
          opportunity_kind: 'post',
          intent_kind: 'buyer_intent',
          location: 'Austin, Texas',
          source_published_at: '2026-08-29T16:00:00.000Z',
        },
      }],
      receipt: expect.objectContaining({
        charged_event_counts: {
          'apify-actor-start': 1,
          'apify-default-dataset-item': 1,
        },
        provider_cost_usd: 0.0055,
        returned_content_filter_version: 'realtor-public-post-v2',
      }),
    })
  })

  it('rejects stale, private, sponsored, unsafe, and off-platform rows', () => {
    const context = {
      query: 'Austin first time home buyer',
      location: 'Austin, Texas',
      expectedIntent: 'buyer_intent' as const,
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_FACEBOOK_OPPORTUNITY_CONFIG.actorId,
    }
    expect(normalizeFacebookOpportunity(facebookPost({
      timestamp: '2026-07-01T00:00:00.000Z',
    }), context)).toBeNull()
    expect(normalizeFacebookOpportunity(facebookPost({ isPrivate: true }), context)).toBeNull()
    expect(normalizeFacebookOpportunity(facebookPost({ isSponsored: true }), context)).toBeNull()
    expect(normalizeFacebookOpportunity(facebookPost({
      url: 'https://example.com/posts/facebook-post-1',
    }), context)).toBeNull()
    expect(normalizeFacebookOpportunity(facebookPost({
      description: 'Austin foreclosure distress targeting for a home sale.',
    }), context)).toBeNull()
  })

  it('does not let the paid search query manufacture intent', async () => {
    const returned = facebookPost({
      description: 'A beautiful Austin, Texas kitchen inspiration board with blue cabinets.',
    })
    const result = await createApifyFacebookOpportunityAdapter({
      env: approvedEnv(),
      now,
      runActor: jest.fn(async () => outcome(returned)),
    }).search(plan())

    expect(result).toMatchObject({
      status: 'no_result',
      data: null,
      cost_units: 5.5,
      error: 'no_result_after_returned_content_filter',
      receipt: expect.objectContaining({
        returned_content_filter_version: 'realtor-public-post-v2',
        returned_content_filtered_rows: 1,
      }),
    })
  })

  it('refuses contract drift and parks billing ambiguity instead of guessing', async () => {
    const runActor = jest.fn(async () => outcome(facebookPost()))
    const adapter = createApifyFacebookOpportunityAdapter({ env: approvedEnv(), now, runActor })
    const wrongType = await adapter.search({
      ...plan(),
      provider_query: { ...plan().provider_query, facebook_search_type: 'all' },
    })
    expect(wrongType).toMatchObject({ status: 'error', cost_units: 0 })
    expect(runActor).not.toHaveBeenCalled()

    runActor.mockImplementationOnce(async () => outcome(facebookPost(), {
      chargedEventCounts: {
        'apify-actor-start': 1,
        'apify-default-dataset-item': 0,
      },
      providerCostUsd: 0.005,
    }))
    const mismatch = await adapter.search(plan())
    expect(mismatch).toMatchObject({ status: 'ambiguous', cost_units: null })
  })
})
