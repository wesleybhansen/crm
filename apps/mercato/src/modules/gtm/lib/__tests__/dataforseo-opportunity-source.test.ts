import {
  DATAFORSEO_OPPORTUNITY_ADAPTER_ID,
  DATAFORSEO_OPPORTUNITY_PRICE_VERSION_ENV,
  DATAFORSEO_OPPORTUNITY_REQUIRED_PRICE_VERSION,
  DATAFORSEO_ORGANIC_MAX_DEPTH,
  DATAFORSEO_ORGANIC_USD_PER_SERP,
  createDataForSeoOpportunityAdapter,
  dataForSeoOpportunityEnabled,
  normalizeDataForSeoOpportunityItem,
} from '../adapters/dataforseo/opportunity-source'
import { DATAFORSEO_OPPORTUNITY_FRESHNESS_SEARCH_PARAM } from '../research/opportunity-query-lanes'
import { DATAFORSEO_REQUIRED_RETENTION_DAYS, DATAFORSEO_REQUIRED_TERMS_VERSION } from '../adapters/dataforseo/maps'
import type { SourceSearchPlan } from '../adapters/types'
import { buildSourcePlan } from '../research/plan'
import { ruleBasedFitScorer } from '../research/qualify'

const CLOCK = new Date('2026-08-26T22:00:00.000Z')
const approvedEnv = {
  GTM_DATAFORSEO_ENABLED: 'true',
  GTM_DATAFORSEO_LOGIN: 'login',
  GTM_DATAFORSEO_PASSWORD: 'password',
  GTM_DATAFORSEO_CUSTOMER_USE_APPROVED: 'true',
  GTM_DATAFORSEO_CONSUMER_OPPORTUNITY_USE_APPROVED: 'true',
  GTM_DATAFORSEO_TERMS_VERSION: DATAFORSEO_REQUIRED_TERMS_VERSION,
  GTM_DATAFORSEO_RETENTION_DAYS: String(DATAFORSEO_REQUIRED_RETENTION_DAYS),
  [DATAFORSEO_OPPORTUNITY_PRICE_VERSION_ENV]: DATAFORSEO_OPPORTUNITY_REQUIRED_PRICE_VERSION,
}

const plan: SourceSearchPlan = {
  signal_kind: 'social_engagement',
  entity_unit: 'opportunities',
  geography: 'US',
  query: 'South Bay home buyer and seller communities',
  provider_query: {
    source_search_keywords: ['South Bay home buyer seller discussion events'],
    locations: ['South Bay, California'],
    search_param: DATAFORSEO_OPPORTUNITY_FRESHNESS_SEARCH_PARAM,
  },
  max_candidates: 20,
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    type: 'organic',
    rank_group: 1,
    rank_absolute: 1,
    title: 'South Bay first-time home buyer questions',
    url: 'https://www.reddit.com/r/SouthBayLA/comments/example/buying_a_home/',
    description: 'Local buyers discuss moving to the South Bay and starting a home search.',
    timestamp: '2026-08-25 17:00:00 +00:00',
    ...overrides,
  }
}

function response(items: Record<string, unknown>[], cost = 0.004) {
  return new Response(
    JSON.stringify({
      status_code: 20000,
      status_message: 'Ok.',
      cost,
      tasks: [
        {
          id: 'organic-task-1',
          status_code: 20000,
          status_message: 'Ok.',
          cost,
          result: [{ datetime: CLOCK.toISOString(), items }],
        },
      ],
    }),
    { status: 200 },
  )
}

function applicationResponse(taskStatus: number, taskStatusMessage: string, cost = 0.002) {
  return new Response(
    JSON.stringify({
      status_code: 20000,
      status_message: 'Ok.',
      cost,
      tasks: [
        {
          id: 'organic-task-application-status',
          status_code: taskStatus,
          status_message: taskStatusMessage,
          cost,
          result: null,
        },
      ],
    }),
    { status: 200 },
  )
}

