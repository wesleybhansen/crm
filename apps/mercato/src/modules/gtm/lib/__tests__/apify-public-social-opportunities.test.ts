import type { ApifyRunOutcome } from '../adapters/apify/client'
import {
  APIFY_REDDIT_FRESH_OPPORTUNITY_CONFIG,
  APIFY_REDDIT_OPPORTUNITY_CONFIG,
  APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG,
  APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG,
  APIFY_THREADS_OPPORTUNITY_CONFIG,
  APIFY_X_OPPORTUNITY_CONFIG,
  createApifyRedditFreshOpportunityAdapter,
  createApifyRedditOpportunityAdapter,
  createApifyRedditPostedAfterOpportunityAdapter,
  createApifyRedditThreadOpportunityAdapter,
  createApifyThreadsOpportunityAdapter,
  createApifyXOpportunityAdapter,
  normalizeRedditOpportunity,
  normalizeThreadsOpportunity,
  normalizeXOpportunity,
  publicSocialOpportunityApproved,
  publicSocialOpportunityEnabled,
  type PublicSocialOpportunityConfig,
} from '../adapters/apify/public-social-opportunity-source'
import { APIFY_REQUIRED_PRICE_VERSION, APIFY_REQUIRED_TERMS_VERSION } from '../adapters/apify/source'
import type { SourceSearchPlan } from '../adapters/types'
import { buildOpportunityQueryLanes } from '../research/opportunity-query-lanes'
import { buildSourcePlan } from '../research/plan'

const CLOCK = new Date('2026-08-26T23:00:00.000Z')
const now = () => CLOCK

function envFor(config: PublicSocialOpportunityConfig) {
  return {
    GTM_APIFY_ENABLED: 'true',
    GTM_APIFY_ACCOUNT_TIER: 'BRONZE',
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
    reddit_filter_keywords: ['buying a home', 'buy a home', 'selling a home'],
    reddit_filter_keyword_mode: 'any',
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
    url: 'https://www.reddit.com/r/SouthBayLA/comments/example/moving_to_the_south_bay/',
    permalink: '/r/SouthBayLA/comments/example/moving_to_the_south_bay/',
    body: 'Which neighborhoods should a first-time buyer compare?',
    isNsfw: false,
    isLocked: false,
    isArchived: false,
    subredditInfo: { type: 'PUBLIC', subscribersCount: 82_000 },
    ...overrides,
  }
}

function redditComment(overrides: Record<string, unknown> = {}) {
  return {
    type: 'comment',
    id: 't1_comment',
    postId: 't3_parent',
    postTitle: 'What should Austin homeowners know before selling?',
    postUrl: 'https://www.reddit.com/r/Austin/comments/parent/selling_question/',
    parentId: 't3_parent',
    author: 'austin_homeowner',
    subreddit: 'Austin',
    score: 7,
    postCommentCount: 11,
    subredditSubscribers: 790_000,
    createdAt: '2026-08-25T19:00:00.000Z',
    permalink: '/r/Austin/comments/parent/comment/comment/',
    body: 'We are thinking of selling our Austin home. Which repairs should we prioritize first?',
    ...overrides,
  }
}

function redditThreadPost(overrides: Record<string, unknown> = {}) {
  return {
    _type: 'post',
    _post_id: 't3_thread_post',
    _status: 'found',
    id: 'thread_post',
    title: 'Austin first-time buyer looking for a home',
    selftext: 'We are house hunting in Austin and comparing neighborhoods.',
    author: 'thread_starter',
    subreddit: 'Austin',
    score: 12,
    commentCount: 3,
    num_comments: 3,
    created_utc: Date.parse('2026-08-25T17:00:00.000Z') / 1_000,
    permalink: '/r/Austin/comments/thread_post/austin_first_time_buyer/',
    over_18: false,
    stickied: false,
    locked: false,
    archived: false,
    subreddit_subscribers: 790_000,
    ...overrides,
  }
}

function redditThreadComment(overrides: Record<string, unknown> = {}) {
  return {
    _type: 'comment',
    _post_id: 't3_thread_post',
    _status: 'found',
    id: 't1_thread_comment',
    author: 'comment_buyer',
    score: 4,
    createdAt: '2026-08-25T18:00:00.000Z',
    parentId: null,
    permalink: '/r/Austin/comments/thread_post/austin_first_time_buyer/thread_comment/',
    body: 'We are also looking to buy a home in Austin this month.',
    isStickied: false,
    isLocked: false,
    isDeleted: false,
    isArchived: false,
    isRemoved: false,
    isCommercialCommunication: false,
    ...overrides,
  }
}

function freshRedditPost(overrides: Record<string, unknown> = {}) {
  return {
    recordType: 'post',
    id: 'fresh_post',
    fullId: 't3_fresh_post',
    title: 'Phoenix first-time buyer looking for a home',
    text: 'We are house hunting in Phoenix and comparing neighborhoods this month.',
    author: 'fresh_buyer',
    subreddit: 'Phoenix',
    score: 18,
    numComments: 9,
    createdAt: '2026-08-25T17:00:00.000Z',
    scrapedAt: '2026-08-26T23:00:00.000Z',
    sourceQuery: 'buying home',
    url: 'https://www.reddit.com/r/Phoenix/comments/fresh_post/phoenix_first_time_buyer/',
    permalink: '/r/Phoenix/comments/fresh_post/phoenix_first_time_buyer/',
    isNsfw: false,
    isLocked: false,
    isStickied: false,
    ...overrides,
  }
}

