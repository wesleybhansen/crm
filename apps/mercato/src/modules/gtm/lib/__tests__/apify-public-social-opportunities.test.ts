import type { ApifyRunOutcome } from '../adapters/apify/client'
import {
  APIFY_REDDIT_OPPORTUNITY_CONFIG,
  APIFY_THREADS_OPPORTUNITY_CONFIG,
  APIFY_X_OPPORTUNITY_CONFIG,
  createApifyRedditOpportunityAdapter,
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
  it('pins Reddit reservations to the production BRONZE account tier', () => {
    expect(APIFY_REDDIT_OPPORTUNITY_CONFIG).toMatchObject({
      actorId: 'clearpath/reddit-search-scraper',
      actorBuild: '0.0.66',
      requiredPriceVersion: 'clearpath-reddit-search-0.0.66-starter-events-2026-08-30',
      eventPricesUsd: {
        'apify-actor-start': 0.00099,
        'apify-default-dataset-item': 0.00001,
        'result-scraped': 0.00099,
      },
      oneTimeQuoteUsd: 0.00099,
      perItemQuoteUsd: 0.001,
    })
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
    expect(
      publicSocialOpportunityEnabled(
        APIFY_REDDIT_OPPORTUNITY_CONFIG,
        envFor(APIFY_REDDIT_OPPORTUNITY_CONFIG),
      ),
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
        maxItems: 9,
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

  it('builds three market-bound Threads lanes inside one raw ceiling', () => {
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
        query_lane_version: 'opportunity-query-v51',
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
    expect(planned.ok).toBe(true)
    if (planned.ok) {
      expect(planned.adapterPlan).toHaveLength(3)
      expect(planned.adapterPlan.map((batch) => batch.maxCandidates)).toEqual([4, 3, 3])
      expect(planned.plannedRawCapacity).toBe(10)
      // Each separately quoted lane reserves Apify's $0.01 minimum provider
      // cap. Final reconciliation still uses only the actual starts and
      // returned rows; the combined event cost for ten rows is $0.0203.
      expect(planned.estimatedCredits).toBe(15_000)
    }
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
        APIFY_REDDIT_OPPORTUNITY_CONFIG.adapterId,
        APIFY_REDDIT_OPPORTUNITY_CONFIG.adapterId,
        APIFY_REDDIT_OPPORTUNITY_CONFIG.adapterId,
        APIFY_X_OPPORTUNITY_CONFIG.adapterId,
        APIFY_X_OPPORTUNITY_CONFIG.adapterId,
        APIFY_X_OPPORTUNITY_CONFIG.adapterId,
      ])
      expect(result.adapterPlan.map((batch) => batch.maxCandidates)).toEqual([4, 4, 3, 3, 3, 3])
      expect(result.adapterPlan.reduce((sum, batch) => sum + batch.maxCandidates, 0)).toBe(20)
      expect(new Set(result.adapterPlan.map((batch) => `${batch.adapter_id}:${batch.queryLaneId}`)).size).toBe(6)
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
      lane.providerQuery.query_lane_version === 'opportunity-query-v51'
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
