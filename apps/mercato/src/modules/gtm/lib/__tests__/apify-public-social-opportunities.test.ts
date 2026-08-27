import type { ApifyRunOutcome } from '../adapters/apify/client'
import {
  APIFY_REDDIT_OPPORTUNITY_CONFIG,
  APIFY_X_OPPORTUNITY_CONFIG,
  createApifyRedditOpportunityAdapter,
  createApifyXOpportunityAdapter,
  normalizeRedditOpportunity,
  normalizeXOpportunity,
  publicSocialOpportunityApproved,
  publicSocialOpportunityEnabled,
} from '../adapters/apify/public-social-opportunity-source'
import { APIFY_REQUIRED_PRICE_VERSION, APIFY_REQUIRED_TERMS_VERSION } from '../adapters/apify/source'
import type { SourceSearchPlan } from '../adapters/types'
import { buildSourcePlan } from '../research/plan'

const CLOCK = new Date('2026-08-26T23:00:00.000Z')
const now = () => CLOCK

function envFor(config: typeof APIFY_REDDIT_OPPORTUNITY_CONFIG) {
  return {
    GTM_APIFY_ENABLED: 'true',
    GTM_APIFY_TOKEN: 'synthetic-social-token',
    GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
    GTM_APIFY_TERMS_VERSION: APIFY_REQUIRED_TERMS_VERSION,
    GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
    [config.useApprovalEnv]: 'true',
    [config.priceVersionEnv]: config.requiredPriceVersion,
  }
}

const plan: SourceSearchPlan = {
  signal_kind: 'social_engagement',
  entity_unit: 'opportunities',
  geography: 'US',
  query: 'South Bay home buyers and sellers',
  provider_query: {
    source_search_keywords: ['South Bay buying or selling a home'],
    locations: ['South Bay, California'],
    recency_window: 'last 7 days',
  },
  max_candidates: 5,
  max_charge_usd: 0.02,
}

function redditPost(overrides: Record<string, unknown> = {}) {
  return {
    _type: 'post',
    _status: 'found',
    id: 't3_example',
    title: 'Moving to the South Bay and looking to buy a home',
    author: 'local_question',
    subreddit: 'SouthBayLA',
    score: 12,
    commentCount: 8,
    createdAt: '2026-08-25T17:00:00.000Z',
    permalink: '/r/SouthBayLA/comments/example/moving_to_the_south_bay/',
    body: 'Which neighborhoods should a first-time buyer compare?',
    isNsfw: false,
    isLocked: false,
    isArchived: false,
    subredditInfo: {
      subscribersCount: 82_000,
      isNsfw: false,
      isQuarantined: false,
    },
    ...overrides,
  }
}

function xPost(overrides: Record<string, unknown> = {}) {
  return {
    postText: 'Thinking about selling our South Bay home. What should we prepare first?',
    postUrl: 'https://x.com/example/status/123',
    timestamp: Date.parse('2026-08-25T18:00:00.000Z'),
    postId: '123',
    author: {
      name: 'Jamie Example',
      screenName: 'example',
      description: 'South Bay homeowner',
    },
    replyCount: 4,
    quoteCount: 2,
    repostCount: 1,
    favouriteCount: 18,
    ...overrides,
  }
}

function outcome(
  config: typeof APIFY_REDDIT_OPPORTUNITY_CONFIG,
  item: Record<string, unknown>,
  values: Partial<ApifyRunOutcome> = {},
): ApifyRunOutcome {
  const counts =
    config.platform === 'Reddit'
      ? {
          'apify-actor-start': 1,
          'apify-default-dataset-item': 1,
          'result-scraped': 1,
        }
      : { init: 1, 'result-item': 1 }
  const providerCostUsd = Object.entries(counts).reduce(
    (sum, [event, count]) => sum + (config.eventPricesUsd[event] ?? 0) * count,
    0,
  )
  return {
    kind: 'ok',
    status: 'ok',
    items: [item],
    actorId: config.actorId,
    runId: 'synthetic-run',
    itemCount: 1,
    httpStatus: 201,
    retryAfterSeconds: null,
    bodySnippet: null,
    requestUrl: `https://api.apify.com/v2/acts/${config.actorId.replace('/', '~')}/runs?token=[redacted]`,
    attemptedAt: CLOCK.toISOString(),
    error: null,
    billingFinalized: true,
    chargedEventCounts: counts,
    providerCostUsd,
    pricingModel: 'PAY_PER_EVENT',
    ...values,
  }
}