function postedAfterRedditPost(overrides: Record<string, unknown> = {}) {
  return {
    dataType: 'post',
    id: 't3_posted_after',
    postUrl: 'https://www.reddit.com/r/Phoenix/comments/posted_after/phoenix_home_buyer/',
    title: 'Phoenix first-time buyer looking to buy a home',
    body: 'We are house hunting in Phoenix and comparing neighborhoods this month.',
    authorName: 'posted_after_buyer',
    communityName: 'r/Phoenix',
    parsedCommunityName: 'Phoenix',
    score: 18,
    commentsCount: 9,
    createdAt: '2026-08-25T17:00:00.000Z',
    crawledAt: '2026-08-26T23:00:00.000Z',
    searchTerm: 'looking to buy a home',
    over18: false,
    locked: false,
    archived: false,
    stickied: false,
    isRobotIndexable: true,
    removedByCategory: null,
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

function threadsPost(overrides: Record<string, unknown> = {}) {
  return {
    post_id: 'threads-post-123',
    code: 'ABC123',
    username: 'southbay_homeowner',
    full_name: 'Taylor Example',
    is_private: false,
    text: 'We are thinking of selling our South Bay home. Which repairs should we make first?',
    taken_at: Date.parse('2026-08-25T20:00:00.000Z') / 1_000,
    like_count: 14,
    reply_count: 5,
    repost_count: 2,
    quote_count: 1,
    reshare_count: 3,
    post_url: 'https://www.threads.com/@southbay_homeowner/post/ABC123',
    ...overrides,
  }
}

function outcome(
  config: PublicSocialOpportunityConfig,
  item: Record<string, unknown> | Array<Record<string, unknown>>,
  values: Partial<ApifyRunOutcome> = {},
): ApifyRunOutcome {
  const items = Array.isArray(item) ? item : [item]
  const partitionCounts = items.reduce(
    (counts, row) => {
      const rowType = String(row.type ?? row._type ?? '').toLowerCase()
      if (rowType === 'post') counts.posts += 1
      if (rowType === 'comment') counts.comments += 1
      return counts
    },
    { posts: 0, comments: 0 },
  )
  const counts =
    config.adapterId === APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG.adapterId
      ? {
          'apify-actor-start': 1,
          'apify-default-dataset-item': items.length,
          'post-scraped': partitionCounts.posts,
          'comment-scraped': partitionCounts.comments,
        }
      : config.adapterId === APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG.adapterId
        ? { init: 1, result: items.length }
      : config.adapterId === APIFY_REDDIT_FRESH_OPPORTUNITY_CONFIG.adapterId
        ? {
            'apify-actor-start': 1,
            'apify-default-dataset-item': items.length,
          }
      : config.platform === 'Reddit'
      ? {
          'apify-actor-start': 1,
          'apify-default-dataset-item': items.length,
          'result-scraped': items.length,
        }
      : config.platform === 'X'
        ? { init: 1, 'result-item': 1 }
        : { 'apify-actor-start': 1, 'apify-default-dataset-item': 1 }
  const providerCostUsd = Object.entries(counts).reduce(
    (sum, [event, count]) => sum + (config.eventPricesUsd[event] ?? 0) * count,
    0,
  )
  return {
    kind: 'ok',
    status: 'ok',
    items,
    actorId: config.actorId,
    runId: 'synthetic-run',
    itemCount: items.length,
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
  it('pins Reddit reservations to the production BRONZE account tier', () => {
    expect(APIFY_REDDIT_OPPORTUNITY_CONFIG).toMatchObject({
      actorId: 'clearpath/reddit-search-scraper',
      actorBuild: '0.0.76',
      requiredPriceVersion: 'clearpath-reddit-search-0.0.76-starter-events-2026-09-01',
      eventPricesUsd: {
        'apify-actor-start': 0.00099,
        'apify-default-dataset-item': 0.00001,
        'result-scraped': 0.00099,
      },
      oneTimeQuoteUsd: 0.00099,
      perItemQuoteUsd: 0.001,
    })
  })

  it('pins Reddit post-and-comment reservations to exact Starter event prices', () => {
    expect(APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG).toMatchObject({
      actorId: 'clearpath/reddit-post-comments-bulk-scraper',
      actorBuild: '0.0.60',
      requiredPriceVersion: 'clearpath-reddit-post-comments-0.0.60-starter-events-2026-08-30',
      eventPricesUsd: {
        'apify-actor-start': 0.0005,
        'apify-default-dataset-item': 0.00001,
        'post-scraped': 0.00299,
        'comment-scraped': 0.00099,
      },
      primaryResultEvent: 'apify-default-dataset-item',
      partitionedResultEvents: ['post-scraped', 'comment-scraped'],
      oneTimeQuoteUsd: 0.0005,
      perItemQuoteUsd: 0.003,
      minimumBatch: 2,
      maxBatch: 10,
    })
  })

  it('pins freshness-enforcing Reddit reservations to the exact BRONZE event contract', () => {
    expect(APIFY_REDDIT_FRESH_OPPORTUNITY_CONFIG).toMatchObject({
      actorId: 'solidcode/reddit-scraper',
      actorBuild: '1.1.36',
      requiredPriceVersion: 'solidcode-reddit-scraper-1.1.36-bronze-events-2026-08-30',
      eventPricesUsd: {
        'apify-actor-start': 0.01,
        'apify-default-dataset-item': 0.0022,
      },
      datasetResultBillingEvent: 'apify-default-dataset-item',
      oneTimeQuoteUsd: 0.01,
      perItemQuoteUsd: 0.0022,
      maxBatch: 10,
    })
  })

  it('pins posted-after Reddit reservations to the exact Starter BRONZE event contract', () => {
    expect(APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG).toMatchObject({
      actorId: 'harshmaur/reddit-scraper',
      actorBuild: '0.0.384',
      requiredPriceVersion: 'harshmaur-reddit-scraper-0.0.384-bronze-events-2026-08-31',
      eventPricesUsd: { init: 0.02, result: 0.0018 },
      datasetResultBillingEvent: 'result',
      oneTimeQuoteUsd: 0.04,
      allowedOneTimeEventCounts: [1, 2],
      memoryMbytes: 2_048,
      perItemQuoteUsd: 0.0018,
      maxBatch: 10,
    })
  })

  it('keeps posted-after Reddit sourcing held unless its capability switch is explicit', () => {
    const env = envFor(APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG)
    expect(publicSocialOpportunityEnabled(APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG, env)).toBe(false)
    expect(publicSocialOpportunityEnabled(APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG, {
      ...env,
      GTM_APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_ENABLED: 'true',
    })).toBe(true)
  })

  it('quotes a ten-row posted-after Reddit lane at its exact hard ceiling', () => {
    const adapter = createApifyRedditPostedAfterOpportunityAdapter({
      env: {
        ...envFor(APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_ENABLED: 'true',
      },
    })
    expect(adapter.quote({ ...plan, max_candidates: 10 })).toMatchObject({
      max_candidates: 10,
      provider_units: 58,
      estimated_credits_before_markup: 14_500,
    })
  })

  it('keeps freshness-enforcing Reddit sourcing held unless its capability switch is explicit', () => {
    const env = envFor(APIFY_REDDIT_FRESH_OPPORTUNITY_CONFIG)
    expect(publicSocialOpportunityEnabled(APIFY_REDDIT_FRESH_OPPORTUNITY_CONFIG, env)).toBe(false)
    expect(publicSocialOpportunityEnabled(APIFY_REDDIT_FRESH_OPPORTUNITY_CONFIG, {
      ...env,
      GTM_APIFY_REDDIT_FRESH_OPPORTUNITY_ENABLED: 'true',
    })).toBe(true)
  })

  it('quotes a ten-row freshness-enforcing Reddit lane at its exact hard ceiling', () => {
    const adapter = createApifyRedditFreshOpportunityAdapter({
      env: {
        ...envFor(APIFY_REDDIT_FRESH_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_FRESH_OPPORTUNITY_ENABLED: 'true',
      },
    })
    expect(adapter.quote({ ...plan, max_candidates: 10 })).toMatchObject({
      max_candidates: 10,
      provider_units: 32,
      estimated_credits_before_markup: 8_000,
    })
  })

  it('keeps Reddit post-and-comment sourcing held unless its capability switch is explicit', () => {
    const env = envFor(APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG)
    expect(publicSocialOpportunityEnabled(APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG, env)).toBe(false)
    expect(
      publicSocialOpportunityEnabled(APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG, {
        ...env,
        GTM_APIFY_REDDIT_THREAD_OPPORTUNITY_ENABLED: 'true',
      }),
    ).toBe(true)
  })

  it('does not quote a Reddit thread lane that cannot reserve one post and one comment', () => {
    const adapter = createApifyRedditThreadOpportunityAdapter({
      env: {
        ...envFor(APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_THREAD_OPPORTUNITY_ENABLED: 'true',
      },
    })
    expect(adapter.quote({ ...plan, max_candidates: 1 })).toMatchObject({
      max_candidates: 0,
      provider_units: 0,
      estimated_credits_before_markup: 0,
    })
  })

  it('quotes the smallest Reddit thread lane at the platform minimum charge', () => {
    const adapter = createApifyRedditThreadOpportunityAdapter({
      env: {
        ...envFor(APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_THREAD_OPPORTUNITY_ENABLED: 'true',
      },
    })
    expect(adapter.quote({ ...plan, max_candidates: 2 })).toMatchObject({
      max_candidates: 2,
      provider_units: 10,
      estimated_credits_before_markup: 2_500,
    })
  })

  it('refuses a direct Reddit thread search below its provider batch minimum', async () => {
    const runActor = jest.fn()
    const adapter = createApifyRedditThreadOpportunityAdapter({
      env: {
        ...envFor(APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_THREAD_OPPORTUNITY_ENABLED: 'true',
      },
      now,
      runActor,
    })
    await expect(adapter.search({
      ...plan,
      max_candidates: 1,
      max_charge_usd: 0.01,
    })).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('provider batch minimum'),
    })
    expect(runActor).not.toHaveBeenCalled()
  })

  it('pins X reservations to the production BRONZE account tier', () => {
    expect(APIFY_X_OPPORTUNITY_CONFIG).toMatchObject({
      actorBuild: '0.0.154',
      requiredPriceVersion: 'scraper-one-x-post-search-0.0.154-bronze-events-2026-08-29',
      eventPricesUsd: { init: 0.0025, 'result-item': 0.00025 },
      oneTimeQuoteUsd: 0.0025,
      perItemQuoteUsd: 0.00025,
    })
  })

  it('pins Threads reservations to the exact established-actor BRONZE account contract', () => {
    expect(APIFY_THREADS_OPPORTUNITY_CONFIG).toMatchObject({
      actorId: 'pro100chok/threads-scraper-usage',
      actorBuild: '0.5.1',
      requiredPriceVersion: 'pro100chok-threads-scraper-usage-0.5.1-bronze-events-2026-08-29',
      eventPricesUsd: { 'apify-actor-start': 0.0001, 'apify-default-dataset-item': 0.002 },
      oneTimeEvent: 'apify-actor-start',
      oneTimeQuoteUsd: 0.0001,
      perItemQuoteUsd: 0.002,
    })
    expect(APIFY_THREADS_OPPORTUNITY_CONFIG.datasetFields).toEqual([
      'post_id',
      'code',
      'username',
      'full_name',
      'is_private',
      'text',
      'taken_at',
      'like_count',
      'reply_count',
      'repost_count',
      'quote_count',
      'reshare_count',
      'post_url',
      'is_reply',
    ])
    expect(APIFY_THREADS_OPPORTUNITY_CONFIG.datasetFields).not.toContain('emails_in_text')
    expect(APIFY_THREADS_OPPORTUNITY_CONFIG.datasetFields).not.toContain('profile_contacts')
  })

  it('keeps the X source held unless its capability switch is explicit', () => {
    const env = envFor(APIFY_X_OPPORTUNITY_CONFIG)
    expect(publicSocialOpportunityEnabled(APIFY_X_OPPORTUNITY_CONFIG, env)).toBe(false)
    expect(
      publicSocialOpportunityEnabled(APIFY_X_OPPORTUNITY_CONFIG, {
        ...env,
        GTM_APIFY_X_OPPORTUNITY_ENABLED: 'true',
      }),
    ).toBe(true)
    // Review 2026-09-02 (L0): the Reddit search lane used to register on the
    // global Apify gate alone; it now has its own capability switch too.
    expect(
      publicSocialOpportunityEnabled(
        APIFY_REDDIT_OPPORTUNITY_CONFIG,
        envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      ),
    ).toBe(false)
    expect(APIFY_REDDIT_OPPORTUNITY_CONFIG.enabledEnv).toBe('GTM_APIFY_REDDIT_OPPORTUNITY_ENABLED')
    expect(
      publicSocialOpportunityEnabled(APIFY_REDDIT_OPPORTUNITY_CONFIG, {
        ...envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_OPPORTUNITY_ENABLED: 'true',
      }),
    ).toBe(true)
  })

  it('keeps Threads held unless its capability switch is explicit', () => {
    const env = envFor(APIFY_THREADS_OPPORTUNITY_CONFIG)
    expect(publicSocialOpportunityEnabled(APIFY_THREADS_OPPORTUNITY_CONFIG, env)).toBe(false)
    expect(
      publicSocialOpportunityEnabled(APIFY_THREADS_OPPORTUNITY_CONFIG, {
        ...env,
        GTM_APIFY_THREADS_OPPORTUNITY_ENABLED: 'true',
      }),
    ).toBe(true)
  })

  it.each([
    [APIFY_REDDIT_OPPORTUNITY_CONFIG],
    [APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG],
    [APIFY_REDDIT_FRESH_OPPORTUNITY_CONFIG],
    [APIFY_X_OPPORTUNITY_CONFIG],
    [APIFY_THREADS_OPPORTUNITY_CONFIG],
  ])(
    'requires the exact account tier, actor, use approval, and price version for $platform',
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
          GTM_APIFY_ACCOUNT_TIER: 'FREE',
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

  it('normalizes a public Reddit buyer thread with the pinned actor source timestamp', () => {
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
        participation_rules_status: 'unverified',
        source_published_at: '2026-08-25T17:00:00.000Z',
        people_to_follow: [{ name: 'local_question' }],
      },
      evidence: [
        {
          source_url: 'https://www.reddit.com/r/SouthBayLA/comments/example/moving_to_the_south_bay/',
          observed_at: CLOCK.toISOString(),
          detail: expect.objectContaining({
            source_published_at: '2026-08-25T17:00:00.000Z',
            publication_time_evidence: 'pinned_actor_source_timestamp',
          }),
        },
      ],
    })
  })

  // Review 2026-09-02 (H8): access_type used to be hard-coded 'public' for
  // every social row. Only the provider's own visibility field promotes it.
  it('asserts a public Reddit destination only on a positive visibility signal', () => {
    const context = {
      query: 'moving to the south bay',
      location: 'South Bay, California',
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
    }
    expect(normalizeRedditOpportunity(redditPost(), context)?.identity.access_type).toBe('public')
    expect(
      normalizeRedditOpportunity(redditPost({ subredditInfo: { subscribersCount: 10 } }), context)?.identity.access_type,
    ).toBe('unknown')
    expect(
      normalizeRedditOpportunity(redditPost({ subredditInfo: { isPrivate: false } }), context)?.identity.access_type,
    ).toBe('public')
    expect(normalizeRedditOpportunity(redditPost({ subredditInfo: { type: 'RESTRICTED' } }), context)).toBeNull()
    expect(normalizeRedditOpportunity(redditPost({ subredditInfo: { type: 'PRIVATE' } }), context)).toBeNull()
    expect(normalizeRedditOpportunity(redditPost({ subredditInfo: { isPrivate: true } }), context)).toBeNull()
  })

  // Review 2026-09-02 (L0): old./np./new. Reddit hosts were rejected here
  // while the thread canonicalizer accepted them, so paid rows were dropped;
  // a bare year parsed as epoch seconds and landed in 1970.
  it('canonicalizes Reddit host aliases and refuses a bare year as a publication time', () => {
    const context = {
      query: 'moving to the south bay',
      location: 'South Bay, California',
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
    }
    for (const host of ['old.reddit.com', 'np.reddit.com', 'new.reddit.com', 'reddit.com']) {
      const candidate = normalizeRedditOpportunity(redditPost({
        url: `https://${host}/r/SouthBayLA/comments/example/moving_to_the_south_bay/`,
        permalink: null,
      }), context)
      expect(candidate?.identity.urls).toEqual([
        'https://www.reddit.com/r/SouthBayLA/comments/example/moving_to_the_south_bay/',
      ])
    }
    expect(normalizeRedditOpportunity(redditPost({
      url: 'https://reddit.example.com/r/SouthBayLA/comments/example/x/',
      permalink: null,
    }), context)).toBeNull()
    const bareYear = normalizeRedditOpportunity(redditPost({ createdAt: '2026' }), context)
    expect(bareYear?.identity.source_published_at).toBeNull()
    expect(bareYear?.evidence[0].detail).toEqual(expect.objectContaining({ published_at_unknown: true }))
    const epochSeconds = normalizeRedditOpportunity(
      redditPost({ createdAt: Date.parse('2026-08-25T17:00:00.000Z') / 1_000 }),
      context,
    )
    expect(epochSeconds?.identity.source_published_at).toBe('2026-08-25T17:00:00.000Z')
    expect(epochSeconds?.evidence[0].detail).toEqual(expect.objectContaining({ published_at: '2026-08-25T17:00:00.000Z' }))
  })

  it('strips control and zero-width characters from provider text', () => {
    const context = {
      query: 'moving to the south bay',
      location: 'South Bay, California',
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
    }
    const candidate = normalizeRedditOpportunity(redditPost({
      body: 'Which neighborhoods\u200b\u202e should a first-time\u0007 buyer compare?',
    }), context)
    expect(candidate?.identity.audience_description).toContain('Which neighborhoods should a first-time buyer compare?')
  })

  it('normalizes a public Reddit comment as returned-content intent with parent-thread context', () => {
    const candidate = normalizeRedditOpportunity(redditComment(), {
      query: 'targeting text must not become evidence',
      location: 'Austin, Texas',
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
    })

    expect(candidate).toMatchObject({
      entity_kind: 'opportunity',
      identity: {
        name: 'Reddit comment in r/Austin',
        opportunity_kind: 'thread',
        platform: 'Reddit',
        intent_kind: 'seller_intent',
        engagement_count: 18,
        member_count: 790_000,
        location: 'Austin, Texas',
        participation_rules_status: 'unverified',
        source_published_at: '2026-08-25T19:00:00.000Z',
        people_to_follow: [{ name: 'austin_homeowner' }],
      },
      evidence: [
        expect.objectContaining({
          source_url: 'https://www.reddit.com/r/Austin/comments/parent/comment/comment/',
          detail: expect.objectContaining({
            provider_post_id: 't3_parent',
            provider_comment_id: 't1_comment',
            parent_id: 't3_parent',
            parent_post_title: 'What should Austin homeowners know before selling?',
            source_content_type: 'comment',
            source_published_at: '2026-08-25T19:00:00.000Z',
            publication_time_evidence: 'pinned_actor_source_timestamp',
          }),
        }),
      ],
    })
  })

  it('does not let a seller-oriented parent post manufacture intent for an unrelated comment', () => {
    const candidate = normalizeRedditOpportunity(
      redditComment({ body: 'Thanks for sharing this general information.' }),
      {
        query: 'Austin seller intent',
        location: 'Austin, Texas',
        attemptedAt: CLOCK.toISOString(),
        actorId: APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
      },
    )
    expect(candidate?.identity.intent_kind).toBeNull()
    expect(candidate?.identity.audience_description).toBe('Thanks for sharing this general information.')
  })

  it('normalizes the exact post-and-comment actor schema without inventing parent context', () => {
    const context = {
      query: 'targeting text must not become evidence',
      location: 'Austin, Texas',
      scopedSubreddits: ['Austin'],
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG.actorId,
      semanticFilterVersion: 'semantic-intent-location-v3',
    }
    const post = normalizeRedditOpportunity(redditThreadPost(), context)
    const comment = normalizeRedditOpportunity(redditThreadComment(), context)

    expect(post).toMatchObject({
      identity: {
        intent_kind: 'buyer_intent',
        location: 'Austin, Texas',
        member_count: 790_000,
        source_published_at: '2026-08-25T17:00:00.000Z',
      },
      evidence: [{ detail: { provider_post_id: 't3_thread_post' } }],
    })
    expect(comment).toMatchObject({
      identity: {
        name: 'Reddit comment in r/Austin',
        intent_kind: 'buyer_intent',
        location: 'Austin, Texas',
        audience_description: 'We are also looking to buy a home in Austin this month.',
        source_published_at: '2026-08-25T18:00:00.000Z',
      },
      evidence: [{
        detail: {
          provider_post_id: 't3_thread_post',
          provider_comment_id: 't1_thread_comment',
          parent_post_title: null,
          subreddit: 'Austin',
          location_basis: 'scoped_returned_subreddit',
        },
      }],
    })
    expect(normalizeRedditOpportunity(redditThreadComment({ isRemoved: true }), context)).toBeNull()
    expect(normalizeRedditOpportunity(
      redditThreadComment({ isCommercialCommunication: true }),
      context,
    )).toBeNull()
  })

  it('drops locked, archived, NSFW, stickied, quarantined, and sensitive Reddit posts', () => {
    const context = {
      query: plan.query,
      location: 'South Bay, California',
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
    }
    for (const row of [
      redditPost({ isLocked: true }),
      redditPost({ isArchived: true }),
      redditPost({ isNSFW: true }),
      redditPost({ isStickied: true }),
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

  it('normalizes an exact-dated public Threads post with author context and visible engagement', () => {
    const candidate = normalizeThreadsOpportunity(threadsPost(), {
      query: plan.query,
      location: 'South Bay, California',
      expectedIntent: 'seller_intent',
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_THREADS_OPPORTUNITY_CONFIG.actorId,
    })
    expect(candidate).toMatchObject({
      entity_kind: 'opportunity',
      identity: {
        opportunity_kind: 'post',
        platform: 'Threads',
        intent_kind: 'seller_intent',
        engagement_count: 25,
        source_published_at: '2026-08-25T20:00:00.000Z',
        people_to_follow: [
          {
            name: 'Taylor Example',
            role: 'Public Threads contributor shown as secondary source context',
            profile_url: 'https://www.threads.com/@southbay_homeowner',
          },
        ],
      },
      evidence: [
        {
          source_url: 'https://www.threads.com/@southbay_homeowner/post/ABC123',
          observed_at: CLOCK.toISOString(),
          detail: expect.objectContaining({
            provider_post_id: 'threads-post-123',
            source_published_at: '2026-08-25T20:00:00.000Z',
            visible_engagement: 25,
          }),
        },
      ],
    })
  })

  it('keeps Threads intent independent from the targeting query', () => {
    const candidate = normalizeThreadsOpportunity(
      threadsPost({ text: 'South Bay neighborhood community breakfast for local residents.' }),
      {
        query: 'South Bay selling my home thinking of selling',
        location: 'South Bay, California',
        expectedIntent: 'seller_intent',
        attemptedAt: CLOCK.toISOString(),
        actorId: APIFY_THREADS_OPPORTUNITY_CONFIG.actorId,
      },
    )
    expect(candidate?.identity.intent_kind).toBe('local_audience')
  })

  it('keeps the previously documented Threads post shape readable during the actor transition', () => {
    const candidate = normalizeThreadsOpportunity(
      {
        type: 'post',
        postId: 'legacy-threads-post-123',
        username: 'legacy_homeowner',
        fullName: 'Legacy Example',
        isPrivate: false,
        text: 'We are thinking of selling our South Bay home and want advice from local owners.',
        date: '2026-08-25T20:00:00.000Z',
        likeCount: 4,
        replyCount: 2,
        repostCount: 1,
        quoteCount: 0,
        url: 'https://www.threads.com/@legacy_homeowner/post/LEGACY123',
      },
      {
        query: plan.query,
        location: 'South Bay, California',
        expectedIntent: 'seller_intent',
        attemptedAt: CLOCK.toISOString(),
        actorId: APIFY_THREADS_OPPORTUNITY_CONFIG.actorId,
      },
    )
    expect(candidate).toMatchObject({
      identity: {
        platform: 'Threads',
        intent_kind: 'seller_intent',
        engagement_count: 7,
      },
      evidence: [
        {
          source_url: 'https://www.threads.com/@legacy_homeowner/post/LEGACY123',
          detail: { provider_post_id: 'legacy-threads-post-123' },
        },
      ],
    })
  })

  it('drops non-post, off-platform, and sensitive Threads rows', () => {
    const context = {
      query: plan.query,
      location: 'South Bay, California',
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_THREADS_OPPORTUNITY_CONFIG.actorId,
    }
    expect(normalizeThreadsOpportunity(threadsPost({ type: 'profile' }), context)).toBeNull()
    expect(normalizeThreadsOpportunity(threadsPost({ post_id: null }), context)).toBeNull()
    expect(normalizeThreadsOpportunity(threadsPost({ is_private: true }), context)).toBeNull()
    expect(
      normalizeThreadsOpportunity(threadsPost({ post_url: 'https://example.com/post/ABC123' }), context),
    ).toBeNull()
    expect(
      normalizeThreadsOpportunity(threadsPost({ text: 'Foreclosure distress outreach list' }), context),
    ).toBeNull()
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
      redditPost({ title: 'South Bay neighborhood community breakfast', selfText: 'Local residents are welcome.' }),
      context,
    )
    const x = normalizeXOpportunity(
      xPost({ postText: 'South Bay neighborhood community breakfast for local residents.' }),
      { ...context, actorId: APIFY_X_OPPORTUNITY_CONFIG.actorId },
    )
    expect(reddit?.identity.intent_kind).toBe('local_audience')
    expect(x?.identity.intent_kind).toBe('local_audience')
  })

  it('retains safe paid social rows for fit-v7 when returned content does not prove the lane or market', () => {
    const context = {
      query: 'Austin Texas selling my house thinking of selling',
      location: 'Austin, Texas',
      expectedIntent: 'seller_intent' as const,
      scopedSubreddits: ['Austin', 'AskAustin', 'Texas'],
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
    }
    const mismatch = normalizeRedditOpportunity(
      redditPost({
        title: 'SOL scaling by state: a community guide',
        selfText: 'A general legal discussion about claim deadlines.',
        subreddit: 'BSA_Survivors',
      }),
      context,
    )
    expect(mismatch).toMatchObject({
      identity: { location: null },
      evidence: [expect.objectContaining({ detail: expect.objectContaining({ requested_intent: 'seller_intent' }) })],
    })
    expect(
      normalizeRedditOpportunity(
        redditPost({
          title: 'Thinking of selling our Austin home',
          selfText: 'We are preparing to sell our house and need advice about what to repair first.',
          subreddit: 'Austin',
        }),
        context,
      ),
    ).not.toBeNull()
  })

  it('preserves safe undated and rental-lifestyle rows for fit-v7 rejection', () => {
    const context = {
      query: 'Tampa Florida homeowner question housing discussion',
      location: 'Tampa, Florida',
      expectedIntent: 'local_audience' as const,
      scopedSubreddits: ['Tampa', 'AskTampa', 'Florida'],
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
    }
    expect(
      normalizeRedditOpportunity(
        redditPost({
          title: 'Tampa first-time home buyer question',
          selfText: 'Which Tampa neighborhoods should I compare before buying a house?',
          subreddit: 'Tampa',
          createdAt: null,
        }),
        context,
      ),
    ).toMatchObject({ identity: { source_published_at: null } })
    expect(
      normalizeRedditOpportunity(
        redditPost({
          title: 'Tampa Florida dream',
          selfText: 'I want to move to Tampa, rent a cute apartment, and bike by the ocean.',
          subreddit: 'Adulting',
        }),
        context,
      ),
    ).toMatchObject({
      identity: { location: 'Tampa, Florida' },
      evidence: [expect.objectContaining({ detail: expect.objectContaining({ requested_intent: 'local_audience' }) })],
    })
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
          selfText: 'I am in opioid recovery, currently in sober living, and dealing with a predatory landlord.',
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
        selfText: 'A card seller is packing a collection.',
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
        selfText: 'We are considering selling and would value local advice.',
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
        query: 'South Bay buying or selling a home',
        subreddits: ['Austin', 'AskAustin', 'AustinHousing'],
        autoDiscoverSubreddits: false,
        sort: 'new',
        contentType: 'posts',
      }),
      expect.any(Object),
    )
  })

  it('refuses ungoverned subreddit auto-discovery before a paid call', async () => {
    const runActor = jest.fn(async () => outcome(APIFY_REDDIT_OPPORTUNITY_CONFIG, redditPost()))
    const adapter = createApifyRedditOpportunityAdapter({
      env: envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      now,
      runActor,
    })
    const result = await adapter.search({
      ...plan,
      provider_query: {
        ...plan.provider_query,
        reddit_subreddits: [],
        reddit_auto_discover: true,
        reddit_max_subreddits: 12,
        reddit_sort: 'relevance',
      },
    })

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('global Reddit search'),
    })
    expect(runActor).not.toHaveBeenCalled()
  })

  it('uses bounded auto-discovery for a market-bound global search', async () => {
    const runActor = jest.fn(async () => outcome(APIFY_REDDIT_OPPORTUNITY_CONFIG, redditPost({
      title: 'Austin homeowner thinking of selling my house',
      body: 'I am thinking of selling my house in Austin. Which repairs should I prioritize?',
    })))
    const adapter = createApifyRedditOpportunityAdapter({
      env: envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      now,
      runActor,
    })
    const result = await adapter.search({
      ...plan,
      geography: 'US',
      max_candidates: 5,
      provider_query: {
        ...plan.provider_query,
        locations: ['Austin, Texas'],
        search_query: '"Austin" AND ("thinking of selling" OR "sell my house")',
        reddit_returned_content_filter_version: 'semantic-intent-location-v1',
        reddit_filter_required_intent: 'seller_intent',
        reddit_filter_require_location: true,
        reddit_subreddits: [],
        reddit_auto_discover: true,
        reddit_max_subreddits: 6,
        reddit_global_search: true,
        reddit_sort: 'relevance',
      },
    })

    expect(result.status).toBe('ok')
    expect(runActor).toHaveBeenCalledWith(
      APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
      expect.objectContaining({
        query: '"Austin" AND ("thinking of selling" OR "sell my house")',
        autoDiscoverSubreddits: true,
        maxSubreddits: 6,
        sort: 'relevance',
        timeFilter: 'week',
        maxResults: 5,
        contentType: 'posts',
      }),
      expect.any(Object),
    )
  })

  it('supports a separately quoted comment search lane', async () => {
    const runActor = jest.fn(async () => outcome(APIFY_REDDIT_OPPORTUNITY_CONFIG, redditComment()))
    const adapter = createApifyRedditOpportunityAdapter({
      env: envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      now,
      runActor,
    })
    const result = await adapter.search({
      ...plan,
      geography: 'US',
      max_candidates: 5,
      provider_query: {
        ...plan.provider_query,
        locations: ['Austin, Texas'],
        search_query: '"Austin" AND ("selling my home" OR "thinking of selling")',
        reddit_returned_content_filter_version: 'semantic-intent-location-v1',
        reddit_filter_required_intent: 'seller_intent',
        reddit_filter_require_location: true,
        reddit_subreddits: [],
        reddit_auto_discover: true,
        reddit_max_subreddits: 6,
        reddit_global_search: true,
        reddit_sort: 'relevance',
        reddit_content_type: 'comments',
      },
    })

    expect(result.status).toBe('ok')
    expect(runActor).toHaveBeenCalledWith(
      APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
      expect.objectContaining({
        contentType: 'comments',
        autoDiscoverSubreddits: true,
        maxSubreddits: 6,
      }),
      expect.any(Object),
    )
  })

  it('builds one bounded public-thread query and reconciles post and comment events exactly', async () => {
    const post = redditThreadPost()
    const comment = redditThreadComment()
    const runActor = jest.fn(async () =>
      outcome(APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG, [post, comment]),
    )
    const adapter = createApifyRedditThreadOpportunityAdapter({
      env: {
        ...envFor(APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_THREAD_OPPORTUNITY_ENABLED: 'true',
      },
      now,
      runActor,
    })
    const result = await adapter.search({
      ...plan,
      max_candidates: 10,
      max_charge_usd: 0.0305,
      provider_query: {
        ...plan.provider_query,
        locations: ['Austin, Texas'],
        search_query: 'house hunting',
        opportunity_intent_lane: 'buyer_intent',
        reddit_thread_contract_version: 'public-post-comments-v2',
        reddit_returned_content_filter_version: 'semantic-intent-location-v3',
        reddit_filter_required_intent: 'buyer_intent',
        reddit_filter_require_location: false,
        reddit_subreddits: ['Austin'],
        reddit_auto_discover: false,
        reddit_global_search: false,
      },
    })

    expect(result).toMatchObject({
      status: 'ok',
      cost_units: 4.5,
      receipt: {
        charged_event_counts: {
          'apify-actor-start': 1,
          'apify-default-dataset-item': 2,
          'post-scraped': 1,
          'comment-scraped': 1,
        },
        billed_results: 2,
        returned_count: 2,
      },
    })
    expect(runActor).toHaveBeenCalledWith(
      APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG.actorId,
      {
        queries: ['house hunting subreddit:Austin'],
        maxPostsPerQuery: 5,
        sort: 'new',
        maxCommentsPerPost: 1,
        expandAllComments: false,
      },
      expect.objectContaining({
        build: '0.0.60',
        maxItems: 10,
        maxChargeUsd: 0.0305,
      }),
    )
  })

  it('parks a Reddit thread run when a post/comment event count does not match returned rows', async () => {
    const billed = outcome(
      APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG,
      [
        redditThreadPost(),
        redditThreadComment(),
      ],
      {
        chargedEventCounts: {
          'apify-actor-start': 1,
          'apify-default-dataset-item': 2,
          'post-scraped': 1,
          'comment-scraped': 0,
        },
        providerCostUsd: 0.00351,
      },
    )
    const adapter = createApifyRedditThreadOpportunityAdapter({
      env: {
        ...envFor(APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_THREAD_OPPORTUNITY_ENABLED: 'true',
      },
      now,
      runActor: async () => billed,
    })
    const result = await adapter.search({
      ...plan,
      max_candidates: 10,
      max_charge_usd: 0.0305,
      provider_query: {
        ...plan.provider_query,
        locations: ['Austin, Texas'],
        search_query: 'selling house',
        opportunity_intent_lane: 'seller_intent',
        reddit_thread_contract_version: 'public-post-comments-v2',
        reddit_returned_content_filter_version: 'semantic-intent-location-v3',
        reddit_filter_required_intent: 'seller_intent',
        reddit_filter_require_location: false,
        reddit_subreddits: ['Austin'],
        reddit_auto_discover: false,
        reddit_global_search: false,
      },
    })

    expect(result).toMatchObject({
      status: 'ambiguous',
      data: null,
      cost_units: null,
      receipt: {
        partitioned_result_event: 'comment-scraped',
        billed_partitioned_results: 0,
        expected_partitioned_results: 1,
      },
      error: expect.stringContaining('partitioned billed result count'),
    })
  })

  it('refuses Reddit thread fan-out, deep expansion, and unfrozen scope before provider contact', async () => {
    const runActor = jest.fn(async () => outcome(
      APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG,
      redditThreadPost(),
    ))
    const adapter = createApifyRedditThreadOpportunityAdapter({
      env: {
        ...envFor(APIFY_REDDIT_THREAD_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_THREAD_OPPORTUNITY_ENABLED: 'true',
      },
      now,
      runActor,
    })
    const result = await adapter.search({
      ...plan,
      max_candidates: 10,
      max_charge_usd: 0.0305,
      provider_query: {
        ...plan.provider_query,
        locations: ['Austin, Texas'],
        search_query: 'house hunting subreddit:Phoenix',
        opportunity_intent_lane: 'buyer_intent',
        reddit_thread_contract_version: 'public-post-comments-v2',
        reddit_returned_content_filter_version: 'semantic-intent-location-v3',
        reddit_filter_required_intent: 'buyer_intent',
        reddit_filter_require_location: false,
        reddit_subreddits: ['Austin', 'AskAustin'],
        reddit_auto_discover: false,
        reddit_global_search: false,
      },
    })

    expect(result).toMatchObject({
      status: 'error',
      cost_units: 0,
      error: expect.stringContaining('exactly one frozen public subreddit'),
    })
    expect(runActor).not.toHaveBeenCalled()
  })

  it('drops paid Reddit rows that do not match the frozen returned-content filter', async () => {
    const adapter = createApifyRedditOpportunityAdapter({
      env: envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      now,
      runActor: async () => outcome(APIFY_REDDIT_OPPORTUNITY_CONFIG, redditPost({
        title: 'Moving from Austin to Bend for a new job',
        body: 'Which neighborhood should I rent in while I get settled?',
      })),
    })

    const result = await adapter.search({
      ...plan,
      provider_query: {
        ...plan.provider_query,
        reddit_filter_keywords: ['Austin', 'selling my home', 'selling my house'],
        reddit_filter_keyword_mode: 'first_and_any',
      },
    })

    expect(result).toMatchObject({
      status: 'no_result',
      data: null,
      receipt: {
        parser_dropped_rows: 0,
        keyword_filtered_rows: 1,
      },
      error: 'no_result_after_returned_content_filter',
    })
  })

  it('uses semantic returned-content intent and location instead of exact query phrasing', async () => {
    const adapter = createApifyRedditOpportunityAdapter({
      env: envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      now,
      runActor: async () => outcome(APIFY_REDDIT_OPPORTUNITY_CONFIG, redditPost({
        title: 'Phoenix real estate discussion for newer buyers',
        body: 'I am waiting to find a property in Phoenix and asking how buyers should compare current listings.',
        subreddit: 'RealEstate',
        permalink: '/r/RealEstate/comments/example/phoenix_buyers/',
        url: 'https://www.reddit.com/r/RealEstate/comments/example/phoenix_buyers/',
      })),
    })

    const result = await adapter.search({
      ...plan,
      provider_query: {
        ...plan.provider_query,
        locations: ['Phoenix, Arizona'],
        search_query: '"Phoenix" AND ("looking to buy" OR "house hunting")',
        opportunity_intent_lane: 'buyer_intent',
        reddit_returned_content_filter_version: 'semantic-intent-location-v1',
        reddit_filter_required_intent: 'buyer_intent',
        reddit_filter_require_location: true,
      },
    })

    expect(result).toMatchObject({
      status: 'ok',
      receipt: {
        returned_content_filter_version: 'semantic-intent-location-v1',
        returned_content_filtered_rows: 0,
      },
    })
    expect(result.data?.[0]?.identity).toMatchObject({
      intent_kind: 'buyer_intent',
      location: 'Phoenix, Arizona',
    })
  })

  it('uses v2 returned-content semantics for a local residential decision without admitting product purchases', async () => {
    const phoenixBuyer = redditPost({
      title: 'What is the scoop on Moon Valley?',
      body: 'We are looking to buy but not get too far out. What is the vibe? Is it family friendly and safe?',
      subreddit: 'phoenix',
      permalink: '/r/phoenix/comments/example/moon_valley/',
      url: 'https://www.reddit.com/r/phoenix/comments/example/moon_valley/',
    })
    const buyerAdapter = createApifyRedditOpportunityAdapter({
      env: envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      now,
      runActor: async () => outcome(APIFY_REDDIT_OPPORTUNITY_CONFIG, phoenixBuyer),
    })
    const buyerResult = await buyerAdapter.search({
      ...plan,
      provider_query: {
        ...plan.provider_query,
        locations: ['Phoenix, Arizona'],
        search_query: '("looking to buy" OR "house hunting")',
        opportunity_intent_lane: 'buyer_intent',
        reddit_returned_content_filter_version: 'semantic-intent-location-v2',
        reddit_filter_required_intent: 'buyer_intent',
        reddit_filter_require_location: false,
        reddit_subreddits: ['Phoenix'],
        reddit_auto_discover: false,
      },
    })

    expect(buyerResult).toMatchObject({
      status: 'ok',
      receipt: {
        returned_content_filter_version: 'semantic-intent-location-v2',
        returned_content_filtered_rows: 0,
      },
    })
    expect(buyerResult.data?.[0]?.identity).toMatchObject({
      intent_kind: 'buyer_intent',
      location: 'Phoenix, Arizona',
    })

    const productAdapter = createApifyRedditOpportunityAdapter({
      env: envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      now,
      runActor: async () => outcome(APIFY_REDDIT_OPPORTUNITY_CONFIG, redditPost({
        title: 'Where to buy sourdough bread?',
        body: 'I was looking to buy some fresh sourdough bread. Does anyone recommend a bakery?',
        subreddit: 'phoenix',
      })),
    })
    const productResult = await productAdapter.search({
      ...plan,
      provider_query: {
        ...plan.provider_query,
        locations: ['Phoenix, Arizona'],
        search_query: '("looking to buy" OR "house hunting")',
        opportunity_intent_lane: 'buyer_intent',
        reddit_returned_content_filter_version: 'semantic-intent-location-v2',
        reddit_filter_required_intent: 'buyer_intent',
        reddit_filter_require_location: false,
        reddit_subreddits: ['Phoenix'],
        reddit_auto_discover: false,
      },
    })
    expect(productResult).toMatchObject({
      status: 'no_result',
      receipt: {
        returned_content_filter_version: 'semantic-intent-location-v2',
        returned_content_filtered_rows: 1,
      },
    })
  })

  it('uses v3 returned-content semantics to exclude entertainment house hunting while preserving v2 plans', async () => {
    const entertainmentPost = redditPost({
      title: 'Television in the waiting room',
      body: 'We watched a house hunting and remodeling show on TV while our nail appointments finished.',
      subreddit: 'phoenix',
      permalink: '/r/phoenix/comments/example/waiting_room_tv/',
      url: 'https://www.reddit.com/r/phoenix/comments/example/waiting_room_tv/',
    })
    const adapter = createApifyRedditOpportunityAdapter({
      env: envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      now,
      runActor: async () => outcome(APIFY_REDDIT_OPPORTUNITY_CONFIG, entertainmentPost),
    })
    const versionedPlan = {
      ...plan,
      provider_query: {
        ...plan.provider_query,
        locations: ['Phoenix, Arizona'],
        search_query: '("house hunting" OR "looking to buy a home")',
        opportunity_intent_lane: 'buyer_intent',
        reddit_filter_required_intent: 'buyer_intent',
        reddit_filter_require_location: false,
        reddit_subreddits: ['Phoenix'],
        reddit_auto_discover: false,
      },
    }

    const legacy = await adapter.search({
      ...versionedPlan,
      provider_query: {
        ...versionedPlan.provider_query,
        reddit_returned_content_filter_version: 'semantic-intent-location-v2',
      },
    })
    expect(legacy).toMatchObject({
      status: 'ok',
      data: [{ identity: { intent_kind: 'buyer_intent' } }],
      receipt: { returned_content_filter_version: 'semantic-intent-location-v2' },
    })

    const current = await adapter.search({
      ...versionedPlan,
      provider_query: {
        ...versionedPlan.provider_query,
        reddit_returned_content_filter_version: 'semantic-intent-location-v3',
      },
    })
    expect(current).toMatchObject({
      status: 'no_result',
      data: null,
      receipt: {
        returned_content_filter_version: 'semantic-intent-location-v3',
        returned_content_filtered_rows: 1,
      },
    })
  })

  it('refuses an unknown semantic filter version before a paid Reddit call', async () => {
    const runActor = jest.fn(async () => outcome(APIFY_REDDIT_OPPORTUNITY_CONFIG, redditPost()))
    const adapter = createApifyRedditOpportunityAdapter({
      env: envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      now,
      runActor,
    })

    const result = await adapter.search({
      ...plan,
      provider_query: {
        ...plan.provider_query,
        reddit_returned_content_filter_version: 'semantic-intent-location-v999',
        reddit_filter_required_intent: 'buyer_intent',
        reddit_filter_require_location: false,
      },
    })

    expect(result).toMatchObject({
      status: 'error',
      cost_units: 0,
      error: expect.stringContaining('unsupported Reddit returned-content filter version'),
    })
    expect(runActor).not.toHaveBeenCalled()
  })

  it('drops a recent Reddit seller mention that only describes a past transaction', async () => {
    const adapter = createApifyRedditOpportunityAdapter({
      env: envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      now,
      runActor: async () => outcome(APIFY_REDDIT_OPPORTUNITY_CONFIG, redditPost({
        title: 'Scratch and dent appliance recommendation',
        body: 'I was selling a home and needed appliances for the place. What we got was in good shape.',
      })),
    })

    const result = await adapter.search({
      ...plan,
      provider_query: {
        ...plan.provider_query,
        locations: ['Phoenix, Arizona'],
        search_query: 'selling house advice',
        opportunity_intent_lane: 'seller_intent',
        reddit_returned_content_filter_version: 'semantic-intent-location-v4',
        reddit_filter_required_intent: 'seller_intent',
        reddit_filter_require_location: false,
        reddit_subreddits: ['Phoenix'],
        reddit_auto_discover: false,
      },
    })

    expect(result).toMatchObject({
      status: 'no_result',
      data: null,
      receipt: {
        returned_content_filter_version: 'semantic-intent-location-v4',
        returned_content_filtered_rows: 1,
      },
    })
  })

  it('fails the semantic returned-content filter when the market is not demonstrated', async () => {
    const adapter = createApifyRedditOpportunityAdapter({
      env: envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      now,
      runActor: async () => outcome(APIFY_REDDIT_OPPORTUNITY_CONFIG, redditPost({
        title: 'Denver buyers comparing houses',
        body: 'We are buying a house in Denver and need advice before making an offer.',
        subreddit: 'RealEstate',
        permalink: '/r/RealEstate/comments/example/denver_buyers/',
        url: 'https://www.reddit.com/r/RealEstate/comments/example/denver_buyers/',
      })),
    })

    const result = await adapter.search({
      ...plan,
      provider_query: {
        ...plan.provider_query,
        locations: ['Phoenix, Arizona'],
        search_query: '"Phoenix" AND ("looking to buy" OR "house hunting")',
        opportunity_intent_lane: 'buyer_intent',
        reddit_returned_content_filter_version: 'semantic-intent-location-v1',
        reddit_filter_required_intent: 'buyer_intent',
        reddit_filter_require_location: true,
      },
    })

    expect(result).toMatchObject({
      status: 'no_result',
      data: null,
      receipt: {
        returned_content_filter_version: 'semantic-intent-location-v1',
        returned_content_filtered_rows: 1,
      },
    })
  })

  it('refuses an unbounded or geographically unanchored global Reddit search before a paid call', async () => {
    const runActor = jest.fn(async () => outcome(APIFY_REDDIT_OPPORTUNITY_CONFIG, redditPost()))
    const adapter = createApifyRedditOpportunityAdapter({
      env: envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      now,
      runActor,
    })
    const result = await adapter.search({
      ...plan,
      geography: 'US',
      max_candidates: 11,
      provider_query: {
        ...plan.provider_query,
        locations: ['Austin, Texas'],
        search_query: 'thinking of selling my home',
        reddit_subreddits: [],
        reddit_auto_discover: true,
        reddit_max_subreddits: 6,
        reddit_global_search: true,
      },
    })

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('global Reddit search is limited to 10 results'),
    })
    expect(runActor).not.toHaveBeenCalled()
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

    const threadsRun = jest.fn(async () =>
      outcome(APIFY_THREADS_OPPORTUNITY_CONFIG, threadsPost()),
    )
    const threads = createApifyThreadsOpportunityAdapter({
      env: {
        ...envFor(APIFY_THREADS_OPPORTUNITY_CONFIG),
        GTM_APIFY_THREADS_OPPORTUNITY_ENABLED: 'true',
      },
      now,
      runActor: threadsRun,
    })
    await threads.search(plan)
    expect(threadsRun).toHaveBeenCalledWith(
      APIFY_THREADS_OPPORTUNITY_CONFIG.actorId,
      {
        action: 'search',
        queries: ['South Bay buying or selling a home'],
        serp_type: 'default',
        maxItems: 5,
        useOurAccounts: true,
      },
      expect.objectContaining({
        build: APIFY_THREADS_OPPORTUNITY_CONFIG.actorBuild,
        maxItems: 5,
        maxChargeUsd: 0.02,
      }),
    )
  })

  it('maps a 30-day retrieval window to the actor month filter', async () => {
    const redditRun = jest.fn(async () => outcome(APIFY_REDDIT_OPPORTUNITY_CONFIG, redditPost()))
    const reddit = createApifyRedditOpportunityAdapter({
      env: envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      now,
      runActor: redditRun,
    })

    await reddit.search({
      ...plan,
      provider_query: {
        ...plan.provider_query,
        recency_window: 'last 30 days',
      },
    })

    expect(redditRun).toHaveBeenCalledWith(
      APIFY_REDDIT_OPPORTUNITY_CONFIG.actorId,
      expect.objectContaining({ timeFilter: 'month' }),
      expect.any(Object),
    )
  })

  it('settles an exact start-only Reddit response as a paid no-result', async () => {
    const config = APIFY_REDDIT_OPPORTUNITY_CONFIG
    const startCost = config.eventPricesUsd['apify-actor-start']
    const result = await createApifyRedditOpportunityAdapter({
      env: envFor(config),
      now,
      runActor: async () =>
        outcome(config, redditPost(), {
          status: 'no_result',
          items: [],
          itemCount: 0,
          chargedEventCounts: { 'apify-actor-start': 1 },
          providerCostUsd: startCost,
        }),
    }).search(plan)

    expect(result).toMatchObject({
      status: 'no_result',
      data: null,
      cost_units: startCost / 0.001,
      receipt: {
        billing_finalized: true,
      },
    })
  })

  it('parks an unbilled dataset row instead of treating it as a result', async () => {
    const config = APIFY_REDDIT_OPPORTUNITY_CONFIG
    const result = await createApifyRedditOpportunityAdapter({
      env: envFor(config),
      now,
      runActor: async () =>
        outcome(config, redditPost(), {
          chargedEventCounts: { 'apify-actor-start': 1 },
          providerCostUsd: config.eventPricesUsd['apify-actor-start'],
        }),
    }).search(plan)

    expect(result).toMatchObject({
      status: 'ambiguous',
      data: null,
      cost_units: null,
      error: expect.stringContaining('billed result count did not match'),
    })
  })

  it.each([
    [APIFY_REDDIT_OPPORTUNITY_CONFIG, createApifyRedditOpportunityAdapter, redditPost(), 'Reddit'],
    [APIFY_X_OPPORTUNITY_CONFIG, createApifyXOpportunityAdapter, xPost(), 'X'],
    [APIFY_THREADS_OPPORTUNITY_CONFIG, createApifyThreadsOpportunityAdapter, threadsPost(), 'Threads'],
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

  it('parks a missing Reddit dataset-item charge instead of guessing the receipt', async () => {
    const config = APIFY_REDDIT_OPPORTUNITY_CONFIG
    const result = await createApifyRedditOpportunityAdapter({
      env: envFor(config),
      now,
      runActor: async () => outcome(config, redditPost(), {
        chargedEventCounts: {
          'apify-actor-start': 1,
          'result-scraped': 1,
        },
        providerCostUsd:
          config.eventPricesUsd['apify-actor-start'] + config.eventPricesUsd['result-scraped'],
      }),
    }).search(plan)
    expect(result).toMatchObject({ status: 'ambiguous', cost_units: null })
    expect(result.error).toContain('auxiliary billed result count')
  })

  it('parks an unknown Threads billing event instead of treating it as post spend', async () => {
    const config = APIFY_THREADS_OPPORTUNITY_CONFIG
    const result = await createApifyThreadsOpportunityAdapter({
      env: {
        ...envFor(config),
        GTM_APIFY_THREADS_OPPORTUNITY_ENABLED: 'true',
      },
      now,
      runActor: async () => outcome(config, threadsPost(), {
        chargedEventCounts: {
          'apify-actor-start': 1,
          'apify-default-dataset-item': 1,
          'profile-result': 1,
        },
        providerCostUsd: 0.005,
      }),
    }).search(plan)
    expect(result).toMatchObject({ status: 'ambiguous', cost_units: null })
    expect(result.error).toContain('unapproved public social event')
  })

  it('parks a successful result when its run-start event is missing', async () => {
    const config = APIFY_REDDIT_OPPORTUNITY_CONFIG
    const result = await createApifyRedditOpportunityAdapter({
      env: envFor(config),
      now,
      runActor: async () => outcome(config, redditPost(), {
        chargedEventCounts: {
          'apify-default-dataset-item': 1,
          'result-scraped': 1,
        },
        providerCostUsd:
          config.eventPricesUsd['apify-default-dataset-item'] + config.eventPricesUsd['result-scraped'],
      }),
    }).search(plan)
    expect(result).toMatchObject({ status: 'ambiguous', cost_units: null })
    expect(result.error).toContain('run-start charge did not match')
  })

  it('charges finalized provider work when every returned row fails safe normalization', async () => {
    const config = APIFY_REDDIT_OPPORTUNITY_CONFIG
    const billed = outcome(
      config,
      redditPost({
        url: 'javascript:alert(1)',
        permalink: 'javascript:alert(1)',
      }),
    )
    const result = await createApifyRedditOpportunityAdapter({
      env: envFor(config),
      now,
      runActor: async () => billed,
    }).search(plan)

    expect(result).toMatchObject({
      status: 'error',
      data: null,
      cost_units: billed.providerCostUsd! / 0.001,
      receipt: {
        billing_finalized: true,
        parser_dropped_rows: 1,
      },
      error: expect.stringContaining('no safe public opportunity'),
    })
  })

  // Review 2026-09-02 (M8): no_result settled before the billed-count checks,
  // so 10 billed results against an empty dataset read were charged as a
  // definitive "nothing found".
  it('parks an empty dataset whose receipt still bills results instead of settling no_result', async () => {
    const config = APIFY_REDDIT_OPPORTUNITY_CONFIG
    const billed = outcome(config, redditPost(), {
      kind: 'no_result',
      status: 'no_result',
      items: [],
      itemCount: 0,
      chargedEventCounts: {
        'apify-actor-start': 1,
        'result-scraped': 10,
        'apify-default-dataset-item': 10,
      },
      providerCostUsd: config.eventPricesUsd['apify-actor-start']
        + 10 * config.eventPricesUsd['result-scraped']
        + 10 * config.eventPricesUsd['apify-default-dataset-item'],
    })
    const result = await createApifyRedditOpportunityAdapter({
      env: envFor(config),
      now,
      runActor: async () => billed,
    }).search(plan)
    expect(result).toMatchObject({ status: 'ambiguous', cost_units: null })

    const clean = outcome(config, redditPost(), {
      kind: 'no_result',
      status: 'no_result',
      items: [],
      itemCount: 0,
      chargedEventCounts: { 'apify-actor-start': 1, 'result-scraped': 0, 'apify-default-dataset-item': 0 },
      providerCostUsd: config.eventPricesUsd['apify-actor-start'],
    })
    await expect(createApifyRedditOpportunityAdapter({
      env: envFor(config),
      now,
      runActor: async () => clean,
    }).search(plan)).resolves.toMatchObject({
      status: 'no_result',
      cost_units: config.eventPricesUsd['apify-actor-start'] / 0.001,
      receipt: expect.objectContaining({ billed_results: 0 }),
    })
  })

  it('preserves an exact finalized cost on a terminal provider error', async () => {
    const config = APIFY_REDDIT_OPPORTUNITY_CONFIG
    const billed = outcome(config, redditPost(), {
      kind: 'server_error',
      status: 'error',
      items: [],
      itemCount: 0,
      error: 'provider_error: actor failed after one charged start event',
      chargedEventCounts: { 'apify-actor-start': 1 },
      providerCostUsd: config.eventPricesUsd['apify-actor-start'],
    })
    const result = await createApifyRedditOpportunityAdapter({
      env: envFor(config),
      now,
      runActor: async () => billed,
    }).search(plan)

    expect(result).toMatchObject({
      status: 'error',
      data: null,
      cost_units: config.eventPricesUsd['apify-actor-start'] / 0.001,
      error: expect.stringContaining('failed after one charged start event'),
    })
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

  it('preserves the frozen Threads lane contract while routing realtor plays off the weak source', () => {
    const play = {
      marketType: 'b2c' as const,
      geography: 'Austin, Texas, US',
      signalKind: 'social_engagement',
      entityUnit: 'opportunities',
      audience: 'Austin people buying a home',
      signal: 'buyer intent',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
    }
    const lanes = buildOpportunityQueryLanes(
      play,
      APIFY_THREADS_OPPORTUNITY_CONFIG.adapterId,
      5,
    )
    expect(lanes).toHaveLength(3)
    expect(lanes[0]).toMatchObject({
      id: 'buyer_intent:1',
      intent: 'buyer_intent',
      query: 'austinhomebuyer',
      providerQuery: {
        query_lane_version: 'opportunity-query-v57',
        source_query_lane_id: 'buyer_intent:1',
        search_query: 'austinhomebuyer',
      },
    })
    expect(lanes.map((lane) => lane.query)).toEqual([
      'austinhomebuyer',
      'austinhousehunting',
      'austinfirsttimehomebuyer',
    ])

    const planned = buildSourcePlan(
      play,
      [
        createApifyThreadsOpportunityAdapter({
          env: envFor(APIFY_THREADS_OPPORTUNITY_CONFIG),
        }),
      ],
      { targetAccepted: 10, maxRawCandidates: 10, maxCredits: 30_000 },
      2,
    )
    expect(planned.ok).toBe(false)
    if (!planned.ok) {
      expect(planned.code).toBe('empty_adapter_plan')
      expect(planned.unsupportedDimensions).toContainEqual(expect.objectContaining({
        adapter_id: APIFY_THREADS_OPPORTUNITY_CONFIG.adapterId,
        reason: expect.stringContaining('Starter/BRONZE realtor probe'),
      }))
    }
  })

  it('freezes the fresh Reddit input to one subreddit, newest posts, and a hard 30-day cutoff', async () => {
    const runActor = jest.fn(async () => outcome(
      APIFY_REDDIT_FRESH_OPPORTUNITY_CONFIG,
      freshRedditPost(),
    ))
    const adapter = createApifyRedditFreshOpportunityAdapter({
      env: {
        ...envFor(APIFY_REDDIT_FRESH_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_FRESH_OPPORTUNITY_ENABLED: 'true',
      },
      now,
      runActor,
    })
    const lane = buildOpportunityQueryLanes({
      geography: 'Phoenix, Arizona, United States',
      audience: 'People publicly demonstrating that they want to buy a home in Phoenix',
      signal: 'A recent public question demonstrates home-buying intent.',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
    }, APIFY_REDDIT_FRESH_OPPORTUNITY_CONFIG.adapterId)[0]!
    await expect(adapter.search({
      signal_kind: 'social_engagement',
      entity_unit: 'opportunities',
      geography: 'US',
      query: lane.query,
      provider_query: lane.providerQuery,
      max_candidates: 10,
      max_charge_usd: 0.032,
    })).resolves.toMatchObject({ status: 'ok' })
    expect(runActor).toHaveBeenCalledWith(
      APIFY_REDDIT_FRESH_OPPORTUNITY_CONFIG.actorId,
      {
        searches: ['(title:"looking to buy" OR selftext:"looking to buy")'],
        searchCommunityName: 'Phoenix',
        searchPosts: true,
        searchComments: false,
        searchCommunities: false,
        searchUsers: false,
        sort: 'new',
        time: 'month',
        postDateLimit: '30 days',
        includeNSFW: false,
        skipComments: true,
        skipCommunityInfo: true,
        maxItems: 10,
      },
      expect.objectContaining({
        build: '1.1.36',
        maxItems: 10,
        maxChargeUsd: 0.032,
        datasetResultEvent: 'apify-default-dataset-item',
      }),
    )
  })

  it('freezes posted-after Reddit input to a precise direct-search URL and no optional data products', async () => {
    const runActor = jest.fn(async () => outcome(
      APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG,
      postedAfterRedditPost(),
    ))
    const adapter = createApifyRedditPostedAfterOpportunityAdapter({
      env: {
        ...envFor(APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_ENABLED: 'true',
      },
      now,
      runActor,
    })
    const lanes = buildOpportunityQueryLanes({
      geography: 'Phoenix, Arizona, United States',
      audience: 'People publicly demonstrating that they want to buy a home in Phoenix',
      signal: 'A recent public question demonstrates home-buying intent.',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
    }, APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG.adapterId)
    expect(lanes.map(({ query, providerQuery }) => ({
      query,
      subreddits: providerQuery.reddit_subreddits,
      global: providerQuery.reddit_global_search,
      requireLocation: providerQuery.reddit_filter_require_location,
    }))).toEqual([
      {
        query: '("looking to buy a house" OR "looking to buy a home" OR "house hunting" OR "first time home buyer")',
        subreddits: ['Phoenix'],
        global: false,
        requireLocation: false,
      },
      {
        query: '("looking to buy a house" OR "looking to buy a home" OR "house hunting" OR "first time home buyer")',
        subreddits: ['AskPhoenix'],
        global: false,
        requireLocation: false,
      },
      {
        query: '"Phoenix" AND ("looking to buy a house" OR "looking to buy a home" OR "house hunting" OR "first time home buyer")',
        subreddits: [],
        global: true,
        requireLocation: true,
      },
    ])
    const sellerLanes = buildOpportunityQueryLanes({
      geography: 'Denver, Colorado, United States',
      audience: 'Denver homeowners publicly demonstrating that they want to sell a home',
      signal: 'A recent public question demonstrates home-selling intent.',
      providerQuery: { opportunity_intent_lane: 'seller_intent' },
    }, APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG.adapterId)
    expect(sellerLanes.map(({ query, providerQuery }) => ({
      query,
      subreddits: providerQuery.reddit_subreddits,
      global: providerQuery.reddit_global_search,
      version: providerQuery.query_lane_version,
    }))).toEqual([
      {
        query: '("selling my house" OR "selling my home" OR "sell my house" OR "sell my home")',
        subreddits: ['Denver'],
        global: false,
        version: 'opportunity-query-v79',
      },
      {
        query: '("selling my house" OR "selling my home" OR "sell my house" OR "sell my home")',
        subreddits: ['AskDenver'],
        global: false,
        version: 'opportunity-query-v79',
      },
      {
        query: '"Denver" AND ("selling my house" OR "selling my home" OR "sell my house" OR "sell my home")',
        subreddits: [],
        global: true,
        version: 'opportunity-query-v79',
      },
    ])
    const lane = lanes[0]!
    await expect(adapter.search({
      signal_kind: 'social_engagement',
      entity_unit: 'opportunities',
      geography: 'US',
      query: lane.query,
      provider_query: lane.providerQuery,
      max_candidates: 10,
      max_charge_usd: 0.058,
    })).resolves.toMatchObject({
      status: 'ok',
      data: [expect.objectContaining({
        identity: expect.objectContaining({
          platform: 'Reddit',
          location: 'Phoenix, Arizona, United States',
        }),
      })],
      receipt: expect.objectContaining({
        billed_results: 1,
        billing_finalized: true,
      }),
    })
    expect(runActor).toHaveBeenCalledWith(
      APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG.actorId,
      {
        searchTerms: [],
        searchPosts: false,
        searchComments: false,
        searchCommunities: false,
        withinCommunity: '',
        searchSort: 'new',
        searchTime: 'month',
        startUrls: [{
          url: 'https://www.reddit.com/r/Phoenix/search/?q=%28%22looking+to+buy+a+house%22+OR+%22looking+to+buy+a+home%22+OR+%22house+hunting%22+OR+%22first+time+home+buyer%22%29&sort=new&t=month&type=link&restrict_sr=on',
        }],
        fastMode: false,
        subredditUrls: [],
        postedAfter: '2026-07-28',
        onlyWithFlair: false,
        crawlCommentsPerPost: false,
        includeNSFW: false,
        maxPostsCount: 10,
        maxCommentsCount: 0,
        maxCommentsPerPost: 0,
        maxCommunitiesCount: 0,
        aiAnalysis: false,
        customLabels: {},
      },
      expect.objectContaining({
        build: '0.0.384',
        maxItems: 10,
        maxChargeUsd: 0.058,
        memoryMbytes: 2_048,
        datasetResultEvent: 'result',
      }),
    )
  })

  it('binds the global precise Reddit lane to the exact market and reconciles two init units', async () => {
    const runActor = jest.fn(async () => outcome(
      APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG,
      postedAfterRedditPost(),
      {
        chargedEventCounts: { init: 2, result: 1 },
        providerCostUsd: 0.0418,
      },
    ))
    const adapter = createApifyRedditPostedAfterOpportunityAdapter({
      env: {
        ...envFor(APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_ENABLED: 'true',
      },
      now,
      runActor,
    })
    const lane = buildOpportunityQueryLanes({
      geography: 'Phoenix, Arizona, United States',
      audience: 'People publicly demonstrating that they want to buy a home in Phoenix',
      signal: 'A recent public question demonstrates home-buying intent.',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
    }, APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG.adapterId)[2]!
    await expect(adapter.search({
      signal_kind: 'social_engagement',
      entity_unit: 'opportunities',
      geography: 'US',
      query: lane.query,
      provider_query: lane.providerQuery,
      max_candidates: 10,
      max_charge_usd: 0.058,
    })).resolves.toMatchObject({ status: 'ok', cost_units: 41.8 })

    const input = runActor.mock.calls[0]![1]
    const startUrl = new URL((input.startUrls as Array<{ url: string }>)[0]!.url)
    expect(startUrl.origin).toBe('https://www.reddit.com')
    expect(startUrl.pathname).toBe('/search/')
    expect(startUrl.searchParams.get('q')).toBe(
      '"Phoenix" AND ("looking to buy a house" OR "looking to buy a home" OR "house hunting" OR "first time home buyer")',
    )
    expect(startUrl.searchParams.get('restrict_sr')).toBeNull()
    expect(runActor.mock.calls[0]![2]).toMatchObject({
      maxChargeUsd: 0.058,
      memoryMbytes: 2_048,
    })
  })

  it('continues to execute an already-quoted v76 precise Reddit plan', async () => {
    const runActor = jest.fn(async () => outcome(
      APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG,
      postedAfterRedditPost(),
    ))
    const adapter = createApifyRedditPostedAfterOpportunityAdapter({
      env: {
        ...envFor(APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_ENABLED: 'true',
      },
      now,
      runActor,
    })
    const legacyQuery = '("looking to buy" OR "house hunting" OR "first time home buyer" OR "buy a house")'
    const currentLane = buildOpportunityQueryLanes({
      geography: 'Phoenix, Arizona, United States',
      audience: 'People publicly demonstrating that they want to buy a home in Phoenix',
      signal: 'A recent public question demonstrates home-buying intent.',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
    }, APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG.adapterId)[0]!
    const legacyProviderQuery = {
      ...currentLane.providerQuery,
      query_lane_version: 'opportunity-query-v76',
      search_query: legacyQuery,
      source_search_keywords: [legacyQuery],
      reddit_search_syntax_version: 'exact-phrase-or-url-v1',
      reddit_returned_content_filter_version: 'semantic-intent-location-v3',
    }

    await expect(adapter.search({
      signal_kind: 'social_engagement',
      entity_unit: 'opportunities',
      geography: 'US',
      query: legacyQuery,
      provider_query: legacyProviderQuery,
      max_candidates: 10,
      max_charge_usd: 0.058,
    })).resolves.toMatchObject({
      status: 'ok',
      receipt: expect.objectContaining({
        returned_content_filter_version: 'semantic-intent-location-v3',
      }),
    })
    expect(runActor).toHaveBeenCalledTimes(1)
  })

  it('continues to execute an already-quoted v78 residential-conjunction plan', async () => {
    const runActor = jest.fn(async () => outcome(
      APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG,
      postedAfterRedditPost(),
    ))
    const adapter = createApifyRedditPostedAfterOpportunityAdapter({
      env: {
        ...envFor(APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_ENABLED: 'true',
      },
      now,
      runActor,
    })
    const legacyQuery = '("looking to buy" OR "house hunting" OR "first time home buyer" OR "buy a house") AND ("home" OR "house" OR "condo" OR "townhome" OR "property")'
    const currentLane = buildOpportunityQueryLanes({
      geography: 'Phoenix, Arizona, United States',
      audience: 'People publicly demonstrating that they want to buy a home in Phoenix',
      signal: 'A recent public question demonstrates home-buying intent.',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
    }, APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG.adapterId)[0]!
    const legacyProviderQuery = {
      ...currentLane.providerQuery,
      query_lane_version: 'opportunity-query-v78',
      search_query: legacyQuery,
      source_search_keywords: [legacyQuery],
      reddit_search_syntax_version: 'exact-phrase-residential-and-v2',
    }

    await expect(adapter.search({
      signal_kind: 'social_engagement',
      entity_unit: 'opportunities',
      geography: 'US',
      query: legacyQuery,
      provider_query: legacyProviderQuery,
      max_candidates: 10,
      max_charge_usd: 0.058,
    })).resolves.toMatchObject({
      status: 'ok',
      receipt: expect.objectContaining({
        returned_content_filter_version: 'semantic-intent-location-v4',
      }),
    })
    expect(runActor).toHaveBeenCalledTimes(1)
  })

  it('keeps a current AskPhoenix buyer search under the v4 semantic contract', async () => {
    const adapter = createApifyRedditPostedAfterOpportunityAdapter({
      env: {
        ...envFor(APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_ENABLED: 'true',
      },
      now,
      runActor: async () => outcome(
        APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG,
        [
          postedAfterRedditPost({
            id: 't3_east_valley',
            postUrl: 'https://www.reddit.com/r/AskPhoenix/comments/east_valley/home_buying_advice/',
            title: 'East Valley home-buying advice: San Tan Valley vs. North Mesa?',
            body: [
              'I’m starting to look at buying, but I am still new to the area.',
              'I am balancing commute with affordability and comparing houses in several neighborhoods.',
            ].join(' '),
            communityName: 'r/AskPhoenix',
            parsedCommunityName: 'AskPhoenix',
          }),
          postedAfterRedditPost({
            id: 't3_keyboard',
            postUrl: 'https://www.reddit.com/r/AskPhoenix/comments/keyboard/product_search/',
            title: 'Quiet keyboard recommendation?',
            body: 'I’m starting to look at buying a mechanical keyboard for my office commute.',
            communityName: 'r/AskPhoenix',
            parsedCommunityName: 'AskPhoenix',
          }),
        ],
      ),
    })
    const lane = buildOpportunityQueryLanes({
      geography: 'Phoenix, Arizona, United States',
      audience: 'People publicly demonstrating that they want to buy a home in Phoenix',
      signal: 'A recent public question demonstrates home-buying intent.',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
    }, APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG.adapterId)[1]!

    expect(lane.providerQuery).toMatchObject({
      query_lane_version: 'opportunity-query-v79',
      reddit_search_syntax_version: 'exact-residential-intent-phrases-v3',
      reddit_returned_content_filter_version: 'semantic-intent-location-v4',
      reddit_subreddits: ['AskPhoenix'],
      reddit_filter_require_location: false,
    })
    await expect(adapter.search({
      signal_kind: 'social_engagement',
      entity_unit: 'opportunities',
      geography: 'US',
      query: lane.query,
      provider_query: lane.providerQuery,
      max_candidates: 10,
      max_charge_usd: 0.058,
    })).resolves.toMatchObject({
      status: 'partial',
      data: [{
        identity: expect.objectContaining({
          intent_kind: 'buyer_intent',
          location: 'Phoenix, Arizona, United States',
        }),
      }],
      receipt: expect.objectContaining({
        returned_content_filter_version: 'semantic-intent-location-v4',
        returned_content_filtered_rows: 1,
      }),
    })
  })

  it('refuses altered posted-after Reddit scope and product contracts before provider contact', async () => {
    const runActor = jest.fn()
    const adapter = createApifyRedditPostedAfterOpportunityAdapter({
      env: {
        ...envFor(APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_ENABLED: 'true',
      },
      now,
      runActor,
    })
    const lane = buildOpportunityQueryLanes({
      geography: 'Phoenix, Arizona, United States',
      audience: 'People publicly demonstrating that they want to buy a home in Phoenix',
      signal: 'A recent public question demonstrates home-buying intent.',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
    }, APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG.adapterId)[0]!
    for (const provider_query of [
      { ...lane.providerQuery, reddit_posted_after_window_days: 31 },
      { ...lane.providerQuery, reddit_posted_after_contract_version: 'unfrozen' },
      { ...lane.providerQuery, reddit_search_syntax_version: 'unfrozen' },
      { ...lane.providerQuery, reddit_subreddits: [] },
      { ...lane.providerQuery, reddit_filter_require_location: true },
      { ...lane.providerQuery, search_query: 'author:example' },
      { ...lane.providerQuery, search_query: '("looking to buy" OR "house hunting" OR "first time home buyer" OR "moving soon")' },
    ]) {
      await expect(adapter.search({
        ...plan,
        query: String(provider_query.search_query),
        provider_query,
        max_candidates: 10,
        max_charge_usd: 0.038,
      })).resolves.toMatchObject({
        status: 'error',
        cost_units: 0,
        error: expect.stringContaining('bad_request'),
      })
    }
    expect(runActor).not.toHaveBeenCalled()
  })

  it('drops removed posted-after Reddit rows while retaining their finalized cost', async () => {
    const adapter = createApifyRedditPostedAfterOpportunityAdapter({
      env: {
        ...envFor(APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_ENABLED: 'true',
      },
      now,
      runActor: async () => outcome(
        APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG,
        postedAfterRedditPost({ removedByCategory: 'moderator' }),
      ),
    })
    const lane = buildOpportunityQueryLanes({
      geography: 'Phoenix, Arizona, United States',
      audience: 'People publicly demonstrating that they want to buy a home in Phoenix',
      signal: 'A recent public question demonstrates home-buying intent.',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
    }, APIFY_REDDIT_POSTED_AFTER_OPPORTUNITY_CONFIG.adapterId)[0]!
    await expect(adapter.search({
      ...plan,
      query: lane.query,
      provider_query: lane.providerQuery,
      max_candidates: 10,
      max_charge_usd: 0.038,
    })).resolves.toMatchObject({
      status: 'error',
      data: null,
      cost_units: 21.8,
      receipt: expect.objectContaining({ parser_dropped_rows: 1 }),
    })
  })

  it('refuses altered fresh Reddit freshness, scope, and content contracts before provider contact', async () => {
    const runActor = jest.fn()
    const adapter = createApifyRedditFreshOpportunityAdapter({
      env: {
        ...envFor(APIFY_REDDIT_FRESH_OPPORTUNITY_CONFIG),
        GTM_APIFY_REDDIT_FRESH_OPPORTUNITY_ENABLED: 'true',
      },
      now,
      runActor,
    })
    const baseProviderQuery = {
      source_search_keywords: ['(title:"looking to buy" OR selftext:"looking to buy")'],
      search_query: '(title:"looking to buy" OR selftext:"looking to buy")',
      locations: ['Phoenix, Arizona'],
      opportunity_intent_lane: 'buyer_intent',
      reddit_fresh_contract_version: 'public-post-search-v2',
      reddit_search_syntax_version: 'field-qualified-exact-phrase-bank-v3',
      reddit_fresh_window_days: 30,
      reddit_returned_content_filter_version: 'semantic-intent-location-v3',
      reddit_filter_required_intent: 'buyer_intent',
      reddit_filter_require_location: false,
      reddit_subreddits: ['Phoenix'],
      reddit_auto_discover: false,
      reddit_global_search: false,
    }
    for (const provider_query of [
      { ...baseProviderQuery, reddit_fresh_window_days: 31 },
      { ...baseProviderQuery, reddit_subreddits: [] },
      { ...baseProviderQuery, reddit_fresh_contract_version: 'unfrozen' },
      { ...baseProviderQuery, reddit_search_syntax_version: 'unfrozen' },
      {
        ...baseProviderQuery,
        source_search_keywords: ['looking for a realtor'],
        search_query: 'looking for a realtor',
      },
      {
        ...baseProviderQuery,
        source_search_keywords: ['(title:"realtor recommendation" OR selftext:"realtor recommendation") AND (title:"looking to buy" OR selftext:"looking to buy")'],
        search_query: '(title:"realtor recommendation" OR selftext:"realtor recommendation") AND (title:"looking to buy" OR selftext:"looking to buy")',
      },
      {
        ...baseProviderQuery,
        source_search_keywords: ['(title:"looking to buy" OR selftext:"buying a home")'],
        search_query: '(title:"looking to buy" OR selftext:"buying a home")',
      },
      {
        ...baseProviderQuery,
        source_search_keywords: ['author:"realtor"'],
        search_query: 'author:"realtor"',
      },
    ]) {
      await expect(adapter.search({
        ...plan,
        provider_query,
        max_candidates: 10,
        max_charge_usd: 0.032,
      })).resolves.toMatchObject({
        status: 'error',
        error: expect.stringContaining('bad_request'),
      })
    }
    expect(runActor).not.toHaveBeenCalled()
  })

  it('plans three Reddit and three fixed-charge-aware X shortfall lanes', () => {
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
        APIFY_X_OPPORTUNITY_CONFIG.adapterId,
        APIFY_REDDIT_OPPORTUNITY_CONFIG.adapterId,
        APIFY_X_OPPORTUNITY_CONFIG.adapterId,
        APIFY_REDDIT_OPPORTUNITY_CONFIG.adapterId,
        APIFY_X_OPPORTUNITY_CONFIG.adapterId,
        APIFY_REDDIT_OPPORTUNITY_CONFIG.adapterId,
        APIFY_REDDIT_OPPORTUNITY_CONFIG.adapterId,
        APIFY_REDDIT_OPPORTUNITY_CONFIG.adapterId,
      ])
      expect(result.adapterPlan.map((batch) => batch.maxCandidates)).toEqual([3, 3, 3, 3, 2, 2, 2, 2])
      expect(result.adapterPlan.reduce((sum, batch) => sum + batch.maxCandidates, 0)).toBe(20)
      expect(new Set(result.adapterPlan.map((batch) => `${batch.adapter_id}:${batch.queryLaneId}`)).size).toBe(8)
      expect(result.adapterPlan.every((batch) => batch.billableUnit === 'apify_millidollar')).toBe(true)
    }
  })

  it('builds three market-bound X lanes inside one raw and dollar ceiling', () => {
    const play = {
      marketType: 'b2c' as const,
      geography: 'Austin, Texas, US',
      signalKind: 'social_engagement',
      entityUnit: 'opportunities',
      audience: 'Austin people buying a home',
      signal: 'buyer intent',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
    }
    const lanes = buildOpportunityQueryLanes(play, APIFY_X_OPPORTUNITY_CONFIG.adapterId, 5)
    expect(lanes.map((lane) => lane.query)).toEqual([
      '#AustinHomebuyer',
      '#AustinHouseHunting',
      '#MovingToAustin',
    ])
    expect(lanes.every((lane) => (
      lane.providerQuery.query_lane_version === 'opportunity-query-v57'
      && lane.providerQuery.opportunity_intent_lane === 'buyer_intent'
    ))).toBe(true)

    const planned = buildSourcePlan(
      play,
      [
        createApifyXOpportunityAdapter({
          env: {
            ...envFor(APIFY_X_OPPORTUNITY_CONFIG),
            GTM_APIFY_X_OPPORTUNITY_ENABLED: 'true',
          },
        }),
      ],
      { targetAccepted: 9, maxRawCandidates: 9, maxCredits: 30_000 },
      2,
    )
    expect(planned.ok).toBe(true)
    if (planned.ok) {
      expect(planned.adapterPlan).toHaveLength(3)
      expect(planned.adapterPlan.map((batch) => batch.maxCandidates)).toEqual([3, 3, 3])
      expect(planned.plannedRawCapacity).toBe(9)
      // Each X lane reserves Apify's $0.01 provider minimum. At BRONZE, the
      // exact expected event cost for three starts and nine rows is $0.00975;
      // reconciliation charges the actual receipt instead of the reservation.
      expect(planned.estimatedCredits).toBe(15_000)
    }
  })
})