describe('DataForSEO organic demand-opportunity source', () => {
  it('requires a separate consumer-opportunity and exact organic-price approval', () => {
    expect(dataForSeoOpportunityEnabled(approvedEnv)).toBe(true)
    expect(
      dataForSeoOpportunityEnabled({
        ...approvedEnv,
        GTM_DATAFORSEO_CONSUMER_OPPORTUNITY_USE_APPROVED: 'false',
      }),
    ).toBe(false)
    expect(
      dataForSeoOpportunityEnabled({
        ...approvedEnv,
        [DATAFORSEO_OPPORTUNITY_PRICE_VERSION_ENV]: 'stale-price',
      }),
    ).toBe(false)
  })

  it('is consumer-capable, manual-only, metered, and deletion-capable', () => {
    const descriptor = createDataForSeoOpportunityAdapter({
      env: approvedEnv,
    }).descriptor
    expect(descriptor).toMatchObject({
      adapter_id: DATAFORSEO_OPPORTUNITY_ADAPTER_ID,
      constraints: {
        license: {
          status: 'approved',
          audience_modes: ['business', 'consumer'],
          manual_outreach_allowed: true,
          automated_email_allowed: false,
          public_profile_contact_allowed: false,
          public_opportunity_use_allowed: true,
        },
      },
      cost_model: {
        unit: 'organic_serp_10_results',
        pay_on_found: false,
      },
      dsr: { deletion_supported: true },
    })
  })

  it('quotes every ten requested organic results at the frozen live rate', () => {
    const adapter = createDataForSeoOpportunityAdapter({ env: approvedEnv })
    expect(adapter.quote({ ...plan, max_candidates: 1 })).toMatchObject({
      max_candidates: 1,
      provider_units: 1,
    })
    expect(adapter.quote({ ...plan, max_candidates: 25 })).toMatchObject({
      max_candidates: 25,
      provider_units: 3,
    })
    expect(adapter.quote({ ...plan, max_candidates: 100 })).toMatchObject({
      max_candidates: DATAFORSEO_ORGANIC_MAX_DEPTH,
      provider_units: 5,
    })
    expect(DATAFORSEO_ORGANIC_USD_PER_SERP).toBe(0.002)
  })

  it('creates a canonical consumer opportunity plan with the provider cost included', () => {
    const adapter = createDataForSeoOpportunityAdapter({ env: approvedEnv })
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
      [adapter],
      { targetAccepted: 10, maxRawCandidates: 20 },
      2,
    )
    expect(result).toMatchObject({ ok: true, entityKind: 'opportunity' })
    if (!result.ok) throw new Error(result.reason)
    expect(result.adapterPlan).toHaveLength(5)
    expect(result.adapterPlan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ queryLaneId: 'mixed_intent:1' }),
        expect.objectContaining({ queryLaneId: 'mixed_intent:2' }),
        expect.objectContaining({ queryLaneId: 'mixed_intent:3' }),
        expect.objectContaining({ queryLaneId: 'mixed_intent:4' }),
        expect.objectContaining({ queryLaneId: 'mixed_intent:5' }),
      ]),
    )
    expect(result.adapterPlan.every((batch) =>
      batch.adapter_id === DATAFORSEO_OPPORTUNITY_ADAPTER_ID
      && batch.providerUnits === 1
      && batch.billableUnit === 'organic_serp_10_results',
    )).toBe(true)
    expect(result.adapterPlan.reduce((sum, batch) => sum + batch.providerUnits, 0)).toBe(5)
  })

  it.each([
    [
      'buyer thread',
      item(),
      {
        opportunity_kind: 'thread',
        platform: 'Reddit',
        intent_kind: 'buyer_intent',
      },
    ],
    [
      'seller event',
      item({
        title: 'South Bay home seller workshop',
        url: 'https://www.eventbrite.com/e/south-bay-home-seller-workshop-tickets-123',
        description: 'A public workshop for homeowners considering selling a home.',
      }),
      {
        opportunity_kind: 'event',
        platform: 'Eventbrite',
        intent_kind: 'seller_intent',
      },
    ],
    [
      'local community',
      item({
        title: 'South Bay homeowners community',
        url: 'https://community.example.org/groups/south-bay-homeowners',
        description: 'A local community group for South Bay homeowners and housing questions.',
      }),
      {
        opportunity_kind: 'group',
        platform: 'community.example.org',
        intent_kind: 'local_audience',
      },
    ],
    [
      'creator audience',
      item({
        title: 'Moving to the South Bay housing channel',
        url: 'https://www.youtube.com/@movingtosouthbay',
        description: 'Local videos and questions from people moving to the South Bay and buying homes.',
      }),
      {
        opportunity_kind: 'creator_audience',
        platform: 'YouTube',
        intent_kind: 'buyer_intent',
      },
    ],
  ])('normalizes a %s into a public opportunity', (_label, row, expected) => {
    const candidate = normalizeDataForSeoOpportunityItem(row, {
      keyword: 'South Bay buyer and seller opportunities',
      location: 'South Bay,California,United States',
      observedAt: CLOCK.toISOString(),
    })
    expect(candidate).toMatchObject({
      entity_kind: 'opportunity',
      identity: {
        ...expected,
        source_published_at: '2026-08-25T17:00:00.000Z',
      },
    })
    expect(candidate?.identity.recommended_action).toMatch(/manually|decide whether/i)
    expect(candidate?.identity).not.toHaveProperty('email')
  })

  it('drops ordinary articles and sensitive consumer-targeting results', () => {
    const context = {
      keyword: 'South Bay home audiences',
      location: 'South Bay,California,United States',
      observedAt: CLOCK.toISOString(),
    }
    expect(
      normalizeDataForSeoOpportunityItem(
        item({
          title: 'South Bay market report',
          url: 'https://example.org/market-report',
          description: 'A report about local housing prices.',
        }),
        context,
      ),
    ).toBeNull()
    expect(
      normalizeDataForSeoOpportunityItem(
        item({
          title: 'Foreclosure discussion for distressed homeowners',
        }),
        context,
      ),
    ).toBeNull()
    expect(
      normalizeDataForSeoOpportunityItem(
        item({
          title: 'Housing independence after opioid recovery',
          description: 'A sober living discussion involving a predatory landlord.',
        }),
        context,
      ),
    ).toBeNull()
  })

  it('distinguishes event directories from dated events and resolves yearless dates conservatively', () => {
    const context = {
      keyword: 'Austin upcoming homebuyer workshop',
      location: 'Austin,Texas,United States',
      observedAt: '2026-08-27T12:00:00.000Z',
    }
    const directory = normalizeDataForSeoOpportunityItem(
      item({
        title: 'Austin home buyer seminars',
        url: 'https://www.eventbrite.com/d/tx--austin/home-buyer-seminar/',
        description: 'Upcoming local home buyer workshops and community events in Austin.',
      }),
      context,
    )
    expect(directory?.identity).toMatchObject({
      opportunity_kind: 'community',
      access_type: 'public',
      event_start_at: null,
    })

    const upcoming = normalizeDataForSeoOpportunityItem(
      item({
        title: 'Austin first-time home buyer workshop',
        url: 'https://www.eventbrite.com/e/austin-home-buyer-workshop-123',
        description: 'First-time home buyers can register for the workshop on Tue, Sep 1.',
      }),
      context,
    )
    expect(upcoming?.identity).toMatchObject({
      opportunity_kind: 'event',
      access_type: 'ticketed',
      event_start_at: '2026-09-01T12:00:00.000Z',
    })

    const old = normalizeDataForSeoOpportunityItem(
      item({
        title: 'Austin home buyer fair',
        url: 'https://events.example.org/austin-home-buyer-fair',
        description: 'The home buyer fair was held Saturday, June 1.',
      }),
      context,
    )
    expect(old?.identity.event_start_at).toBe('2024-06-01T12:00:00.000Z')
  })

  it('does not turn a requested market into evidence for an identically named city in another state', () => {
    const candidate = normalizeDataForSeoOpportunityItem(
      item({
        title: 'What to consider when buying a first home in Austin, MN?',
        url: 'https://www.reddit.com/r/example/comments/austin-minnesota-home-buying',
        description: 'A first-time home buyer asks for local advice in Austin, MN.',
      }),
      {
        keyword: 'Austin Texas first-time home buyer questions',
        location: 'Austin,Texas,United States',
        observedAt: CLOCK.toISOString(),
      },
    )
    expect(candidate?.identity.location).toBeNull()
    expect(candidate?.identity.provider_location).toBe('Austin,Texas,United States')
  })

  it('retains safe public rows for fit-v7 even when the returned lane or market is unresolved', () => {
    const buyer = item({
      title: 'Austin first-time home buyer workshop',
      url: 'https://events.example.org/austin-home-buyer-workshop',
      description: 'Austin, Texas home buyers can register for this public workshop on Sep 12, 2026.',
    })
    const context = {
      keyword: 'Austin Texas home seller workshop',
      location: 'Austin,Texas,United States',
      observedAt: CLOCK.toISOString(),
    }
    const laneMismatch = normalizeDataForSeoOpportunityItem(buyer, {
      ...context,
      expectedIntent: 'seller_intent',
    })
    expect(laneMismatch).toMatchObject({
      identity: { intent_kind: 'buyer_intent', location: 'Austin,Texas,United States' },
      evidence: [expect.objectContaining({ detail: expect.objectContaining({ requested_intent: 'seller_intent' }) })],
    })
    expect(
      normalizeDataForSeoOpportunityItem(buyer, {
        ...context,
        expectedIntent: 'buyer_intent',
      }),
    ).not.toBeNull()
    const unresolvedMarket = normalizeDataForSeoOpportunityItem(
      item({
        title: 'First-time home buyer workshop',
        url: 'https://events.example.org/home-buyer-workshop',
        description: 'Home buyers can register for this public workshop on Sep 12, 2026.',
      }),
      {
        ...context,
        expectedIntent: 'buyer_intent',
      },
    )
    expect(unresolvedMarket).toMatchObject({ identity: { location: null } })
  })

  it('keeps cross-market public threads for fit-v7 but still rejects non-venue articles', () => {
    const sellerContext = {
      keyword: 'Austin Texas selling my house',
      location: 'Austin,Texas,United States',
      observedAt: '2026-08-27T12:00:00.000Z',
      expectedIntent: 'seller_intent' as const,
    }
    const crossMarket = normalizeDataForSeoOpportunityItem(
      item({
        title: 'Cannot sell Houston house fast enough',
        url: 'https://www.reddit.com/r/houston/comments/example/cannot_sell_house',
        description: 'Austin, Texas? Do not be a desperate seller. I am selling my house in Houston.',
        timestamp: '2026-08-26T12:00:00.000Z',
      }),
      sellerContext,
    )
    expect(crossMarket).toMatchObject({ identity: { location: null, intent_kind: 'seller_intent' } })
    if (!crossMarket) throw new Error('expected a safe public candidate')
    expect(
      ruleBasedFitScorer.score(
        crossMarket,
        {
          entityUnit: 'opportunities',
          geography: 'Austin, Texas',
          audience: 'Austin homeowners considering selling a home',
          signal: 'A current public question demonstrates home-selling intent',
          recencyWindow: '30 days',
          providerQuery: { opportunity_intent_lane: 'seller_intent' },
          referenceTime: sellerContext.observedAt,
        },
        crossMarket.evidence,
      ),
    ).toMatchObject({ verdict: 'rejected' })
    expect(
      normalizeDataForSeoOpportunityItem(
        item({
          title: 'Community council meeting coverage',
          url: 'https://brooklyneagle.com/news/community-council-coverage',
          description: 'A community council discussed housing. A later archive entry mentions Phoenix, Arizona.',
          timestamp: '2026-08-26T12:00:00.000Z',
        }),
        {
          ...sellerContext,
          keyword: 'Phoenix Arizona neighborhood association meeting',
          location: 'Phoenix,Arizona,United States',
          expectedIntent: 'local_audience',
        },
      ),
    ).toBeNull()
  })

  it('preserves safe stale, undated, expired, and approval-only rows for fit-v7 rejection', () => {
    const buyerContext = {
      keyword: 'Austin Texas first-time home buyer',
      location: 'Austin,Texas,United States',
      observedAt: '2026-08-27T12:00:00.000Z',
      expectedIntent: 'buyer_intent' as const,
    }
    const buyerThread = {
      title: 'Austin first-time home buyer question',
      url: 'https://www.reddit.com/r/Austin/comments/example/home_buyer_question',
      description: 'Austin, Texas first-time home buyer asking which neighborhoods to compare.',
    }
    expect(
      normalizeDataForSeoOpportunityItem(item({ ...buyerThread, timestamp: null }), buyerContext),
    ).toMatchObject({ identity: { source_published_at: null } })
    expect(
      normalizeDataForSeoOpportunityItem(
        item({ ...buyerThread, timestamp: '2024-08-26T12:00:00.000Z' }),
        buyerContext,
      ),
    ).toMatchObject({ identity: { source_published_at: '2024-08-26T12:00:00.000Z' } })
    expect(
      normalizeDataForSeoOpportunityItem(
        item({
          title: 'Austin first-time home buyer workshop',
          url: 'https://events.example.org/e/austin-homebuyer-workshop',
          description: 'Austin, Texas home buyers attended this workshop on June 1, 2026.',
          timestamp: null,
        }),
        buyerContext,
      ),
    ).toMatchObject({ identity: { opportunity_kind: 'event' } })
    expect(
      normalizeDataForSeoOpportunityItem(
        item({
          title: 'Austin first-time home buyers group',
          url: 'https://www.facebook.com/groups/austin-first-time-buyers/',
          description: 'Austin, Texas home buyers can request membership in this group.',
          timestamp: '2026-08-26T12:00:00.000Z',
        }),
        buyerContext,
      ),
    ).toMatchObject({ identity: { opportunity_kind: 'group', access_type: 'approval_required' } })
    expect(
      normalizeDataForSeoOpportunityItem(
        item({
          title: 'Hyde Park Neighborhood Association',
          url: 'https://www.austinhydepark.org/community/',
          description: 'Austin, Texas neighborhood association meetings and public community events.',
          timestamp: '2026-08-26T12:00:00.000Z',
        }),
        {
          ...buyerContext,
          expectedIntent: 'local_audience',
        },
      ),
    ).toMatchObject({ identity: { opportunity_kind: 'group', access_type: 'public' } })
    expect(
      normalizeDataForSeoOpportunityItem(
        item({
          title: 'Austin Neighborhood Association Group',
          url: 'https://association.example.org/groups/austin-neighbors',
          description: 'A public Austin, Texas neighborhood association group and meeting calendar.',
          timestamp: '2026-08-26T12:00:00.000Z',
        }),
        {
          ...buyerContext,
          expectedIntent: 'local_audience',
        },
      ),
    ).toMatchObject({ identity: { opportunity_kind: 'group', access_type: 'public' } })
    expect(
      normalizeDataForSeoOpportunityItem(
        item({ ...buyerThread, timestamp: '2026-08-26T12:00:00.000Z' }),
        buyerContext,
      ),
    ).not.toBeNull()
  })

  it.each([
    ['price-multiplying operator', 'site:reddit.com South Bay home buyers', 'unpriced_query_operator'],
    ['cache operator', 'cache:example.org South Bay home buyers', 'unpriced_query_operator'],
    ['definition operator', 'definition:homeowner South Bay', 'unpriced_query_operator'],
    ['sensitive targeting', 'South Bay foreclosure homeowner forum', 'unsafe_consumer_targeting'],
  ])('rejects %s before provider contact', async (_label, query, errorCode) => {
    const fetchImpl = jest.fn() as unknown as typeof fetch
    const adapter = createDataForSeoOpportunityAdapter({
      env: approvedEnv,
      fetchImpl,
    })
    const result = await adapter.search({
      ...plan,
      provider_query: {
        ...plan.provider_query,
        search_query: query,
      },
    })
    expect(result).toMatchObject({ status: 'error', cost_units: 0 })
    expect(result.error).toContain(errorCode)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([null, '', '&tbs=qdr:y', '&tbs=cdr:1,cd_min:01/01/2026,cd_max:08/26/2026'])(
    'rejects a missing or altered freshness parameter before provider contact: %s',
    async (searchParam) => {
      const fetchImpl = jest.fn() as unknown as typeof fetch
      const adapter = createDataForSeoOpportunityAdapter({ env: approvedEnv, fetchImpl })
      const result = await adapter.search({
        ...plan,
        provider_query: {
          ...plan.provider_query,
          search_param: searchParam,
        },
      })

      expect(result).toMatchObject({ status: 'error', cost_units: 0 })
      expect(result.error).toContain('unsupported_freshness_contract')
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )

  it('sends one bounded Live Advanced organic task and settles its exact task cost', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response([
        item(),
        item({
          title: 'South Bay seller workshop',
          url: 'https://www.meetup.com/south-bay-real-estate/events/123',
          description: 'A local workshop for homeowners thinking about selling.',
        }),
      ]),
    ) as unknown as typeof fetch
    const adapter = createDataForSeoOpportunityAdapter({
      env: approvedEnv,
      fetchImpl,
      now: () => CLOCK,
    })
    const result = await adapter.search(plan)
    expect(result).toMatchObject({ status: 'ok', cost_units: 2 })
    expect(result.data).toHaveLength(2)
    expect(result.receipt).toMatchObject({
      provider_request_id: 'organic-task-1',
      root_cost_usd: 0.004,
      task_cost_usd: 0.004,
      items_count: 2,
      raw_item_count: 2,
      returned_count: 2,
      parser_dropped_rows: 0,
    })
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body).toEqual([
      {
        keyword: 'South Bay home buyer seller discussion events',
        location_name: 'South Bay,California,United States',
        language_code: 'en',
        depth: 20,
        search_param: DATAFORSEO_OPPORTUNITY_FRESHNESS_SEARCH_PARAM,
      },
    ])
  })

  it('treats DataForSEO 40102 as a charged no-result using the final task cost', async () => {
    const adapter = createDataForSeoOpportunityAdapter({
      env: approvedEnv,
      fetchImpl: jest.fn().mockResolvedValue(
        applicationResponse(40102, 'No Search Results.'),
      ) as unknown as typeof fetch,
    })

    const result = await adapter.search(plan)

    expect(result).toMatchObject({
      status: 'no_result',
      data: null,
      cost_units: 1,
      receipt: {
        provider_status: 'no_result',
        task_status_code: 40102,
        task_cost_usd: 0.002,
      },
    })
  })

  it('reports raw, retained, and normalization-dropped rows separately', async () => {
    const adapter = createDataForSeoOpportunityAdapter({
      env: approvedEnv,
      fetchImpl: jest.fn().mockResolvedValue(
        response([
          item(),
          item({
            title: 'South Bay real estate market overview',
            url: 'https://example.org/articles/south-bay-market-overview',
            description: 'A general article about the South Bay housing market.',
          }),
        ]),
      ) as unknown as typeof fetch,
      now: () => CLOCK,
    })

    const result = await adapter.search(plan)

    expect(result).toMatchObject({
      status: 'ok',
      data: [expect.objectContaining({ entity_kind: 'opportunity' })],
      receipt: {
        items_count: 1,
        raw_item_count: 2,
        returned_count: 1,
        parser_dropped_rows: 1,
      },
    })
  })

  it('retains the final provider cost on a definitive DataForSEO application error', async () => {
    const adapter = createDataForSeoOpportunityAdapter({
      env: approvedEnv,
      fetchImpl: jest.fn().mockResolvedValue(
        applicationResponse(40101, 'Internal SE Server Error.'),
      ) as unknown as typeof fetch,
    })

    const result = await adapter.search(plan)

    expect(result).toMatchObject({
      status: 'error',
      data: null,
      cost_units: 1,
      receipt: {
        provider_status: 'provider_error_40101',
        task_status_code: 40101,
        task_cost_usd: 0.002,
      },
    })
    expect(result.error).toContain('provider_application_error')
  })

  it('flattens current discussion, perspective, and event blocks with provider publication evidence', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      response([
        {
          type: 'discussions_and_forums',
          rank_group: 2,
          rank_absolute: 2,
          items: [
            {
              type: 'discussions_and_forums_element',
              title: 'Austin first-time home buyer questions',
              url: 'https://www.reddit.com/r/AustinHousing/comments/example/first_home/',
              description: 'Austin residents discuss buying a first home and ask current questions.',
              timestamp: '2026-08-25 16:00:00 +00:00',
              posts_count: 14,
            },
          ],
        },
        {
          type: 'perspectives',
          rank_group: 3,
          rank_absolute: 3,
          items: [
            {
              type: 'perspectives_element',
              title: 'Moving to Austin and looking for a home',
              url: 'https://www.youtube.com/watch?v=public-housing-question',
              description: 'A current public conversation about moving to Austin and buying a home.',
              timestamp: '2026-08-24 09:30:00 +00:00',
            },
          ],
        },
        {
          type: 'events',
          rank_group: 4,
          rank_absolute: 4,
          items: [
            {
              type: 'events_element',
              title: 'Austin first-time home buyer workshop September 12 2026',
              url: 'https://www.google.com/search?q=austin+buyer+workshop',
              description: 'An Austin workshop for people preparing to buy a first home.',
              timestamp: '2026-08-23 10:00:00 +00:00',
            },
            {
              type: 'events_element',
              title: 'Austin first-time home buyer workshop September 12 2026',
              url: 'https://www.meetup.com/austin-home-buyers/events/123',
              description: 'An Austin workshop for people preparing to buy a first home.',
              timestamp: '2026-08-23 10:00:00 +00:00',
            },
          ],
        },
      ]),
    ) as unknown as typeof fetch
    const adapter = createDataForSeoOpportunityAdapter({
      env: approvedEnv,
      fetchImpl,
      now: () => CLOCK,
    })

    const result = await adapter.search({
      ...plan,
      provider_query: {
        ...plan.provider_query,
        search_query: 'Austin home buyer questions community event',
        locations: ['Austin, Texas'],
      },
    })

    expect(result).toMatchObject({ status: 'ok', cost_units: 2 })
    expect(result.data).toHaveLength(3)
    expect(result.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: expect.objectContaining({
            opportunity_kind: 'thread',
            source_published_at: '2026-08-25T16:00:00.000Z',
            engagement_count: 14,
          }),
        }),
        expect.objectContaining({
          identity: expect.objectContaining({
            opportunity_kind: 'post',
            source_published_at: '2026-08-24T09:30:00.000Z',
          }),
        }),
        expect.objectContaining({
          identity: expect.objectContaining({
            opportunity_kind: 'event',
            platform: 'Meetup',
            source_published_at: '2026-08-23T10:00:00.000Z',
          }),
        }),
      ]),
    )
    expect(result.data?.some((candidate) => candidate.identity.urls?.some((url) => url.includes('google.com')))).toBe(false)
  })

  it('retains the charged no-result receipt without inventing an opportunity', async () => {
    const adapter = createDataForSeoOpportunityAdapter({
      env: approvedEnv,
      fetchImpl: jest.fn().mockResolvedValue(response([], 0.004)) as unknown as typeof fetch,
    })
    const result = await adapter.search(plan)
    expect(result).toMatchObject({
      status: 'no_result',
      cost_units: 2,
      data: null,
    })
  })

  it('parks an authoritative charge above the reservation for operator reconciliation', async () => {
    const adapter = createDataForSeoOpportunityAdapter({
      env: approvedEnv,
      fetchImpl: jest.fn().mockResolvedValue(response([item()], 0.006)) as unknown as typeof fetch,
    })
    const result = await adapter.search({ ...plan, max_candidates: 10 })
    expect(result).toMatchObject({ status: 'ambiguous', cost_units: null })
    expect(result.error).toContain('billing_mismatch')
  })

  it('parks transport failures because provider contact may have occurred', async () => {
    const adapter = createDataForSeoOpportunityAdapter({
      env: approvedEnv,
      fetchImpl: jest.fn().mockRejectedValue(new TypeError('connection reset')) as unknown as typeof fetch,
    })
    const result = await adapter.search(plan)
    expect(result).toMatchObject({ status: 'ambiguous', cost_units: null })
  })
})
