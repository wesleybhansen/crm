import type { ApifyRunOutcome } from '../adapters/apify/client'
import {
  APIFY_MEETUP_OPPORTUNITY_CONFIG,
  createApifyMeetupOpportunityAdapter,
  normalizeMeetupOpportunity,
  publicSocialOpportunityApproved,
  publicSocialOpportunityEnabled,
} from '../adapters/apify/public-social-opportunity-source'
import { APIFY_REQUIRED_PRICE_VERSION, APIFY_REQUIRED_TERMS_VERSION } from '../adapters/apify/source'
import type { SourceSearchPlan } from '../adapters/types'
import {
  buildOpportunityQueryLanes,
  opportunitySourceRouting,
} from '../research/opportunity-query-lanes'

const CLOCK = new Date('2026-08-26T23:00:00.000Z')
const now = () => CLOCK

function approvedEnv(overrides: Record<string, string> = {}) {
  return {
    GTM_APIFY_ENABLED: 'true',
    GTM_APIFY_ACCOUNT_TIER: 'BRONZE',
    GTM_APIFY_TOKEN: 'synthetic-meetup-token',
    GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
    GTM_APIFY_TERMS_VERSION: APIFY_REQUIRED_TERMS_VERSION,
    GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
    GTM_APIFY_MEETUP_OPPORTUNITY_ENABLED: 'true',
    GTM_APIFY_MEETUP_OPPORTUNITY_USE_APPROVED: 'true',
    GTM_APIFY_MEETUP_SEARCH_PRICE_VERSION:
      APIFY_MEETUP_OPPORTUNITY_CONFIG.requiredPriceVersion,
    ...overrides,
  }
}

const plan: SourceSearchPlan = {
  signal_kind: 'social_engagement',
  entity_unit: 'opportunities',
  geography: 'US',
  query: 'first time home buyer',
  provider_query: {
    query_lane_version: 'opportunity-query-v95',
    source_query_lane_id: 'local_audience:1',
    opportunity_intent_lane: 'local_audience',
    search_query: 'first time home buyer',
    source_search_keywords: ['first time home buyer'],
    meetup_contract_version: 'public-events-v3',
    meetup_location: 'Austin, Texas',
    meetup_event_type: 'PHYSICAL',
    meetup_country: 'us',
    meetup_radius_miles: 25,
    meetup_window_days: 30,
    meetup_min_rsvp_count: 1,
    meetup_sort: 'RELEVANCE',
    meetup_returned_content_filter_version: 'realtor-housing-event-v1',
  },
  max_candidates: 25,
  max_charge_usd: 0.01,
}

function meetupEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-123',
    title: 'Austin First-Time Homebuyer Workshop',
    description: 'A public community workshop about preparing to buy a first home in Austin.',
    eventType: 'PHYSICAL',
    eventUrl: 'https://www.meetup.com/austin-homeownership/events/123456789/',
    isOnline: false,
    dateTime: '2026-09-05T17:00:00.000Z',
    endTime: '2026-09-05T19:00:00.000Z',
    rsvpCount: 18,
    rsvpState: 'JOIN_OPEN',
    venueName: 'Austin Central Library',
    venueAddress: '710 W Cesar Chavez St',
    venueCity: 'Austin',
    venueState: 'TX',
    venueCountry: 'us',
    groupId: 'group-123',
    groupName: 'Austin Homeownership Community',
    groupUrl: 'https://www.meetup.com/austin-homeownership/',
    groupRatingAverage: 4.8,
    groupRatingCount: 32,
    hostName: 'Jordan Host',
    hostMemberId: '789012',
    searchKeyword: 'first time home buyer',
    searchLocation: 'Austin, Texas, United States',
    scraped_at: CLOCK.toISOString(),
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
    actorId: APIFY_MEETUP_OPPORTUNITY_CONFIG.actorId,
    runId: 'synthetic-meetup-run',
    itemCount: 1,
    httpStatus: 201,
    retryAfterSeconds: null,
    bodySnippet: null,
    requestUrl: 'https://api.apify.com/v2/acts/scrapersdelight~meetup-scraper/runs?token=[redacted]',
    attemptedAt: CLOCK.toISOString(),
    error: null,
    billingFinalized: true,
    chargedEventCounts: { 'event-scraped': 1 },
    providerCostUsd: 0.0009,
    pricingModel: 'PAY_PER_EVENT',
    ...overrides,
  }
}

