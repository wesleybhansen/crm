import type { ApifyRunOutcome } from '../adapters/apify/client'
import {
  APIFY_REDDIT_API_OPPORTUNITY_CONFIG,
  createApifyRedditApiOpportunityAdapter,
  normalizeScopedRedditApiOpportunity,
  publicSocialOpportunityEnabled,
} from '../adapters/apify/public-social-opportunity-source'
import { APIFY_REQUIRED_PRICE_VERSION, APIFY_REQUIRED_TERMS_VERSION } from '../adapters/apify/source'
import type { SourceSearchPlan } from '../adapters/types'
import {
  buildOpportunityQueryLanes,
  opportunitySourceRouting,
} from '../research/opportunity-query-lanes'

const CLOCK = new Date('2026-08-31T20:00:00.000Z')
const now = () => CLOCK
const config = APIFY_REDDIT_API_OPPORTUNITY_CONFIG

function approvedEnv(overrides: Record<string, string> = {}) {
  return {
    GTM_APIFY_ENABLED: 'true',
    GTM_APIFY_ACCOUNT_TIER: 'BRONZE',
    GTM_APIFY_TOKEN: 'synthetic-social-token',
    GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
    GTM_APIFY_TERMS_VERSION: APIFY_REQUIRED_TERMS_VERSION,
    GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
    GTM_APIFY_REDDIT_API_OPPORTUNITY_ENABLED: 'true',
    GTM_APIFY_REDDIT_API_OPPORTUNITY_USE_APPROVED: 'true',
    GTM_APIFY_REDDIT_API_SEARCH_PRICE_VERSION: config.requiredPriceVersion,
    ...overrides,
  }
}

function phoenixBuyer(overrides: Record<string, unknown> = {}) {
  return {
    dataType: 'post',
    id: 't3_sanitized_phoenix_buyer',
    url: 'https://www.reddit.com/r/phoenix/comments/sanitized/moon_valley_question/',
    createdAt: '2026-08-22T05:18:40.000Z',
    scrapedAt: CLOCK.toISOString(),
    title: 'What is the neighborhood like?',
    body: 'We are looking to buy but not get too far out. What is the neighborhood like and how is the commute?',
    communityName: 'r/phoenix',
    parsedCommunityName: 'phoenix',
    numberOfComments: 14,
    upVotes: 9,
    username: 'sanitized_buyer',
    over18: false,
    isAd: false,
    isVideo: false,
    ...overrides,
  }
}

function buyerLanes() {
  return buildOpportunityQueryLanes({
    geography: 'Phoenix, Arizona, United States',
    audience: 'Phoenix home buyers looking for a realtor',
    signal: 'A current public question demonstrates a residential purchase decision.',
    providerQuery: { opportunity_intent_lane: 'buyer_intent' },
  }, config.adapterId)
}

function searchPlan(query = buyerLanes()[0]!.query): SourceSearchPlan {
  const lane = buyerLanes().find((candidate) => candidate.query === query) ?? buyerLanes()[0]!
  return {
    signal_kind: 'social_engagement',
    entity_unit: 'opportunities',
    geography: 'US',
    query: lane.query,
    provider_query: lane.providerQuery,
    max_candidates: 10,
    max_charge_usd: 0.03,
  }
}

function outcome(
  items: Array<Record<string, unknown>>,
  chargedItems: number,
  overrides: Partial<ApifyRunOutcome> = {},
): ApifyRunOutcome {
  return {
    kind: items.length > 0 ? 'ok' : 'no_result',
    status: items.length > 0 ? 'ok' : 'no_result',
    items,
    actorId: config.actorId,
    runId: 'synthetic-practicaltools-run',
    itemCount: items.length,
    httpStatus: 201,
    retryAfterSeconds: null,
    bodySnippet: null,
    requestUrl: 'https://api.apify.com/v2/acts/practicaltools~apify-reddit-api/runs?token=[redacted]',
    attemptedAt: CLOCK.toISOString(),
    error: null,
    billingFinalized: true,
    chargedEventCounts: { item_returned: chargedItems },
    providerCostUsd: chargedItems * 0.003,
    pricingModel: 'PAY_PER_EVENT',
    ...overrides,
  }
}

