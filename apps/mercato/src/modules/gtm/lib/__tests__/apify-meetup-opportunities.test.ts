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
    query_lane_version: 'opportunity-query-v57',
    source_query_lane_id: 'local_audience:1',
    opportunity_intent_lane: 'local_audience',
    search_query: 'first time home buyer',
    source_search_keywords: ['first time home buyer'],
    meetup_contract_version: 'public-events-v2',
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
    eventId: 'event-123',
    eventName: 'Austin First-Time Homebuyer Workshop',
    eventDescription: 'A public community workshop about preparing to buy a first home in Austin.',
    eventType: 'PHYSICAL',
    eventUrl: 'https://www.meetup.com/austin-homeownership/events/123456789/',
    eventStatus: 'ACTIVE',
    isOnline: false,
    startDateTime: '2026-09-05T17:00:00.000Z',
    endDateTime: '2026-09-05T19:00:00.000Z',
    createdTime: '2026-08-20T12:00:00.000Z',
    actualAttendees: 18,
    isPaidEvent: false,
    feeRequired: false,
    venue: {
      name: 'Austin Central Library',
      city: 'Austin',
      state: 'TX',
      country: 'US',
      postalCode: '78701',
    },
    group: {
      name: 'Austin Homeownership Community',
      memberCount: 2_400,
      organizerName: 'Alex Organizer',
      organizerProfileUrl: 'https://www.meetup.com/members/123456/',
    },
    hosts: [
      {
        name: 'Jordan Host',
        memberUrl: 'https://www.meetup.com/members/789012/',
      },
    ],
    topics: [{ id: '1', name: 'Homeownership', urlkey: 'homeownership' }],
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
    requestUrl: 'https://api.apify.com/v2/acts/filip_cicvarek~meetup-scraper/runs?token=[redacted]',
    attemptedAt: CLOCK.toISOString(),
    error: null,
    billingFinalized: true,
    chargedEventCounts: { 'apify-default-dataset-item': 1 },
    providerCostUsd: 0.0008,
    pricingModel: 'PAY_PER_EVENT',
    ...overrides,
  }
}

describe('Apify Meetup public event opportunities', () => {
  it('pins the established actor and exact Starter/Bronze pay-per-event contract', () => {
    expect(APIFY_MEETUP_OPPORTUNITY_CONFIG).toMatchObject({
      actorId: 'filip_cicvarek/meetup-scraper',
      actorBuild: '3.0.14',
      requiredPriceVersion:
        'filip-cicvarek-meetup-scraper-3.0.14-bronze-events-2026-08-30',
      eventPricesUsd: { 'apify-default-dataset-item': 0.0008 },
      oneTimeEvent: null,
      oneTimeQuoteUsd: 0,
      perItemQuoteUsd: 0.0008,
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
    expect(lanes.every((lane) => lane.providerQuery.query_lane_version === 'opportunity-query-v57')).toBe(true)
    expect(lanes.every((lane) => lane.providerQuery.meetup_location === 'Austin, Texas')).toBe(true)
    expect(lanes.every((lane) =>
      lane.providerQuery.meetup_contract_version === 'public-events-v2'
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
        mode: 'events',
        searchKeyword: 'first time home buyer',
        city: 'Austin',
        state: 'Texas',
        country: 'us',
        eventType: 'PHYSICAL',
        radius: 25,
        startDateRange: '2026-08-26T23:00:00.000Z',
        endDateRange: '2026-09-25T23:00:00.000Z',
        minRsvpCount: 1,
        sortBy: 'RELEVANCE',
        maxResults: 10,
      },
      expect.objectContaining({
        build: '3.0.14',
        maxChargeUsd: 0.01,
        maxItems: 10,
      }),
    )
    expect(result).toMatchObject({
      status: 'ok',
      cost_units: 0.8,
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
            member_count: 2_400,
            engagement_count: 18,
            people_to_follow: [
              { name: 'Alex Organizer' },
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
        charged_event_counts: { 'apify-default-dataset-item': 1 },
        provider_cost_usd: 0.0008,
      }),
    })
  })

  it.each([
    ['wrong market', { venue: { city: 'Dallas', state: 'TX', country: 'US' } }],
    ['online', { eventType: 'ONLINE', isOnline: true }],
    ['cancelled', { eventStatus: 'CANCELLED' }],
    ['expired', { startDateTime: '2026-08-20T17:00:00.000Z' }],
    ['too far away', { startDateTime: '2026-10-05T17:00:00.000Z' }],
    ['off platform', { eventUrl: 'https://example.com/events/123' }],
    ['sensitive', { eventDescription: 'A foreclosure distress targeting workshop.' }],
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
      chargedEventCounts: { 'apify-default-dataset-item': 2 },
      providerCostUsd: 0.0016,
    }))
    const mismatch = await createApifyMeetupOpportunityAdapter({
      env: approvedEnv(),
      now,
      runActor: mismatchedRun,
    }).search(plan)
    expect(mismatch).toMatchObject({ status: 'ambiguous', cost_units: null })

    const unknownRun = jest.fn(async () => outcome(meetupEvent(), {
      chargedEventCounts: { 'apify-default-dataset-item': 1, 'unknown-event': 1 },
      providerCostUsd: 0.0018,
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
        eventId: 'event-generic',
        eventName: 'Austin Friday Social Mixer',
        eventDescription: 'Meet local professionals for food and networking.',
        eventUrl: 'https://www.meetup.com/austin-social/events/223456789/',
        group: { name: 'Austin Social Club', memberCount: 4_000 },
        topics: [{ id: '2', name: 'Social Networking' }],
      }),
      meetupEvent({
        eventId: 'event-investor',
        eventName: 'Real Estate Investing',
        eventDescription: 'An event about wholesaling and flipping investment property.',
        eventUrl: 'https://www.meetup.com/austin-investors/events/323456789/',
        group: { name: 'Austin Real Estate Investors', memberCount: 3_000 },
        topics: [{ id: '3', name: 'Real Estate Investing' }],
      }),
    ]
    const runActor = jest.fn(async () => outcome(rows[0]!, {
      items: rows,
      itemCount: rows.length,
      chargedEventCounts: { 'apify-default-dataset-item': rows.length },
      providerCostUsd: 0.0024,
    }))
    const result = await createApifyMeetupOpportunityAdapter({ env: approvedEnv(), now, runActor })
      .search(plan)

    expect(result).toMatchObject({
      status: 'partial',
      cost_units: 2.4,
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
      eventName: 'Austin Neighborhood Karaoke',
      eventDescription: 'A public community social event with music and food.',
      eventUrl: 'https://www.meetup.com/austin-social/events/423456789/',
      group: { name: 'Austin Community Social Club', memberCount: 4_000 },
      topics: [{ id: '4', name: 'Karaoke' }],
    })
    const runActor = jest.fn(async () => outcome(generic))
    const result = await createApifyMeetupOpportunityAdapter({ env: approvedEnv(), now, runActor })
      .search(plan)

    expect(result).toMatchObject({
      status: 'no_result',
      data: null,
      cost_units: 0.8,
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