describe('Apify Meetup public event opportunities', () => {
  it('pins the established actor and exact Starter/Bronze pay-per-event contract', () => {
    expect(APIFY_MEETUP_OPPORTUNITY_CONFIG).toMatchObject({
      actorId: 'scrapersdelight/meetup-scraper',
      actorBuild: '0.1.4',
      requiredPriceVersion:
        'scrapersdelight-meetup-scraper-0.1.4-event-scraped-2026-09-01',
      eventPricesUsd: { 'event-scraped': 0.0009 },
      oneTimeEvent: null,
      oneTimeQuoteUsd: 0,
      perItemQuoteUsd: 0.0009,
      maxBatch: 10,
    })
  })

  it('fails closed unless every capability, terms, actor, and price gate matches', () => {
    const env = approvedEnv()
    expect(publicSocialOpportunityApproved(APIFY_MEETUP_OPPORTUNITY_CONFIG, env)).toBe(true)
    expect(publicSocialOpportunityEnabled(APIFY_MEETUP_OPPORTUNITY_CONFIG, env)).toBe(true)
    expect(
      publicSocialOpportunityEnabled(APIFY_MEETUP_OPPORTUNITY_CONFIG, {
        ...env,
        GTM_APIFY_MEETUP_OPPORTUNITY_ENABLED: 'false',
      }),
    ).toBe(false)
    expect(
      publicSocialOpportunityApproved(APIFY_MEETUP_OPPORTUNITY_CONFIG, {
        ...env,
        GTM_APIFY_MEETUP_SEARCH_PRICE_VERSION: 'stale',
      }),
    ).toBe(false)
    expect(
      publicSocialOpportunityApproved(APIFY_MEETUP_OPPORTUNITY_CONFIG, {
        ...env,
        GTM_APIFY_ACTOR_MEETUP_SEARCH: 'another/actor',
      }),
    ).toBe(false)
  })

  it('routes only local-audience plays and creates three separately quoted realtor lanes', () => {
    const localPlay = {
      audience: 'Austin first-time home buyers and homeowners',
      signal: 'People gathering at current public housing events',
      geography: 'Austin, Texas',
      providerQuery: { opportunity_intent_lane: 'local_audience' },
    }
    expect(opportunitySourceRouting(localPlay, APIFY_MEETUP_OPPORTUNITY_CONFIG.adapterId)).toEqual({
      eligible: true,
      reason: null,
    })
    const lanes = buildOpportunityQueryLanes(localPlay, APIFY_MEETUP_OPPORTUNITY_CONFIG.adapterId)
    expect(lanes).toHaveLength(3)
    expect(lanes.map((lane) => lane.query)).toEqual([
      'first time homebuyer workshop',
      'home buying seminar',
      'homeownership education',
    ])
    expect(lanes.every((lane) => lane.providerQuery.query_lane_version === 'opportunity-query-v95')).toBe(true)
    expect(lanes.every((lane) => lane.providerQuery.meetup_location === 'Austin, Texas')).toBe(true)
    expect(lanes.every((lane) =>
      lane.providerQuery.meetup_contract_version === 'public-events-v3'
      && lane.providerQuery.meetup_sort === 'RELEVANCE'
      && lane.providerQuery.meetup_returned_content_filter_version === 'realtor-housing-event-v1'
    )).toBe(true)
    expect(
      opportunitySourceRouting(
        {
          audience: 'Austin residents looking for local live music',
          signal: 'People gathering at current public concerts',
          geography: 'Austin, Texas',
          providerQuery: { opportunity_intent_lane: 'local_audience' },
        },
        APIFY_MEETUP_OPPORTUNITY_CONFIG.adapterId,
      ).eligible,
    ).toBe(false)
    expect(
      opportunitySourceRouting(
        { ...localPlay, providerQuery: { opportunity_intent_lane: 'seller_intent' } },
        APIFY_MEETUP_OPPORTUNITY_CONFIG.adapterId,
      ).eligible,
    ).toBe(false)
  })

  it('caps the quote and actor input at ten and meters the finalized event receipt', async () => {
    const runActor = jest.fn(async () => outcome(meetupEvent()))
    const adapter = createApifyMeetupOpportunityAdapter({ env: approvedEnv(), now, runActor })
    expect(adapter.descriptor.constraints.max_batch).toBe(10)
    expect(adapter.quote(plan)).toMatchObject({ max_candidates: 10, provider_units: 10 })

    const result = await adapter.search(plan)
    expect(runActor).toHaveBeenCalledWith(
      APIFY_MEETUP_OPPORTUNITY_CONFIG.actorId,
      {
        keyword: 'first time home buyer',
        location: 'Austin, Texas',
        eventType: 'PHYSICAL',
        radiusMiles: 25,
        startDate: '2026-08-26',
        endDate: '2026-09-25',
        minRsvpCount: 1,
        sort: 'RELEVANCE',
        maxResults: 10,
      },
      expect.objectContaining({
        build: '0.1.4',
        maxChargeUsd: 0.01,
        maxItems: 10,
      }),
    )
    expect(result).toMatchObject({
      status: 'ok',
      cost_units: 0.9,
      data: [
        {
          entity_kind: 'opportunity',
          identity: {
            name: 'Austin First-Time Homebuyer Workshop',
            opportunity_kind: 'event',
            platform: 'Meetup',
            location: 'Austin, Texas',
            access_type: 'public',
            event_start_at: '2026-09-05T17:00:00.000Z',
            member_count: null,
            engagement_count: 18,
            people_to_follow: [
              { name: 'Jordan Host' },
            ],
          },
          evidence: [
            expect.objectContaining({
              source_url: 'https://www.meetup.com/austin-homeownership/events/123456789/',
              detail: expect.objectContaining({
                provider_event_id: 'event-123',
                requested_location: 'Austin, Texas',
              }),
            }),
          ],
        },
      ],
      receipt: expect.objectContaining({
        charged_event_counts: { 'event-scraped': 1 },
        provider_cost_usd: 0.0009,
      }),
    })
  })

  it.each([
    ['wrong market', { venueCity: 'Dallas' }],
    ['online', { eventType: 'ONLINE', isOnline: true }],
    ['cancelled', { rsvpState: 'CANCELLED' }],
    ['expired', { dateTime: '2026-08-20T17:00:00.000Z' }],
    ['too far away', { dateTime: '2026-10-05T17:00:00.000Z' }],
    ['off platform', { eventUrl: 'https://example.com/events/123' }],
    ['sensitive', { description: 'A foreclosure distress targeting workshop.' }],
  ])('drops %s event rows before fit-v7', (_label, overrides) => {
    expect(
      normalizeMeetupOpportunity(meetupEvent(overrides), {
        query: 'first time home buyer',
        location: 'Austin, Texas',
        expectedIntent: 'local_audience',
        attemptedAt: CLOCK.toISOString(),
        actorId: APIFY_MEETUP_OPPORTUNITY_CONFIG.actorId,
      }),
    ).toBeNull()
  })

  it('parks billed-count mismatches and unknown event charges as ambiguous', async () => {
    const mismatchedRun = jest.fn(async () => outcome(meetupEvent(), {
      chargedEventCounts: { 'event-scraped': 2 },
      providerCostUsd: 0.0018,
    }))
    const mismatch = await createApifyMeetupOpportunityAdapter({
      env: approvedEnv(),
      now,
      runActor: mismatchedRun,
    }).search(plan)
    expect(mismatch).toMatchObject({ status: 'ambiguous', cost_units: null })

    const unknownRun = jest.fn(async () => outcome(meetupEvent(), {
      chargedEventCounts: { 'event-scraped': 1, 'unknown-event': 1 },
      providerCostUsd: 0.0019,
    }))
    const unknown = await createApifyMeetupOpportunityAdapter({
      env: approvedEnv(),
      now,
      runActor: unknownRun,
    }).search(plan)
    expect(unknown).toMatchObject({ status: 'ambiguous', cost_units: null })
  })

  it('does not invoke the actor when operational approval is absent', async () => {
    const runActor = jest.fn(async () => outcome(meetupEvent()))
    const result = await createApifyMeetupOpportunityAdapter({
      env: approvedEnv({ GTM_APIFY_MEETUP_OPPORTUNITY_USE_APPROVED: 'false' }),
      now,
      runActor,
    }).search(plan)
    expect(result).toMatchObject({ status: 'error', cost_units: 0 })
    expect(runActor).not.toHaveBeenCalled()
  })

  it('filters generic and investor events using only returned content while preserving finalized cost', async () => {
    const rows = [
      meetupEvent(),
      meetupEvent({
        id: 'event-generic',
        title: 'Austin Friday Social Mixer',
        description: 'Meet local professionals for food and networking.',
        eventUrl: 'https://www.meetup.com/austin-social/events/223456789/',
        groupName: 'Austin Social Club',
      }),
      meetupEvent({
        id: 'event-investor',
        title: 'Real Estate Investing',
        description: 'An event about wholesaling and flipping investment property.',
        eventUrl: 'https://www.meetup.com/austin-investors/events/323456789/',
        groupName: 'Austin Real Estate Investors',
      }),
    ]
    const runActor = jest.fn(async () => outcome(rows[0]!, {
      items: rows,
      itemCount: rows.length,
      chargedEventCounts: { 'event-scraped': rows.length },
      providerCostUsd: 0.0027,
    }))
    const result = await createApifyMeetupOpportunityAdapter({ env: approvedEnv(), now, runActor })
      .search(plan)

    expect(result).toMatchObject({
      status: 'partial',
      cost_units: 2.7,
      data: [{ identity: { name: 'Austin First-Time Homebuyer Workshop' } }],
      receipt: expect.objectContaining({
        returned_content_filter_version: 'realtor-housing-event-v1',
        returned_content_filtered_rows: 2,
        returned_count: 1,
        billed_results: 3,
      }),
    })
  })

  it('returns a metered no-result when every safe row fails returned-content relevance', async () => {
    const generic = meetupEvent({
      title: 'Austin Neighborhood Karaoke',
      description: 'A public community social event with music and food.',
      eventUrl: 'https://www.meetup.com/austin-social/events/423456789/',
      groupName: 'Austin Community Social Club',
    })
    const runActor = jest.fn(async () => outcome(generic))
    const result = await createApifyMeetupOpportunityAdapter({ env: approvedEnv(), now, runActor })
      .search(plan)

    expect(result).toMatchObject({
      status: 'no_result',
      data: null,
      cost_units: 0.9,
      error: 'no_result_after_returned_content_filter',
      receipt: expect.objectContaining({
        returned_content_filter_version: 'realtor-housing-event-v1',
        returned_content_filtered_rows: 1,
      }),
    })
  })

  it('rejects an unknown returned-content filter contract before invoking Apify', async () => {
    const runActor = jest.fn(async () => outcome(meetupEvent()))
    const result = await createApifyMeetupOpportunityAdapter({ env: approvedEnv(), now, runActor })
      .search({
        ...plan,
        provider_query: {
          ...plan.provider_query,
          meetup_returned_content_filter_version: 'query-implies-relevance',
        },
      })

    expect(result).toMatchObject({ status: 'error', cost_units: 0 })
    expect(result.error).toContain('unsupported Meetup returned-content filter version')
    expect(runActor).not.toHaveBeenCalled()
  })

  it('rejects any drift from the frozen public-event input contract before invoking Apify', async () => {
    const runActor = jest.fn(async () => outcome(meetupEvent()))
    const adapter = createApifyMeetupOpportunityAdapter({ env: approvedEnv(), now, runActor })
    const result = await adapter.search({
      ...plan,
      provider_query: { ...plan.provider_query, meetup_window_days: 60 },
    })
    expect(result).toMatchObject({ status: 'error', cost_units: 0 })
    expect(result.error).toContain('does not match the frozen public-events contract')
    expect(runActor).not.toHaveBeenCalled()
  })
})
