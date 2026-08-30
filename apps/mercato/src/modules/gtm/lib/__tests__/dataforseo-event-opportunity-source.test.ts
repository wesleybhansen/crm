import {
  DATAFORSEO_EVENTS_DATE_RANGE,
  DATAFORSEO_EVENTS_ENABLED_ENV,
  DATAFORSEO_EVENTS_MAX_DEPTH,
  DATAFORSEO_EVENTS_OPPORTUNITY_ADAPTER_ID,
  DATAFORSEO_EVENTS_PRICE_VERSION_ENV,
  DATAFORSEO_EVENTS_REQUIRED_PRICE_VERSION,
  DATAFORSEO_EVENTS_USD_PER_SERP,
  createDataForSeoEventsOpportunityAdapter,
  dataForSeoEventsOpportunityEnabled,
  normalizeDataForSeoEventOpportunity,
} from '../adapters/dataforseo/event-opportunity-source'
import {
  DATAFORSEO_LIVE_TIMEOUT_MS,
  DATAFORSEO_REQUIRED_RETENTION_DAYS,
  DATAFORSEO_REQUIRED_TERMS_VERSION,
} from '../adapters/dataforseo/maps'
import type { SourceSearchPlan } from '../adapters/types'
import { ruleBasedFitScorer } from '../research/qualify'
import { buildSourcePlan } from '../research/plan'

const CLOCK = new Date('2026-08-30T12:00:00.000Z')
const approvedEnv = {
  GTM_DATAFORSEO_ENABLED: 'true',
  GTM_DATAFORSEO_LOGIN: 'login',
  GTM_DATAFORSEO_PASSWORD: 'password',
  GTM_DATAFORSEO_CUSTOMER_USE_APPROVED: 'true',
  GTM_DATAFORSEO_CONSUMER_OPPORTUNITY_USE_APPROVED: 'true',
  GTM_DATAFORSEO_TERMS_VERSION: DATAFORSEO_REQUIRED_TERMS_VERSION,
  GTM_DATAFORSEO_RETENTION_DAYS: String(DATAFORSEO_REQUIRED_RETENTION_DAYS),
  [DATAFORSEO_EVENTS_ENABLED_ENV]: 'true',
  [DATAFORSEO_EVENTS_PRICE_VERSION_ENV]: DATAFORSEO_EVENTS_REQUIRED_PRICE_VERSION,
}

const plan: SourceSearchPlan = {
  signal_kind: 'social_engagement',
  entity_unit: 'opportunities',
  geography: 'US',
  query: 'first time home buyer workshop',
  provider_query: {
    search_query: 'first time home buyer workshop',
    locations: ['Austin, Texas'],
    opportunity_intent_lane: 'buyer_intent',
    date_range: DATAFORSEO_EVENTS_DATE_RANGE,
  },
  max_candidates: 10,
}

function eventItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'event_item',
    rank_group: 1,
    rank_absolute: 1,
    title: 'Austin first-time home buyer workshop',
    description: 'A practical workshop for first-time home buyers in Austin, Texas.',
    url: 'https://events.example.org/austin-first-time-home-buyer-workshop',
    event_dates: {
      start_datetime: '2026-09-12 10:00:00 -05:00',
      end_datetime: '2026-09-12 12:00:00 -05:00',
      displayed_dates: 'Sat, Sep 12, 10 AM–12 PM',
    },
    location_info: {
      name: 'Austin Housing Education Center',
      address: '100 Congress Ave, Austin, TX',
      url: 'https://events.example.org/venues/austin-housing-education-center',
    },
    information_and_tickets: [
      {
        title: 'Register',
        description: 'Reserve a workshop ticket.',
        url: 'https://events.example.org/austin-first-time-home-buyer-workshop/register',
      },
    ],
    ...overrides,
  }
}

function providerResponse(items: Record<string, unknown>[], cost = 0.002): Response {
  return new Response(JSON.stringify({
    status_code: 20000,
    status_message: 'Ok.',
    cost,
    tasks: [{
      id: 'events-task-1',
      status_code: 20000,
      status_message: 'Ok.',
      cost,
      result: [{ datetime: CLOCK.toISOString(), items }],
    }],
  }), { status: 200 })
}

