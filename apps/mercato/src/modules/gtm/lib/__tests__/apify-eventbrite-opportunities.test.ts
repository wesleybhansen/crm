import type { ApifyRunOutcome } from '../adapters/apify/client'
import {
  APIFY_EVENTBRITE_OPPORTUNITY_CONFIG,
  createApifyEventbriteOpportunityAdapter,
  normalizeEventbriteOpportunity,
  publicSocialOpportunityApproved,
  publicSocialOpportunityEnabled,
} from '../adapters/apify/public-social-opportunity-source'
import { APIFY_REQUIRED_PRICE_VERSION, APIFY_REQUIRED_TERMS_VERSION } from '../adapters/apify/source'
import type { SourceSearchPlan } from '../adapters/types'
import {
  buildOpportunityQueryLanes,
  opportunitySourceRouting,
} from '../research/opportunity-query-lanes'

const CLOCK = new Date('2026-08-31T16:00:00.000Z')
const now = () => CLOCK

function approvedEnv(overrides: Record<string, string> = {}) {
  return {
    GTM_APIFY_ENABLED: 'true',
    GTM_APIFY_ACCOUNT_TIER: 'BRONZE',
    GTM_APIFY_TOKEN: 'synthetic-eventbrite-token',
    GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
    GTM_APIFY_TERMS_VERSION: APIFY_REQUIRED_TERMS_VERSION,
    GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
    GTM_APIFY_EVENTBRITE_OPPORTUNITY_ENABLED: 'true',
    GTM_APIFY_EVENTBRITE_OPPORTUNITY_USE_APPROVED: 'true',
    GTM_APIFY_EVENTBRITE_SEARCH_PRICE_VERSION:
      APIFY_EVENTBRITE_OPPORTUNITY_CONFIG.requiredPriceVersion,
    ...overrides,
  }
}

const plan: SourceSearchPlan = {
  signal_kind: 'social_engagement',
  entity_unit: 'opportunities',
  geography: 'US',
  query: 'first time home buyer',
  provider_query: {
    query_lane_version: 'opportunity-query-v94',
    source_query_lane_id: 'buyer_intent:1',
    opportunity_intent_lane: 'buyer_intent',
    search_query: 'first time home buyer',
    source_search_keywords: ['first time home buyer'],
    eventbrite_contract_version: 'public-events-v1',
    eventbrite_location: 'Austin, Texas',
    eventbrite_window_days: 30,
    eventbrite_fetch_details: true,
    eventbrite_max_pages: 3,
    eventbrite_returned_content_filter_version: 'realtor-public-event-v2',
    eventbrite_filter_required_intent: 'buyer_intent',
  },
  max_candidates: 25,
  max_charge_usd: 0.045,
}

function eventbriteEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: '123456789',
    name: 'Austin First-Time Home Buyer Workshop',
    summary: 'A public home buying class about preparing to buy a first home in Austin.',
    url: 'https://www.eventbrite.com/e/austin-first-time-home-buyer-workshop-tickets-123456789',
    start_date: '2026-09-05',
    start_time: '10:00 AM',
    end_date: '2026-09-05',
    end_time: '12:00 PM',
    timezone: 'America/Chicago',
    is_online_event: false,
    venue_name: 'Austin Central Library',
    venue_address: '710 W Cesar Chavez St',
    venue_city: 'Austin',
    venue_region: 'Texas',
    venue_postal_code: '78701',
    organizer_name: 'Austin Homeownership Center',
    organizer_url: 'https://www.eventbrite.com/o/austin-homeownership-center-123456',
    organizer_id: '123456',
    price_min: 0,
    price_max: 0,
    price_currency: 'USD',
    is_free: true,
    ticket_availability: 'InStock',
    categories: ['Home & Lifestyle'],
    subcategories: ['Real Estate'],
    formats: ['Class, Training, or Workshop'],
    keywords: ['homebuyer', 'homeownership'],
    ...overrides,
  }
}