describe('Apify public social demand opportunities', () => {
  it('pins X reservations to the production FREE account tier', () => {
    expect(APIFY_X_OPPORTUNITY_CONFIG).toMatchObject({
      actorBuild: '0.0.153',
      requiredPriceVersion: 'scraper-one-x-post-search-0.0.153-free-events-2026-08-27',
      eventPricesUsd: { init: 0.025, 'result-item': 0.00125 },
      oneTimeQuoteUsd: 0.025,
      perItemQuoteUsd: 0.00125,
    })
  })

  it('keeps the high-fixed-cost X source held unless its capability switch is explicit', () => {
    const env = envFor(APIFY_X_OPPORTUNITY_CONFIG)
    expect(publicSocialOpportunityEnabled(APIFY_X_OPPORTUNITY_CONFIG, env)).toBe(false)
    expect(
      publicSocialOpportunityEnabled(APIFY_X_OPPORTUNITY_CONFIG, {
        ...env,
        GTM_APIFY_X_OPPORTUNITY_ENABLED: 'true',
      }),
    ).toBe(true)
    expect(
      publicSocialOpportunityEnabled(
        APIFY_REDDIT_OPPORTUNITY_CONFIG,
        envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      ),
    ).toBe(true)
  })

  it.each([[APIFY_REDDIT_OPPORTUNITY_CONFIG], [APIFY_X_OPPORTUNITY_CONFIG]])(
    'requires the exact actor, use approval, and price version for $platform',
    (config) => {
      const env = envFor(config)
      expect(publicSocialOpportunityApproved(config, env)).toBe(true)
      expect(
        publicSocialOpportunityApproved(config, {
          ...env,
          [config.useApprovalEnv]: 'false',
        }),
      ).toBe(false)
      expect(
        publicSocialOpportunityApproved(config, {
          ...env,
          [config.priceVersionEnv]: 'stale-price',
        }),
      ).toBe(false)
      expect(
        publicSocialOpportunityApproved(config, {
          ...env,
          [config.actorEnv]: 'another/actor',
        }),
      ).toBe(false)
    },
  )

  it('normalizes an active public Reddit buyer thread with community scale', () => {
    const candidate = normalizeRedditOpportunity(redditPost(), {
      query: plan.query,
      location: 'South Bay, California',
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
    })
    expect(candidate).toMatchObject({
      entity_kind: 'opportunity',
      identity: {
        opportunity_kind: 'thread',
        platform: 'Reddit',
        intent_kind: 'buyer_intent',
        engagement_count: 20,
        member_count: 82_000,
        access_type: 'public',
        source_published_at: '2026-08-25T17:00:00.000Z',
        people_to_follow: [{ name: 'local_question' }],
      },
      evidence: [
        {
          source_url: 'https://www.reddit.com/r/SouthBayLA/comments/example/moving_to_the_south_bay/',
          observed_at: CLOCK.toISOString(),
        },
      ],
    })
  })

  it('drops locked, archived, NSFW, quarantined, and sensitive Reddit posts', () => {
    const context = {
      query: plan.query,
      location: 'South Bay, California',
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
    }
    for (const row of [
      redditPost({ isLocked: true }),
      redditPost({ isArchived: true }),
      redditPost({ isNsfw: true }),
      redditPost({ subredditInfo: { isQuarantined: true } }),
      redditPost({ title: 'Foreclosure distress discussion' }),
    ])
      expect(normalizeRedditOpportunity(row, context)).toBeNull()
  })

  it('normalizes a public X seller post and visible engagement', () => {
    const candidate = normalizeXOpportunity(xPost(), {
      query: plan.query,
      location: 'South Bay, California',
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_X_OPPORTUNITY_CONFIG.actorId,
    })
    expect(candidate).toMatchObject({
      entity_kind: 'opportunity',
      identity: {
        opportunity_kind: 'post',
        platform: 'X',
        intent_kind: 'seller_intent',
        engagement_count: 25,
        source_published_at: '2026-08-25T18:00:00.000Z',
        people_to_follow: [
          {
            name: 'Jamie Example',
            profile_url: 'https://x.com/example',
          },
        ],
      },
      evidence: [{ source_url: 'https://x.com/example/status/123', observed_at: CLOCK.toISOString() }],
    })
  })

  it('keeps missing publication time unknown instead of substituting retrieval time', () => {
    const candidate = normalizeRedditOpportunity(redditPost({ createdAt: null }), {
      query: plan.query,
      location: 'South Bay, California',
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
    })
    expect(candidate?.identity.source_published_at).toBeNull()
    expect(candidate?.evidence[0]?.observed_at).toBe(CLOCK.toISOString())
  })

  it('keeps Reddit and X intent independent from the targeting query', () => {
    const context = {
      query: 'people preparing to sell a home',
      location: 'South Bay, California',
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
    }
    const reddit = normalizeRedditOpportunity(
      redditPost({ title: 'South Bay neighborhood community breakfast', body: 'Local residents are welcome.' }),
      context,
    )
    const x = normalizeXOpportunity(
      xPost({ postText: 'South Bay neighborhood community breakfast for local residents.' }),
      { ...context, actorId: APIFY_X_OPPORTUNITY_CONFIG.actorId },
    )
    expect(reddit?.identity.intent_kind).toBe('local_audience')
    expect(x?.identity.intent_kind).toBe('local_audience')
  })

  it('drops vulnerable housing-crisis conversations before they become candidates', () => {
    const context = {
      query: 'Tampa local housing questions',
      location: 'Tampa, Florida',
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
    }
    expect(
      normalizeRedditOpportunity(
        redditPost({
          title: 'How can I achieve housing independence?',
          body: 'I am in opioid recovery, currently in sober living, and dealing with a predatory landlord.',
        }),
        context,
      ),
    ).toBeNull()
  })

  it('does not stamp the requested market onto unrelated returned posts', () => {
    const context = {
      query: 'Austin home seller question',
      location: 'Austin, Texas',
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
    }
    const reddit = normalizeRedditOpportunity(
      redditPost({
        title: 'OfferUp seller preparing to move collectibles',
        body: 'A card seller is packing a collection.',
        subreddit: 'collectibles',
      }),
      context,
    )
    const x = normalizeXOpportunity(
      xPost({
        postText: 'Generic seller preparing to move a collection.',
        author: { name: 'Example', screenName: 'example', description: 'Collector' },
      }),
      { ...context, actorId: APIFY_X_OPPORTUNITY_CONFIG.actorId },
    )
    expect(reddit?.identity.location).toBeNull()
    expect(reddit?.identity.provider_location).toBe('Austin, Texas')
    expect(x?.identity.location).toBeNull()
    expect(x?.identity.provider_location).toBe('Austin, Texas')
  })

  it('uses an actually returned, frozen market subreddit as location evidence', () => {
    const candidate = normalizeRedditOpportunity(
      redditPost({
        title: 'Thinking of selling our home this fall',
        body: 'We are considering selling and would value local advice.',
        subreddit: 'AustinHousing',
      }),
      {
        query: 'self:yes "selling our home"',
        location: 'Austin, Texas',
        scopedSubreddits: ['Austin', 'AskAustin', 'AustinHousing'],
        attemptedAt: CLOCK.toISOString(),
        actorId: APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
      },
    )

    expect(candidate?.identity.location).toBe('Austin, Texas')
    expect(candidate?.evidence[0]?.detail).toMatchObject({
      subreddit: 'AustinHousing',
      location_basis: 'scoped_returned_subreddit',
    })
  })

  it('passes frozen subreddit scopes to the actor and keeps auto-discovery off', async () => {
    const runActor = jest.fn(async () => outcome(APIFY_REDDIT_OPPORTUNITY_CONFIG, redditPost()))
    const adapter = createApifyRedditOpportunityAdapter({
      env: envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      now,
      runActor,
    })
    await adapter.search({
      ...plan,
      provider_query: {
        ...plan.provider_query,
        reddit_subreddits: ['Austin', 'AskAustin', 'AustinHousing'],
      },
    })

    expect(runActor).toHaveBeenCalledWith(
      APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
      expect.objectContaining({
        subreddits: ['Austin', 'AskAustin', 'AustinHousing'],
        autoDiscoverSubreddits: false,
        sort: 'new',
      }),
      expect.any(Object),
    )
  })

  it('builds bounded, posts-only, recent inputs from one approved discovery phrase', async () => {
    const redditRun = jest.fn(async () => outcome(APIFY_REDDIT_OPPORTUNITY_CONFIG, redditPost()))
    const reddit = createApifyRedditOpportunityAdapter({
      env: envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      now,
      runActor: redditRun,
    })
    await reddit.search(plan)
    expect(redditRun).toHaveBeenCalledWith(
      APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
      {
        query: 'South Bay buying or selling a home',
        maxResults: 5,
        contentType: 'posts',
        sort: 'new',
        timeFilter: 'week',
        subreddits: [],
        autoDiscoverSubreddits: false,
      },
      expect.objectContaining({
        build: APIFY_REDDIT_OPPORTUNITY_CONFIG.actorBuild,
        maxChargeUsd: 0.02,
      }),
    )

    const xRun = jest.fn(async () => outcome(APIFY_X_OPPORTUNITY_CONFIG, xPost()))
    const x = createApifyXOpportunityAdapter({
      env: envFor(APIFY_X_OPPORTUNITY_CONFIG),
      now,
      runActor: xRun,
    })
    await x.search(plan)
    expect(xRun).toHaveBeenCalledWith(
      APIFY_X_OPPORTUNITY_CONFIG.actorId,
      {
        query: 'South Bay buying or selling a home',
        resultsCount: 5,
        timeWindow: 7,
        searchType: 'latest',
      },
      expect.objectContaining({ build: APIFY_X_OPPORTUNITY_CONFIG.actorBuild }),
    )
  })

  it.each([
    [APIFY_REDDIT_OPPORTUNITY_CONFIG, createApifyRedditOpportunityAdapter, redditPost(), 'Reddit'],
    [APIFY_X_OPPORTUNITY_CONFIG, createApifyXOpportunityAdapter, xPost(), 'X'],
  ] as const)(
    'settles exact finalized $platform events and returns opportunities',
    async (config, create, row, platform) => {
      const result = await create({
        env: envFor(config),
        now,
        runActor: async () => outcome(config, row),
      }).search(plan)
      expect(result.status).toBe('ok')
      expect(result.data?.[0]).toMatchObject({
        entity_kind: 'opportunity',
        identity: { platform },
      })
      expect(result.cost_units).toBeGreaterThan(0)
      expect(result.receipt).toMatchObject({
        actor_id: config.actorId,
        actor_build: config.actorBuild,
        billed_results: 1,
        billing_finalized: true,
      })
    },
  )

  it('parks billing vocabulary drift instead of guessing or refunding', async () => {
    const config = APIFY_X_OPPORTUNITY_CONFIG
    const result = await createApifyXOpportunityAdapter({
      env: envFor(config),
      now,
      runActor: async () =>
        outcome(config, xPost(), {
          chargedEventCounts: { init: 1, 'result-item': 1, surprise: 1 },
        }),
    }).search(plan)
    expect(result).toMatchObject({ status: 'ambiguous', cost_units: null })
    expect(result.error).toContain('unapproved public social event')
  })

  it('rejects sensitive demand queries before any actor contact', async () => {
    const runActor = jest.fn()
    const result = await createApifyRedditOpportunityAdapter({
      env: envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      now,
      runActor,
    }).search({
      ...plan,
      provider_query: {
        source_search_keywords: ['South Bay foreclosure distress'],
      },
    })
    expect(result).toMatchObject({ status: 'error', cost_units: 0 })
    expect(result.error).toContain('sensitive consumer demand research is blocked')
    expect(runActor).not.toHaveBeenCalled()
  })

  it('plans Reddit and one fixed-charge-aware X shortfall lane', () => {
    const adapters = [
      createApifyRedditOpportunityAdapter({
        env: envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      }),
      createApifyXOpportunityAdapter({
        env: envFor(APIFY_X_OPPORTUNITY_CONFIG),
      }),
    ]
    const result = buildSourcePlan(
      {
        marketType: 'b2c',
        geography: 'California, US',
        signalKind: 'social_engagement',
        entityUnit: 'opportunities',
        audience: 'South Bay home buyers and sellers',
        signal: 'social_engagement',
        providerQuery: plan.provider_query,
      },
      adapters,
      { targetAccepted: 10, maxRawCandidates: 20 },
      2,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.adapterPlan.map((batch) => batch.adapter_id)).toEqual([
        APIFY_REDDIT_OPPORTUNITY_CONFIG.adapterId,
        APIFY_REDDIT_OPPORTUNITY_CONFIG.adapterId,
        APIFY_REDDIT_OPPORTUNITY_CONFIG.adapterId,
        APIFY_X_OPPORTUNITY_CONFIG.adapterId,
      ])
      expect(result.adapterPlan.reduce((sum, batch) => sum + batch.maxCandidates, 0)).toBe(20)
      expect(new Set(result.adapterPlan.map((batch) => `${batch.adapter_id}:${batch.queryLaneId}`)).size).toBe(4)
      expect(result.adapterPlan.every((batch) => batch.billableUnit === 'apify_millidollar')).toBe(true)
    }
  })
})
