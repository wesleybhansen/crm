import type { ApifyRunOutcome } from '../adapters/apify/client'
import {
  APIFY_INSTAGRAM_OPPORTUNITY_CONFIG,
  APIFY_TIKTOK_OPPORTUNITY_CONFIG,
  createApifyInstagramOpportunityAdapter,
  createApifyTikTokOpportunityAdapter,
  normalizeInstagramOpportunity,
  normalizeTikTokOpportunity,
  publicSocialOpportunityApproved,
  publicSocialOpportunityEnabled,
} from '../adapters/apify/public-social-opportunity-source'
import { APIFY_REQUIRED_PRICE_VERSION, APIFY_REQUIRED_TERMS_VERSION } from '../adapters/apify/source'
import type { SourceSearchPlan } from '../adapters/types'
import {
  buildOpportunityQueryLanes,
  opportunitySourceRouting,
} from '../research/opportunity-query-lanes'

const CLOCK = new Date('2026-08-30T19:00:00.000Z')
const now = () => CLOCK

type PublicPostConfig =
  | typeof APIFY_INSTAGRAM_OPPORTUNITY_CONFIG
  | typeof APIFY_TIKTOK_OPPORTUNITY_CONFIG

function approvedEnv(config: PublicPostConfig, overrides: Record<string, string> = {}) {
  return {
    GTM_APIFY_ENABLED: 'true',
    GTM_APIFY_ACCOUNT_TIER: 'BRONZE',
    GTM_APIFY_TOKEN: 'synthetic-public-post-token',
    GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
    GTM_APIFY_TERMS_VERSION: APIFY_REQUIRED_TERMS_VERSION,
    GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
    [config.enabledEnv!]: 'true',
    [config.useApprovalEnv]: 'true',
    [config.priceVersionEnv]: config.requiredPriceVersion,
    ...overrides,
  }
}

function plan(config: PublicPostConfig, query: string): SourceSearchPlan {
  return {
    signal_kind: 'social_engagement',
    entity_unit: 'opportunities',
    geography: 'US',
    query,
    provider_query: {
      query_lane_version: 'opportunity-query-v61',
      source_query_lane_id: 'buyer_intent:1',
      opportunity_intent_lane: 'buyer_intent',
      search_query: query,
      source_search_keywords: [query],
      locations: ['Austin, Texas'],
      social_public_post_contract_version: 'public-posts-v1',
      social_returned_content_filter_version: 'realtor-public-post-v1',
      social_filter_required_intent: 'buyer_intent',
      social_filter_require_location: true,
      social_window_days: 30,
    },
    max_candidates: 25,
    max_charge_usd: config.minimumMaxChargeUsd ?? 0.023,
  }
}

function instagramPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'instagram-post-1',
    type: 'Image',
    shortCode: 'ABC123',
    caption: 'Austin question: we are looking to buy a home in Austin this month. Which neighborhoods should we consider?',
    url: 'https://www.instagram.com/p/ABC123/',
    commentsCount: 7,
    likesCount: 24,
    videoPlayCount: 0,
    timestamp: '2026-08-28T16:00:00.000Z',
    ownerUsername: 'austin_public_author',
    ownerFullName: 'Austin Public Author',
    ownerId: 'owner-1',
    isSponsored: false,
    locationName: 'Austin, Texas',
    ...overrides,
  }
}

function tiktokPost(overrides: Record<string, unknown> = {}) {
  return {
    id: '7400000000000000001',
    text: 'Austin question: we are looking to buy a home in Austin this month. Which neighborhoods should we consider?',
    createTime: 1_777_574_400,
    createTimeISO: '2026-08-28T16:00:00.000Z',
    webVideoUrl: 'https://www.tiktok.com/@austin_public_author/video/7400000000000000001',
    locationCreated: 'US',
    isAd: false,
    isSponsored: false,
    diggCount: 31,
    shareCount: 4,
    playCount: 900,
    commentCount: 8,
    authorMeta: {
      name: 'austin_public_author',
      nickName: 'Austin Public Author',
      privateAccount: false,
      profileUrl: 'https://www.tiktok.com/@austin_public_author',
    },
    locationMeta: {
      city: 'Austin',
      address: 'Austin, TX, USA',
      countryCode: 'US',
      locationName: 'Austin, Texas',
    },
    ...overrides,
  }
}