function outcome(
  items: Record<string, unknown>[] = [eventbriteEvent()],
  overrides: Partial<ApifyRunOutcome> = {},
): ApifyRunOutcome {
  return {
    kind: 'ok',
    status: 'ok',
    items,
    actorId: APIFY_EVENTBRITE_OPPORTUNITY_CONFIG.actorId,
    runId: 'synthetic-eventbrite-run',
    itemCount: items.length,
    httpStatus: 201,
    retryAfterSeconds: null,
    bodySnippet: null,
    requestUrl: 'https://api.apify.com/v2/acts/scrapersdelight~eventbrite-scraper/runs?token=[redacted]',
    attemptedAt: CLOCK.toISOString(),
    error: null,
    billingFinalized: true,
    chargedEventCounts: { 'event-scraped': items.length },
    providerCostUsd: 0.0045 * items.length,
    pricingModel: 'PAY_PER_EVENT',
    ...overrides,
  }
}

describe('Apify Eventbrite public event opportunities', () => {
  it('pins the paid actor and exact Starter/Bronze pay-per-event contract', () => {
    expect(APIFY_EVENTBRITE_OPPORTUNITY_CONFIG).toMatchObject({
      actorId: 'scrapersdelight/eventbrite-scraper',
      actorBuild: '0.1.6',
      requiredPriceVersion:
        'scrapersdelight-eventbrite-scraper-0.1.6-bronze-events-2026-08-31',
      eventPricesUsd: { 'event-scraped': 0.0045 },
      oneTimeEvent: null,
      oneTimeQuoteUsd: 0,
      perItemQuoteUsd: 0.0045,
      maxBatch: 10,
    })
  })

  it('fails closed unless every capability, terms, actor, and price gate matches', () => {
    const env = approvedEnv()
    expect(publicSocialOpportunityApproved(APIFY_EVENTBRITE_OPPORTUNITY_CONFIG, env)).toBe(true)
    expect(publicSocialOpportunityEnabled(APIFY_EVENTBRITE_OPPORTUNITY_CONFIG, env)).toBe(true)
    expect(publicSocialOpportunityEnabled(APIFY_EVENTBRITE_OPPORTUNITY_CONFIG, {
      ...env,
      GTM_APIFY_EVENTBRITE_OPPORTUNITY_ENABLED: 'false',
    })).toBe(false)
    expect(publicSocialOpportunityApproved(APIFY_EVENTBRITE_OPPORTUNITY_CONFIG, {
      ...env,
      GTM_APIFY_EVENTBRITE_SEARCH_PRICE_VERSION: 'stale',
    })).toBe(false)
    expect(publicSocialOpportunityApproved(APIFY_EVENTBRITE_OPPORTUNITY_CONFIG, {
      ...env,
      GTM_APIFY_ACTOR_EVENTBRITE_SEARCH: 'another/actor',
    })).toBe(false)
  })

  it.each([
    ['buyer_intent', ['first time homebuyer seminar', 'homebuyer education workshop', 'path to homeownership']],
    ['seller_intent', ['home seller seminar', 'preparing your home to sell', 'home valuation workshop']],
    ['local_audience', ['homeownership education', 'homeowner workshop', 'neighborhood home tour']],
  ] as const)('creates three separately quoted realtor %s lanes', (intent, expectedQueries) => {
    const play = {
      audience: 'Austin home buyers, sellers, and homeowners',
      signal: 'People gathering at current public housing events',
      geography: 'Austin, Texas',
      providerQuery: { opportunity_intent_lane: intent },
    }
    expect(opportunitySourceRouting(play, APIFY_EVENTBRITE_OPPORTUNITY_CONFIG.adapterId)).toEqual({
      eligible: true,
      reason: null,
    })
    const lanes = buildOpportunityQueryLanes(play, APIFY_EVENTBRITE_OPPORTUNITY_CONFIG.adapterId)
    expect(lanes).toHaveLength(3)
    expect(lanes.map((lane) => lane.query)).toEqual(expectedQueries)
    expect(lanes.every((lane) =>
      lane.providerQuery.query_lane_version === 'opportunity-query-v94'
      && lane.providerQuery.eventbrite_location === 'Austin, Texas'
      && lane.providerQuery.eventbrite_contract_version === 'public-events-v1'
      && lane.providerQuery.eventbrite_returned_content_filter_version === 'realtor-public-event-v2'
      && lane.providerQuery.eventbrite_filter_required_intent === intent
    )).toBe(true)
  })

  it('does not route generic non-realtor events through the initial contract', () => {
    expect(opportunitySourceRouting({
      audience: 'Austin live-music fans',
      signal: 'People gathering at current public concerts',
      geography: 'Austin, Texas',
      providerQuery: { opportunity_intent_lane: 'local_audience' },
    }, APIFY_EVENTBRITE_OPPORTUNITY_CONFIG.adapterId).eligible).toBe(false)
  })

  it('caps the quote and actor input at ten and reconciles the finalized event receipt', async () => {
    const runActor = jest.fn(async () => outcome())
    const adapter = createApifyEventbriteOpportunityAdapter({ env: approvedEnv(), now, runActor })
    expect(adapter.descriptor.constraints.max_batch).toBe(10)
    expect(adapter.quote(plan)).toMatchObject({ max_candidates: 10, provider_units: 45 })

    const result = await adapter.search(plan)
    expect(runActor).toHaveBeenCalledWith(
      APIFY_EVENTBRITE_OPPORTUNITY_CONFIG.actorId,
      {
        location: 'Austin, Texas',
        keyword: 'first time home buyer',
        startDate: '2026-08-31',
        endDate: '2026-09-30',
        maxResults: 10,
        maxPages: 3,
        fetchDetails: true,
      },
      expect.objectContaining({
        build: '0.1.6',
        maxChargeUsd: 0.045,
        maxItems: 10,
      }),
    )
    expect(result).toMatchObject({
      status: 'ok',
      cost_units: 4.5,
      data: [{
        entity_kind: 'opportunity',
        identity: {
          name: 'Austin First-Time Home Buyer Workshop',
          opportunity_kind: 'event',
          platform: 'Eventbrite',
          location: 'Austin, Texas',
          access_type: 'public',
          event_start_at: '2026-09-05T10:00:00.000Z',
          people_to_follow: [{ name: 'Austin Homeownership Center' }],
        },
        evidence: [expect.objectContaining({
          source_url: 'https://www.eventbrite.com/e/austin-first-time-home-buyer-workshop-tickets-123456789',
          detail: expect.objectContaining({
            provider_event_id: '123456789',
            requested_location: 'Austin, Texas',
            ticket_availability: 'instock',
          }),
        })],
      }],
      receipt: expect.objectContaining({
        charged_event_counts: { 'event-scraped': 1 },
        provider_cost_usd: 0.0045,
        billed_results: 1,
      }),
    })
  })

  it.each([
    ['wrong market', { venue_city: 'Dallas' }],
    ['online', { is_online_event: true }],
    ['sold out', { ticket_availability: 'SoldOut' }],
    ['expired', { start_date: '2026-08-20' }],
    ['too far away', { start_date: '2026-10-05' }],
    ['off platform', { url: 'https://example.com/events/123' }],
    ['sensitive', { summary: 'A foreclosure distress targeting workshop.' }],
  ])('drops %s event rows before fit-v7', (_label, overrides) => {
    expect(normalizeEventbriteOpportunity(eventbriteEvent(overrides), {
      query: 'first time home buyer',
      location: 'Austin, Texas',
      expectedIntent: 'buyer_intent',
      attemptedAt: CLOCK.toISOString(),
      actorId: APIFY_EVENTBRITE_OPPORTUNITY_CONFIG.actorId,
    })).toBeNull()
  })

  it('filters returned generic events without using the buyer-oriented search query as evidence', async () => {
    const rows = [
      eventbriteEvent(),
      eventbriteEvent({
        event_id: '987654321',
        name: 'Austin Friday Night Karaoke',
        summary: 'A public community social event with music, food, and dancing.',
        url: 'https://www.eventbrite.com/e/austin-friday-night-karaoke-tickets-987654321',
        categories: ['Music'],
        subcategories: ['Karaoke'],
        keywords: ['nightlife'],
      }),
      eventbriteEvent({
        event_id: '1982542022558',
        name: 'Indy Realtor Connect Series',
        summary: 'A monthly event where realtors and lenders build community, boost brand visibility, showcase expertise, and connect with prospective clients.',
        url: 'https://www.eventbrite.com/e/indy-realtor-connect-series-tickets-1982542022558',
        organizer_name: 'Member Experience Manager',
        categories: ['Business & Professional'],
        subcategories: ['Real Estate'],
        formats: ['Meeting or Networking Event'],
        keywords: ['homeownership', 'firsttimehomebuyer', 'realestatenetworking'],
      }),
      eventbriteEvent({
        event_id: '1996451581423',
        name: 'Why Buy Now | Austin',
        summary: 'An exclusive afternoon built for real estate agents to stay ahead, gain insights, connect with peers, and better serve clients. Agents in attendance receive a bonus commission voucher.',
        url: 'https://www.eventbrite.com/e/why-buy-now-austin-tickets-1996451581423',
        organizer_name: 'DHI Mortgage',
        categories: ['Business & Professional'],
        subcategories: ['Real Estate'],
        formats: ['Seminar or Talk'],
        keywords: ['mortgage', 'realestate', 'whybuynow'],
      }),
    ]
    const runActor = jest.fn(async () => outcome(rows))
    const result = await createApifyEventbriteOpportunityAdapter({ env: approvedEnv(), now, runActor })
      .search(plan)
    expect(result.cost_units).toBeCloseTo(18)
    expect(result).toMatchObject({
      status: 'partial',
      data: [{ identity: { name: 'Austin First-Time Home Buyer Workshop' } }],
      receipt: expect.objectContaining({
        returned_content_filter_version: 'realtor-public-event-v2',
        returned_content_filtered_rows: 3,
        returned_count: 1,
        billed_results: 4,
      }),
    })
  })

  it('parks billed-count mismatches and unknown event charges as ambiguous', async () => {
    const mismatch = await createApifyEventbriteOpportunityAdapter({
      env: approvedEnv(),
      now,
      runActor: jest.fn(async () => outcome(undefined, {
        chargedEventCounts: { 'event-scraped': 2 },
        providerCostUsd: 0.009,
      })),
    }).search(plan)
    expect(mismatch).toMatchObject({ status: 'ambiguous', cost_units: null })

    const unknown = await createApifyEventbriteOpportunityAdapter({
      env: approvedEnv(),
      now,
      runActor: jest.fn(async () => outcome(undefined, {
        chargedEventCounts: { 'event-scraped': 1, 'unknown-event': 1 },
        providerCostUsd: 0.005,
      })),
    }).search(plan)
    expect(unknown).toMatchObject({ status: 'ambiguous', cost_units: null })
  })

  it('rejects contract drift before invoking Apify', async () => {
    const runActor = jest.fn(async () => outcome())
    const result = await createApifyEventbriteOpportunityAdapter({ env: approvedEnv(), now, runActor })
      .search({
        ...plan,
        provider_query: { ...plan.provider_query, eventbrite_window_days: 60 },
      })
    expect(result).toMatchObject({ status: 'error', cost_units: 0 })
    expect(result.error).toContain('does not match the frozen public-events contract')
    expect(runActor).not.toHaveBeenCalled()
  })
})