describe('Apify practicaltools Reddit API opportunities', () => {
  it('pins the exact actor, build, Bronze event price, and full list-price quote', () => {
    expect(config).toMatchObject({
      actorId: 'practicaltools/apify-reddit-api',
      actorBuild: '0.0.56',
      requiredPriceVersion: 'practicaltools-apify-reddit-api-0.0.56-bronze-events-2026-08-31',
      eventPricesUsd: { item_returned: 0.003 },
      primaryResultEvent: 'item_returned',
      primaryResultCountPolicy: 'at-most-quoted-cap',
      oneTimeQuoteUsd: 0,
      perItemQuoteUsd: 0.003,
      maxBatch: 10,
    })
    const adapter = createApifyRedditApiOpportunityAdapter({ env: approvedEnv() })
    expect(adapter.quote(searchPlan())).toMatchObject({
      max_candidates: 10,
      provider_units: 30,
      expected_candidates: { low: 0, high: 10 },
    })
  })

  it('fails closed unless capability, use, actor, and exact price gates all match', () => {
    expect(publicSocialOpportunityEnabled(config, approvedEnv())).toBe(true)
    expect(publicSocialOpportunityEnabled(config, approvedEnv({
      GTM_APIFY_REDDIT_API_OPPORTUNITY_ENABLED: 'false',
    }))).toBe(false)
    expect(publicSocialOpportunityEnabled(config, approvedEnv({
      GTM_APIFY_REDDIT_API_SEARCH_PRICE_VERSION: 'stale',
    }))).toBe(false)
    expect(publicSocialOpportunityEnabled(config, approvedEnv({
      GTM_APIFY_ACTOR_REDDIT_API_SEARCH: 'another/actor',
    }))).toBe(false)
  })

  it('routes only calibrated realtor buyer plays into two market-scoped query lanes', () => {
    const lanes = buyerLanes()
    expect(lanes.map((lane) => lane.query)).toEqual(['looking to buy', 'house hunting'])
    expect(lanes.every((lane) => (
      lane.providerQuery.query_lane_version === 'opportunity-query-v81'
      && lane.providerQuery.reddit_api_contract_version === 'scoped-public-post-search-v1'
      && lane.providerQuery.reddit_api_window_days === 30
      && lane.providerQuery.reddit_subreddits?.[0] === 'Phoenix'
      && lane.providerQuery.reddit_filter_required_intent === 'buyer_intent'
      && lane.providerQuery.reddit_filter_require_location === false
    ))).toBe(true)
    expect(opportunitySourceRouting({
      geography: 'Phoenix, Arizona, United States',
      audience: 'Phoenix homeowners considering selling a home',
      signal: 'A current public question demonstrates a sale decision.',
      providerQuery: { opportunity_intent_lane: 'seller_intent' },
    }, config.adapterId)).toMatchObject({ eligible: false })
    expect(opportunitySourceRouting({
      geography: 'Phoenix, Arizona, United States',
      audience: 'People looking for local consumer software',
      signal: 'A current public question demonstrates demand.',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
    }, config.adapterId)).toMatchObject({ eligible: false })
  })

  it('freezes the provider input to one public subreddit, one phrase, posts only, and ten rows', async () => {
    const runActor = jest.fn(async () => outcome([phoenixBuyer()], 1))
    const adapter = createApifyRedditApiOpportunityAdapter({
      env: approvedEnv(),
      now,
      runActor,
    })
    await expect(adapter.search(searchPlan())).resolves.toMatchObject({ status: 'ok' })
    expect(runActor).toHaveBeenCalledWith(
      config.actorId,
      {
        startUrls: [{ url: 'https://www.reddit.com/r/Phoenix/' }],
        searches: ['looking to buy'],
        sort: 'new',
        time: 'month',
        maxItems: 10,
        includeNSFW: false,
        skipComments: true,
        skipUserPosts: true,
        skipCommunity: true,
        ignorestartUrls: false,
        searchPosts: true,
        searchComments: false,
        fetchPostComments: false,
        searchCommunities: false,
        searchUsers: false,
      },
      expect.objectContaining({
        build: '0.0.56',
        maxItems: 10,
        maxChargeUsd: 0.03,
        datasetResultEvent: 'item_returned',
      }),
    )
  })

  it('accepts an authoritative free-allowance receipt while retaining the bounded dataset', async () => {
    const adapter = createApifyRedditApiOpportunityAdapter({
      env: approvedEnv(),
      now,
      runActor: async () => outcome([phoenixBuyer()], 0),
    })
    await expect(adapter.search(searchPlan())).resolves.toMatchObject({
      status: 'ok',
      cost_units: 0,
      data: [expect.objectContaining({
        entity_kind: 'opportunity',
        identity: expect.objectContaining({
          intent_kind: 'buyer_intent',
          location: 'Phoenix, Arizona, United States',
        }),
      })],
      receipt: expect.objectContaining({
        charged_event_counts: { item_returned: 0 },
        provider_cost_usd: 0,
      }),
    })
  })

  it('reconciles a signed event count inside the quoted cap even when the actor retains fewer rows', async () => {
    const retainedRows = [
      phoenixBuyer(),
      phoenixBuyer({
        id: 't3_sanitized_sausage',
        url: 'https://www.reddit.com/r/phoenix/comments/sanitized/sausage/',
        title: 'Where can I buy sausage?',
        body: 'I am looking to buy a particular sausage in Phoenix.',
      }),
      phoenixBuyer({
        id: 't3_sanitized_vehicle',
        url: 'https://www.reddit.com/r/phoenix/comments/sanitized/vehicle/',
        title: 'Looking for a used truck',
        body: 'I am looking to buy a used truck from a local owner.',
      }),
      phoenixBuyer({
        id: 't3_sanitized_bread',
        url: 'https://www.reddit.com/r/phoenix/comments/sanitized/bread/',
        title: 'Where can I buy sourdough bread?',
        body: 'I am looking to buy fresh sourdough from a local bakery.',
      }),
      phoenixBuyer({
        id: 't3_sanitized_cards',
        url: 'https://www.reddit.com/r/phoenix/comments/sanitized/cards/',
        title: 'Card shop recommendations',
        body: 'I am looking for a shop that buys and sells trading cards.',
      }),
      phoenixBuyer({
        id: 't3_sanitized_ice',
        url: 'https://www.reddit.com/r/phoenix/comments/sanitized/ice/',
        title: 'Where can I buy ice blocks?',
        body: 'I want to buy ice blocks for a swimming pool.',
      }),
    ]
    const adapter = createApifyRedditApiOpportunityAdapter({
      env: approvedEnv(),
      now,
      runActor: async () => outcome(retainedRows, 10),
    })
    await expect(adapter.search(searchPlan())).resolves.toMatchObject({
      status: 'partial',
      cost_units: 30,
      data: [expect.objectContaining({
        identity: expect.objectContaining({ intent_kind: 'buyer_intent' }),
      })],
      receipt: expect.objectContaining({
        item_count: 6,
        charged_event_counts: { item_returned: 10 },
        provider_cost_usd: 0.03,
      }),
    })
  })

  it('reconciles paid rows and refuses events above the quoted cap or with unknown names', async () => {
    const paid = createApifyRedditApiOpportunityAdapter({
      env: approvedEnv(),
      now,
      runActor: async () => outcome([phoenixBuyer()], 1),
    })
    await expect(paid.search(searchPlan())).resolves.toMatchObject({
      status: 'ok',
      cost_units: 3,
    })

    const overCounted = createApifyRedditApiOpportunityAdapter({
      env: approvedEnv(),
      now,
      runActor: async () => outcome([phoenixBuyer()], 11),
    })
    await expect(overCounted.search(searchPlan())).resolves.toMatchObject({
      status: 'ambiguous',
      error: expect.stringContaining('immutable quoted cap'),
    })

    const unknownEvent = createApifyRedditApiOpportunityAdapter({
      env: approvedEnv(),
      now,
      runActor: async () => outcome([phoenixBuyer()], 1, {
        chargedEventCounts: { item_returned: 1, unknown_charge: 1 },
        providerCostUsd: 0.003,
      }),
    })
    await expect(unknownEvent.search(searchPlan())).resolves.toMatchObject({
      status: 'ambiguous',
      error: expect.stringContaining('unapproved public social event'),
    })
  })

  it('requires returned row and permalink scope to match the frozen subreddit', () => {
    const context = {
      query: 'looking to buy',
      location: 'Phoenix, Arizona, United States',
      expectedIntent: 'buyer_intent' as const,
      scopedSubreddits: ['Phoenix'],
      attemptedAt: CLOCK.toISOString(),
      actorId: config.actorId,
      semanticFilterVersion: 'semantic-intent-location-v4',
    }
    expect(normalizeScopedRedditApiOpportunity(phoenixBuyer(), context)).not.toBeNull()
    expect(normalizeScopedRedditApiOpportunity(phoenixBuyer({
      communityName: 'r/Denver',
      parsedCommunityName: 'Denver',
    }), context)).toBeNull()
    expect(normalizeScopedRedditApiOpportunity(phoenixBuyer({
      url: 'https://www.reddit.com/r/Denver/comments/sanitized/wrong_scope/',
    }), context)).toBeNull()
  })

  it('rejects advertisements, sensitive rows, stale rows, and product-purchase false positives', async () => {
    const adapterFor = (row: Record<string, unknown>) => createApifyRedditApiOpportunityAdapter({
      env: approvedEnv(),
      now,
      runActor: async () => outcome([row], 0),
    })
    await expect(adapterFor(phoenixBuyer({ isAd: true })).search(searchPlan())).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('no safe public opportunity'),
    })
    await expect(adapterFor(phoenixBuyer({
      body: 'My child has a medical condition and we need to buy a house.',
    })).search(searchPlan())).resolves.toMatchObject({ status: 'error' })
    await expect(adapterFor(phoenixBuyer({
      createdAt: '2026-06-01T00:00:00.000Z',
    })).search(searchPlan())).resolves.toMatchObject({ status: 'error' })
    await expect(adapterFor(phoenixBuyer({
      title: 'Where can I buy sourdough bread?',
      body: 'I am looking to buy fresh sourdough from a local bakery.',
    })).search(searchPlan())).resolves.toMatchObject({ status: 'no_result' })
  })
})