describe('DataForSEO Google Events demand-opportunity source', () => {
  it('requires its own enable flag and exact events rate card', () => {
    expect(dataForSeoEventsOpportunityEnabled(approvedEnv)).toBe(true)
    expect(dataForSeoEventsOpportunityEnabled({
      ...approvedEnv,
      [DATAFORSEO_EVENTS_ENABLED_ENV]: 'false',
    })).toBe(false)
    expect(dataForSeoEventsOpportunityEnabled({
      ...approvedEnv,
      [DATAFORSEO_EVENTS_PRICE_VERSION_ENV]: 'stale',
    })).toBe(false)
  })

  it('is consumer-capable, manual-only, metered, and deletion-capable', () => {
    expect(createDataForSeoEventsOpportunityAdapter({ env: approvedEnv }).descriptor).toMatchObject({
      adapter_id: DATAFORSEO_EVENTS_OPPORTUNITY_ADAPTER_ID,
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
      cost_model: { unit: 'google_events_serp_10_results', pay_on_found: false },
      dsr: { deletion_supported: true },
    })
  })

  it('quotes every ten requested event results at the frozen live rate', () => {
    const adapter = createDataForSeoEventsOpportunityAdapter({ env: approvedEnv })
    expect(adapter.quote({ ...plan, max_candidates: 1 })).toMatchObject({ max_candidates: 1, provider_units: 1 })
    expect(adapter.quote({ ...plan, max_candidates: 25 })).toMatchObject({ max_candidates: 25, provider_units: 3 })
    expect(adapter.quote({ ...plan, max_candidates: 100 })).toMatchObject({
      max_candidates: DATAFORSEO_EVENTS_MAX_DEPTH,
      provider_units: 3,
    })
    expect(DATAFORSEO_EVENTS_USD_PER_SERP).toBe(0.002)
    expect(DATAFORSEO_LIVE_TIMEOUT_MS).toBe(120_000)
  })

  it('creates three separately quoted source-native event lanes', () => {
    const adapter = createDataForSeoEventsOpportunityAdapter({ env: approvedEnv })
    const result = buildSourcePlan({
      marketType: 'b2c',
      geography: 'Austin, Texas',
      signalKind: 'social_engagement',
      entityUnit: 'opportunities',
      audience: 'Austin first-time home buyers',
      signal: 'A current public workshop demonstrates home-buying interest',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
    }, [adapter], { targetAccepted: 3, maxRawCandidates: 9 }, 2)
    expect(result).toMatchObject({ ok: true, entityKind: 'opportunity' })
    if (!result.ok) throw new Error(result.reason)
    expect(result.adapterPlan).toHaveLength(3)
    expect(result.adapterPlan.map((batch) => ({
      adapter: batch.adapter_id,
      lane: batch.queryLaneId,
      query: batch.providerQuery?.search_query,
      dateRange: batch.providerQuery?.date_range,
      units: batch.providerUnits,
    }))).toEqual([
      {
        adapter: DATAFORSEO_EVENTS_OPPORTUNITY_ADAPTER_ID,
        lane: 'buyer_intent:1',
        query: 'first time home buyer workshop',
        dateRange: DATAFORSEO_EVENTS_DATE_RANGE,
        units: 1,
      },
      {
        adapter: DATAFORSEO_EVENTS_OPPORTUNITY_ADAPTER_ID,
        lane: 'buyer_intent:2',
        query: 'home buyer seminar',
        dateRange: DATAFORSEO_EVENTS_DATE_RANGE,
        units: 1,
      },
      {
        adapter: DATAFORSEO_EVENTS_OPPORTUNITY_ADAPTER_ID,
        lane: 'buyer_intent:3',
        query: 'homeownership class',
        dateRange: DATAFORSEO_EVENTS_DATE_RANGE,
        units: 1,
      },
    ])
  })

  it('normalizes a current, local realtor event without inferring participation rights', () => {
    const candidate = normalizeDataForSeoEventOpportunity(eventItem(), {
      keyword: 'first time home buyer workshop',
      location: 'Austin,Texas,United States',
      observedAt: CLOCK.toISOString(),
      expectedIntent: 'buyer_intent',
    })
    expect(candidate).toMatchObject({
      entity_kind: 'opportunity',
      identity: {
        opportunity_kind: 'event',
        intent_kind: 'buyer_intent',
        location: 'Austin,Texas,United States',
        platform: 'events.example.org',
        access_type: 'ticketed',
        event_start_at: '2026-09-12T15:00:00.000Z',
        participation_rules_status: 'unverified',
      },
      evidence: [expect.objectContaining({
        source_url: 'https://events.example.org/austin-first-time-home-buyer-workshop',
        detail: expect.objectContaining({ provider: 'dataforseo-google-events' }),
      })],
    })
    if (!candidate) throw new Error('expected current event')
    expect(ruleBasedFitScorer.score(candidate, {
      entityUnit: 'opportunities',
      geography: 'Austin, Texas',
      audience: 'Austin first-time home buyers',
      signal: 'A current public workshop demonstrates home-buying interest',
      recencyWindow: '30 days',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      referenceTime: CLOCK,
    }, candidate.evidence)).toMatchObject({ verdict: 'review' })
  })

  it('rejects expired, wrong-market, irrelevant, and sensitive events', () => {
    const context = {
      keyword: 'first time home buyer workshop',
      location: 'Austin,Texas,United States',
      observedAt: CLOCK.toISOString(),
      expectedIntent: 'buyer_intent' as const,
    }
    expect(normalizeDataForSeoEventOpportunity(eventItem({
      event_dates: { start_datetime: '2026-08-01 10:00:00 -05:00' },
    }), context)).toBeNull()
    expect(normalizeDataForSeoEventOpportunity(eventItem({
      location_info: { name: 'Denver Center', address: 'Denver, CO' },
      description: 'A first-time home buyer workshop in Denver, Colorado.',
    }), context)).toBeNull()
    expect(normalizeDataForSeoEventOpportunity(eventItem({
      title: 'Austin software engineering conference',
      description: 'A technical conference in Austin, Texas.',
    }), context)).toBeNull()
    expect(normalizeDataForSeoEventOpportunity(eventItem({
      title: 'Austin foreclosure investor workshop',
      description: 'Target homeowners in foreclosure in Austin, Texas.',
    }), context)).toBeNull()
  })

  it('sends one bounded task and settles the provider-reported cost', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(providerResponse([eventItem()])) as unknown as typeof fetch
    const timeout = jest.spyOn(AbortSignal, 'timeout')
    const result = await createDataForSeoEventsOpportunityAdapter({
      env: approvedEnv,
      fetchImpl,
      now: () => CLOCK,
    }).search(plan)
    expect(result).toMatchObject({
      status: 'ok',
      cost_units: 1,
      data: [expect.objectContaining({ entity_kind: 'opportunity' })],
      receipt: {
        provider_request_id: 'events-task-1',
        task_cost_usd: 0.002,
        raw_item_count: 1,
        returned_count: 1,
        parser_dropped_rows: 0,
      },
    })
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual([{
      keyword: 'first time home buyer workshop',
      location_name: 'Austin,Texas,United States',
      language_code: 'en',
      depth: 10,
      date_range: DATAFORSEO_EVENTS_DATE_RANGE,
    }])
    expect(timeout).toHaveBeenCalledWith(DATAFORSEO_LIVE_TIMEOUT_MS)
    timeout.mockRestore()
  })

  it('rejects an altered date window before contacting the provider', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch
    const result = await createDataForSeoEventsOpportunityAdapter({ env: approvedEnv, fetchImpl }).search({
      ...plan,
      provider_query: { ...plan.provider_query, date_range: 'next_month' },
    })
    expect(result).toMatchObject({ status: 'error', cost_units: 0 })
    expect(result.error).toContain('unsupported_date_range')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('parks unreadable responses and provider spend beyond the reservation', async () => {
    const unreadable = await createDataForSeoEventsOpportunityAdapter({
      env: approvedEnv,
      fetchImpl: jest.fn().mockResolvedValue(new Response('not json', { status: 200 })) as unknown as typeof fetch,
    }).search(plan)
    expect(unreadable).toMatchObject({ status: 'ambiguous', cost_units: null })

    const overBudget = await createDataForSeoEventsOpportunityAdapter({
      env: approvedEnv,
      fetchImpl: jest.fn().mockResolvedValue(providerResponse([eventItem()], 0.004)) as unknown as typeof fetch,
    }).search(plan)
    expect(overBudget).toMatchObject({
      status: 'ambiguous',
      cost_units: null,
      receipt: { provider_status: 'billing_over_reservation' },
    })
  })
})