function outcome(
  config: PublicPostConfig,
  item: Record<string, unknown>,
  overrides: Partial<ApifyRunOutcome> = {},
): ApifyRunOutcome {
  const instagram = config.platform === 'Instagram'
  return {
    kind: 'ok',
    status: 'ok',
    items: [item],
    actorId: config.actorId,
    runId: `synthetic-${config.platform.toLowerCase()}-run`,
    itemCount: 1,
    httpStatus: 201,
    retryAfterSeconds: null,
    bodySnippet: null,
    requestUrl: 'https://api.apify.com/v2/acts/redacted/runs?token=[redacted]',
    attemptedAt: CLOCK.toISOString(),
    error: null,
    billingFinalized: true,
    chargedEventCounts: instagram
      ? { result: 1 }
      : { 'actor-start': 1, result: 1, 'filter-applied': 1 },
    providerCostUsd: instagram ? 0.0023 : 0.005,
    pricingModel: 'PAY_PER_EVENT',
    ...overrides,
  }
}

describe('Apify Instagram and TikTok public-post opportunities', () => {
  it('pins exact current actor builds, account rates, and bounded reservation contracts', () => {
    expect(APIFY_INSTAGRAM_OPPORTUNITY_CONFIG).toMatchObject({
      actorId: 'apify/instagram-scraper',
      actorBuild: '0.0.775',
      requiredPriceVersion: 'apify-instagram-scraper-0.0.775-bronze-events-2026-08-30',
      eventPricesUsd: { result: 0.0023 },
      perItemQuoteUsd: 0.0023,
      oneTimeQuoteUsd: 0,
      maxBatch: 10,
    })
    expect(APIFY_TIKTOK_OPPORTUNITY_CONFIG).toMatchObject({
      actorId: 'clockworks/tiktok-scraper',
      actorBuild: '0.0.600',
      requiredPriceVersion: 'clockworks-tiktok-scraper-0.0.600-bronze-events-2026-08-30',
      eventPricesUsd: { 'actor-start': 0.001, result: 0.003, 'filter-applied': 0.001 },
      perItemQuoteUsd: 0.004,
      oneTimeQuoteUsd: 0.001,
      minimumMaxChargeUsd: 0.5,
      maxBatch: 10,
    })
  })

  it.each([
    APIFY_INSTAGRAM_OPPORTUNITY_CONFIG,
    APIFY_TIKTOK_OPPORTUNITY_CONFIG,
  ])('fails closed for $platform unless every capability and exact price gate matches', (config) => {
    const env = approvedEnv(config)
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

  it('routes initial public-post sourcing only to realtor plays and emits three frozen lanes', () => {
    const play = {
      audience: 'Austin first-time home buyers',
      signal: 'People publicly asking for help buying a home',
      geography: 'Austin, Texas',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
    }
    expect(opportunitySourceRouting(play, APIFY_INSTAGRAM_OPPORTUNITY_CONFIG.adapterId)).toEqual({
      eligible: true,
      reason: null,
    })
    expect(opportunitySourceRouting(play, APIFY_TIKTOK_OPPORTUNITY_CONFIG.adapterId)).toEqual({
      eligible: true,
      reason: null,
    })
    const instagram = buildOpportunityQueryLanes(
      play,
      APIFY_INSTAGRAM_OPPORTUNITY_CONFIG.adapterId,
    )
    const tiktok = buildOpportunityQueryLanes(play, APIFY_TIKTOK_OPPORTUNITY_CONFIG.adapterId)
    expect(instagram.map((lane) => lane.query)).toEqual([
      '#FirstTimeHomeBuyer',
      '#HouseHunting',
      '#Austin',
    ])
    expect(tiktok.map((lane) => lane.query)).toEqual([
      'Austin first time home buyer',
      'Austin house hunting',
      'moving to Austin home',
    ])
    expect([...instagram, ...tiktok].every((lane) =>
      lane.providerQuery.query_lane_version === 'opportunity-query-v61'
      && lane.providerQuery.social_public_post_contract_version === 'public-posts-v1'
      && lane.providerQuery.social_returned_content_filter_version === 'realtor-public-post-v1'
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
      APIFY_INSTAGRAM_OPPORTUNITY_CONFIG.adapterId,
    ).eligible).toBe(false)
  })

  it('builds the exact metered Instagram input and accepts only returned-content evidence', async () => {
    const runActor = jest.fn(async () => outcome(
      APIFY_INSTAGRAM_OPPORTUNITY_CONFIG,
      instagramPost(),
    ))
    const adapter = createApifyInstagramOpportunityAdapter({
      env: approvedEnv(APIFY_INSTAGRAM_OPPORTUNITY_CONFIG),
      now,
      runActor,
    })
    const searchPlan = plan(APIFY_INSTAGRAM_OPPORTUNITY_CONFIG, '#FirstTimeHomeBuyer')
    expect(adapter.quote(searchPlan)).toMatchObject({ max_candidates: 10, provider_units: 23 })
    const result = await adapter.search(searchPlan)
    expect(runActor).toHaveBeenCalledWith(
      APIFY_INSTAGRAM_OPPORTUNITY_CONFIG.actorId,
      {
        resultsType: 'posts',
        search: '#FirstTimeHomeBuyer',
        searchType: 'hashtag',
        searchLimit: 1,
        resultsLimit: 10,
        onlyPostsNewerThan: '2026-07-31',
        addParentData: false,
      },
      expect.objectContaining({
        build: '0.0.775',
        maxChargeUsd: 0.023,
        maxItems: 10,
      }),
    )
    expect(result).toMatchObject({
      status: 'ok',
      cost_units: 2.3,
      data: [{
        identity: {
          platform: 'Instagram',
          opportunity_kind: 'post',
          location: 'Austin, Texas',
          source_published_at: '2026-08-28T16:00:00.000Z',
        },
      }],
      receipt: expect.objectContaining({
        charged_event_counts: { result: 1 },
        returned_content_filter_version: 'realtor-public-post-v1',
      }),
    })
  })

  it('builds the exact minimal TikTok input and reserves the provider-required ceiling', async () => {
    const runActor = jest.fn(async () => outcome(
      APIFY_TIKTOK_OPPORTUNITY_CONFIG,
      tiktokPost(),
    ))
    const adapter = createApifyTikTokOpportunityAdapter({
      env: approvedEnv(APIFY_TIKTOK_OPPORTUNITY_CONFIG),
      now,
      runActor,
    })
    const searchPlan = plan(APIFY_TIKTOK_OPPORTUNITY_CONFIG, 'Austin first time home buyer')
    expect(adapter.quote(searchPlan)).toMatchObject({ max_candidates: 10, provider_units: 500 })
    const result = await adapter.search(searchPlan)
    expect(runActor).toHaveBeenCalledWith(
      APIFY_TIKTOK_OPPORTUNITY_CONFIG.actorId,
      {
        searchQueries: ['Austin first time home buyer'],
        resultsPerPage: 10,
        searchSection: '/video',
        videoSearchDateFilter: 'PAST_MONTH',
        scrapeRelatedSearchWords: false,
        scrapeRelatedVideos: false,
        scrapeAdditionalAuthorMeta: false,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
        shouldDownloadSlideshowImages: false,
        shouldDownloadAvatars: false,
        shouldDownloadMusicCovers: false,
        downloadSubtitlesOptions: 'NEVER_DOWNLOAD_SUBTITLES',
        aiVideoDescription: false,
        aiVideoSummary: false,
        commentsPerPost: 0,
        topLevelCommentsPerPost: 0,
        maxRepliesPerComment: 0,
      },
      expect.objectContaining({
        build: '0.0.600',
        maxChargeUsd: 0.5,
        maxItems: 10,
      }),
    )
    expect(result).toMatchObject({
      status: 'ok',
      cost_units: 5,
      data: [{ identity: { platform: 'TikTok', location: 'Austin, Texas' } }],
      receipt: expect.objectContaining({
        charged_event_counts: { 'actor-start': 1, result: 1, 'filter-applied': 1 },
        provider_cost_usd: 0.005,
      }),
    })
  })

  it('rejects stale, sponsored, private, unsafe, and off-platform rows before fit-v7', () => {
    const instagramContext = {
      query: '#FirstTimeHomeBuyer',
      location: 'Austin, Texas',
      expectedIntent: 'buyer_intent' as const,
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_INSTAGRAM_OPPORTUNITY_CONFIG.actorId,
    }
    expect(normalizeInstagramOpportunity(instagramPost({
      timestamp: '2026-07-01T00:00:00.000Z',
    }), instagramContext)).toBeNull()
    expect(normalizeInstagramOpportunity(instagramPost({ isSponsored: true }), instagramContext)).toBeNull()
    expect(normalizeInstagramOpportunity(instagramPost({
      url: 'https://example.com/p/ABC123/',
    }), instagramContext)).toBeNull()
    expect(normalizeInstagramOpportunity(instagramPost({
      caption: 'Austin foreclosure distress targeting for a home sale.',
    }), instagramContext)).toBeNull()

    const tiktokContext = {
      query: 'Austin first time home buyer',
      location: 'Austin, Texas',
      expectedIntent: 'buyer_intent' as const,
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_TIKTOK_OPPORTUNITY_CONFIG.actorId,
    }
    expect(normalizeTikTokOpportunity(tiktokPost({ isAd: true }), tiktokContext)).toBeNull()
    expect(normalizeTikTokOpportunity(tiktokPost({
      authorMeta: { privateAccount: true },
    }), tiktokContext)).toBeNull()
    expect(normalizeTikTokOpportunity(tiktokPost({
      webVideoUrl: 'https://example.com/@author/video/7400000000000000001',
    }), tiktokContext)).toBeNull()
  })

  it('does not let a buyer-oriented query manufacture intent in irrelevant returned content', async () => {
    const returned = instagramPost({
      caption: 'A beautiful Austin kitchen inspiration board with blue cabinets.',
    })
    const runActor = jest.fn(async () => outcome(APIFY_INSTAGRAM_OPPORTUNITY_CONFIG, returned))
    const result = await createApifyInstagramOpportunityAdapter({
      env: approvedEnv(APIFY_INSTAGRAM_OPPORTUNITY_CONFIG),
      now,
      runActor,
    }).search(plan(APIFY_INSTAGRAM_OPPORTUNITY_CONFIG, '#FirstTimeHomeBuyer'))
    expect(result).toMatchObject({
      status: 'no_result',
      data: null,
      cost_units: 2.3,
      error: 'no_result_after_returned_content_filter',
      receipt: expect.objectContaining({
        returned_content_filter_version: 'realtor-public-post-v1',
        returned_content_filtered_rows: 1,
      }),
    })
  })

  it('refuses a TikTok run below the provider ceiling and parks billing drift', async () => {
    const runActor = jest.fn(async () => outcome(
      APIFY_TIKTOK_OPPORTUNITY_CONFIG,
      tiktokPost(),
    ))
    const adapter = createApifyTikTokOpportunityAdapter({
      env: approvedEnv(APIFY_TIKTOK_OPPORTUNITY_CONFIG),
      now,
      runActor,
    })
    const belowFloor = await adapter.search({
      ...plan(APIFY_TIKTOK_OPPORTUNITY_CONFIG, 'Austin first time home buyer'),
      max_charge_usd: 0.499,
    })
    expect(belowFloor).toMatchObject({ status: 'error', cost_units: 0 })
    expect(runActor).not.toHaveBeenCalled()

    runActor.mockImplementationOnce(async () => outcome(
      APIFY_TIKTOK_OPPORTUNITY_CONFIG,
      tiktokPost(),
      {
        chargedEventCounts: { 'actor-start': 1, result: 1, 'filter-applied': 0 },
        providerCostUsd: 0.004,
      },
    ))
    const mismatch = await adapter.search(
      plan(APIFY_TIKTOK_OPPORTUNITY_CONFIG, 'Austin first time home buyer'),
    )
    expect(mismatch).toMatchObject({ status: 'ambiguous', cost_units: null })
  })
})
