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
import { DATAFORSEO_REQUIRED_RETENTION_DAYS, DATAFORSEO_REQUIRED_TERMS_VERSION } from '../adapters/dataforseo/maps'
import type { SourceSearchPlan } from '../adapters/types'
import { buildSourcePlan } from '../research/plan'

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
    expect(result).toMatchObject({
      ok: true,
      entityKind: 'opportunity',
      adapterPlan: [
        {
          adapter_id: DATAFORSEO_OPPORTUNITY_ADAPTER_ID,
          providerUnits: 2,
          billableUnit: 'organic_serp_10_results',
        },
      ],
    })
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
      identity: expected,
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
  })

  it.each([
    ['price-multiplying operator', 'site:reddit.com South Bay home buyers', 'unpriced_query_operator'],
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
        search_query: query,
        locations: ['South Bay, California'],
      },
    })
    expect(result).toMatchObject({ status: 'error', cost_units: 0 })
    expect(result.error).toContain(errorCode)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

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
    })
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body).toEqual([
      {
        keyword: 'South Bay home buyer seller discussion events',
        location_name: 'South Bay,California,United States',
        language_code: 'en',
        depth: 20,
      },
    ])
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
