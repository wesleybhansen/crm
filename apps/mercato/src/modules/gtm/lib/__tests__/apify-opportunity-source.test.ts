import type { ApifyRunOutcome } from '../adapters/apify/client'
import {
  APIFY_OPPORTUNITY_SOURCE_ACTOR_BUILD,
  APIFY_OPPORTUNITY_SOURCE_ACTOR_ENV,
  APIFY_OPPORTUNITY_SOURCE_ACTOR_ID,
  APIFY_OPPORTUNITY_SOURCE_ADAPTER_ID,
  APIFY_OPPORTUNITY_SOURCE_DATASET_FIELDS,
  APIFY_OPPORTUNITY_SOURCE_EVENT_PRICES_USD,
  APIFY_OPPORTUNITY_SOURCE_PRICE_VERSION_ENV,
  APIFY_OPPORTUNITY_SOURCE_REQUIRED_PRICE_VERSION,
  APIFY_OPPORTUNITY_SOURCE_SIGNAL,
  apifyOpportunitySourceApproved,
  apifyOpportunitySourceDescriptor,
  buildApifyOpportunityInput,
  createApifyOpportunitySourceAdapter,
  normalizeApifyOpportunityItem,
} from '../adapters/apify/opportunity-source'
import { APIFY_REQUIRED_PRICE_VERSION, APIFY_REQUIRED_TERMS_VERSION } from '../adapters/apify/source'
import type { SourceSearchPlan } from '../adapters/types'
import { buildSourcePlan } from '../research/plan'

const CLOCK = new Date('2026-08-26T20:00:00.000Z')
const now = () => CLOCK

const ENABLED_ENV = {
  GTM_APIFY_ENABLED: 'true',
  GTM_APIFY_TOKEN: 'synthetic-opportunity-token',
  GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
  GTM_APIFY_TERMS_VERSION: APIFY_REQUIRED_TERMS_VERSION,
  GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
  [APIFY_OPPORTUNITY_SOURCE_PRICE_VERSION_ENV]: APIFY_OPPORTUNITY_SOURCE_REQUIRED_PRICE_VERSION,
}

const PLAN: SourceSearchPlan = {
  signal_kind: APIFY_OPPORTUNITY_SOURCE_SIGNAL,
  entity_unit: 'opportunities',
  geography: 'US',
  query: 'South Bay homeowners considering selling seller intent',
  provider_query: {
    search_query: 'selling a home South Bay',
    recency_window: 'last 30 days',
  },
  max_candidates: 5,
  max_charge_usd: 0.0101,
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    type: 'post',
    id: '7486634839639523328',
    linkedinUrl: 'https://www.linkedin.com/posts/jamie-example_selling-home-south-bay-activity-7486634839639523328',
    content: 'Thinking about selling our South Bay home this fall. What should we fix first?',
    author: {
      name: 'Jamie Example',
      info: 'South Bay homeowner',
      linkedinUrl: 'https://www.linkedin.com/in/jamie-example',
    },
    postedAt: { date: '2026-08-25T18:30:00.000Z' },
    engagement: { likes: 12, comments: 8, shares: 1 },
    ...overrides,
  }
}

function outcome(values: Partial<ApifyRunOutcome> = {}): ApifyRunOutcome {
  return {
    kind: 'ok',
    status: 'ok',
    items: [post()],
    actorId: APIFY_OPPORTUNITY_SOURCE_ACTOR_ID,
    runId: 'synthetic-run-id',
    itemCount: 1,
    httpStatus: 201,
    retryAfterSeconds: null,
    bodySnippet: null,
    requestUrl: 'https://api.apify.com/v2/acts/harvestapi~linkedin-post-search/runs?token=[redacted]',
    attemptedAt: CLOCK.toISOString(),
    error: null,
    billingFinalized: true,
    chargedEventCounts: { 'apify-actor-start': 1, post: 1 },
    providerCostUsd:
      APIFY_OPPORTUNITY_SOURCE_EVENT_PRICES_USD['apify-actor-start'] + APIFY_OPPORTUNITY_SOURCE_EVENT_PRICES_USD.post,
    pricingModel: 'PAY_PER_EVENT',
    ...values,
  }
}

describe('Apify demand-opportunity source contract', () => {
  it('is an exact-version, consumer-manual source that cannot automate outreach', () => {
    expect(apifyOpportunitySourceApproved(ENABLED_ENV)).toBe(true)
    expect(
      apifyOpportunitySourceApproved({
        ...ENABLED_ENV,
        [APIFY_OPPORTUNITY_SOURCE_PRICE_VERSION_ENV]: 'another-price',
      }),
    ).toBe(false)

    const descriptor = apifyOpportunitySourceDescriptor(ENABLED_ENV)
    expect(descriptor.adapter_id).toBe(APIFY_OPPORTUNITY_SOURCE_ADAPTER_ID)
    expect(descriptor.capabilities).toEqual([
      {
        signal_kind: 'social_engagement',
        entity_units: ['opportunities'],
        geographies: ['US'],
        channels: [],
      },
    ])
    expect(descriptor.constraints.license).toMatchObject({
      status: 'approved',
      audience_modes: ['business', 'consumer'],
      manual_outreach_allowed: true,
      automated_email_allowed: false,
      public_profile_contact_allowed: true,
    })
    expect(descriptor.dsr.deletion_supported).toBe(true)
  })

  it('builds a bounded post-only query with comments and reactions off', () => {
    expect(buildApifyOpportunityInput(PLAN)).toEqual({
      searchQueries: ['selling a home South Bay'],
      maxPosts: 5,
      postedLimit: 'month',
      sortBy: 'relevance',
      profileScraperMode: 'short',
      startPage: 1,
      scrapeReactions: false,
      postNestedReactions: false,
      scrapeComments: false,
      postNestedComments: false,
    })
  })

  it('normalizes a public seller discussion into an opportunity, not a recipient', () => {
    const candidate = normalizeApifyOpportunityItem(post(), {
      attemptedAt: CLOCK.toISOString(),
      query: PLAN.query,
    })
    expect(candidate).toMatchObject({
      entity_kind: 'opportunity',
      identity: {
        opportunity_kind: 'post',
        platform: 'LinkedIn',
        intent_kind: 'seller_intent',
        engagement_count: 21,
        activity_level: 'medium',
        access_type: 'public',
        people_to_follow: [
          {
            name: 'Jamie Example',
            role: 'South Bay homeowner',
            profile_url: 'https://www.linkedin.com/in/jamie-example',
          },
        ],
      },
      evidence: [
        {
          source_url:
            'https://www.linkedin.com/posts/jamie-example_selling-home-south-bay-activity-7486634839639523328',
          observed_at: '2026-08-25T18:30:00.000Z',
        },
      ],
    })
    expect(candidate?.identity.recommended_action).toContain('contribute a useful response')
    expect(candidate?.identity.recommended_action).not.toMatch(/send|email|message/i)
  })

  it('classifies buyer and mixed demand without inferring a private contact method', () => {
    const buyer = normalizeApifyOpportunityItem(
      post({
        content: 'First-time buyer moving to Manhattan Beach. How should I start a home search?',
      }),
      {
        attemptedAt: CLOCK.toISOString(),
        query: 'first-time home buyers Manhattan Beach',
      },
    )
    expect(buyer?.identity.intent_kind).toBe('buyer_intent')
    expect(buyer?.identity).not.toHaveProperty('email')

    const mixed = normalizeApifyOpportunityItem(
      post({
        content: 'Should we sell our current home before buying the next one?',
      }),
      {
        attemptedAt: CLOCK.toISOString(),
        query: 'local home move',
      },
    )
    expect(mixed?.identity.intent_kind).toBe('mixed_intent')
  })

  it('does not turn a seller-oriented search query into seller evidence', () => {
    const content = 'South Bay neighborhood community breakfast for local residents.'
    const sellerQuery = normalizeApifyOpportunityItem(post({ content }), {
      attemptedAt: CLOCK.toISOString(),
      query: 'homeowners preparing to sell a home',
    })
    const buyerQuery = normalizeApifyOpportunityItem(post({ content }), {
      attemptedAt: CLOCK.toISOString(),
      query: 'first-time buyers looking for a home',
    })
    expect(sellerQuery?.identity.intent_kind).toBe('local_audience')
    expect(buyerQuery?.identity.intent_kind).toBe('local_audience')
  })

  it('drops non-public and non-LinkedIn rows instead of storing weak evidence', () => {
    expect(
      normalizeApifyOpportunityItem(
        post({
          linkedinUrl: 'https://evil.example/posts/1',
        }),
        { attemptedAt: CLOCK.toISOString(), query: PLAN.query },
      ),
    ).toBeNull()
    expect(
      normalizeApifyOpportunityItem(
        post({
          type: 'comment',
        }),
        { attemptedAt: CLOCK.toISOString(), query: PLAN.query },
      ),
    ).toBeNull()
  })

  it('quotes the provider minimum and then exact start-plus-post event cost', () => {
    const adapter = createApifyOpportunitySourceAdapter({
      env: ENABLED_ENV,
      now,
    })
    const one = adapter.quote({ ...PLAN, max_candidates: 1 })
    expect(one.provider_units).toBe(10)
    expect(one.max_candidates).toBe(1)

    const ten = adapter.quote({ ...PLAN, max_candidates: 10 })
    expect(ten.provider_units).toBeCloseTo(20.05, 10)
    expect(ten.billable_unit).toBe('apify_millidollar')
  })

  it('creates a consumer opportunity research plan with canonical metering', () => {
    const adapter = createApifyOpportunitySourceAdapter({
      env: ENABLED_ENV,
      now,
    })
    const plan = buildSourcePlan(
      {
        marketType: 'b2c',
        geography: 'California, US',
        signalKind: 'social_engagement',
        entityUnit: 'opportunities',
        audience: 'South Bay homeowners considering selling',
        signal: 'social_engagement',
        providerQuery: { search_query: 'selling a home South Bay' },
      },
      [adapter],
      { targetAccepted: 5, maxRawCandidates: 5 },
      2,
    )
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.entityKind).toBe('opportunity')
      expect(plan.adapterPlan).toHaveLength(3)
      expect(plan.adapterPlan.reduce((sum, batch) => sum + batch.maxCandidates, 0)).toBe(5)
      expect(plan.adapterPlan.every((batch) => batch.adapter_id === APIFY_OPPORTUNITY_SOURCE_ADAPTER_ID)).toBe(true)
      expect(plan.adapterPlan.every((batch) => batch.billableUnit === 'apify_millidollar')).toBe(true)
      expect(plan.adapterPlan.every((batch) => batch.providerUnits === 10)).toBe(true)
      expect(plan.adapterPlan.map((batch) => batch.queryLaneId)).toEqual([
        'seller_intent:1',
        'seller_intent:2',
        'seller_intent:3',
      ])
    }
  })

  it('runs the immutable actor build, settles actual events, and returns bounded opportunities', async () => {
    const runActor = jest.fn(async () => outcome())
    const adapter = createApifyOpportunitySourceAdapter({
      env: ENABLED_ENV,
      now,
      runActor,
    })
    const result = await adapter.search(PLAN)
    expect(result.status).toBe('ok')
    expect(result.data).toHaveLength(1)
    expect(result.data?.[0].entity_kind).toBe('opportunity')
    expect(result.cost_units).toBeCloseTo(2.05, 10)
    expect(result.receipt).toMatchObject({
      actor_id: APIFY_OPPORTUNITY_SOURCE_ACTOR_ID,
      actor_build: APIFY_OPPORTUNITY_SOURCE_ACTOR_BUILD,
      billing_finalized: true,
      charged_event_counts: { 'apify-actor-start': 1, post: 1 },
      comments_scraped: false,
      reactions_scraped: false,
    })
    expect(runActor).toHaveBeenCalledWith(
      APIFY_OPPORTUNITY_SOURCE_ACTOR_ID,
      expect.objectContaining({
        scrapeComments: false,
        scrapeReactions: false,
      }),
      expect.objectContaining({
        build: APIFY_OPPORTUNITY_SOURCE_ACTOR_BUILD,
        maxChargeUsd: PLAN.max_charge_usd,
        datasetFields: [...APIFY_OPPORTUNITY_SOURCE_DATASET_FIELDS],
      }),
    )
  })

  it('charges a finalized zero-result event without inventing an opportunity', async () => {
    const providerCostUsd =
      APIFY_OPPORTUNITY_SOURCE_EVENT_PRICES_USD['apify-actor-start'] +
      APIFY_OPPORTUNITY_SOURCE_EVENT_PRICES_USD['no-result']
    const adapter = createApifyOpportunitySourceAdapter({
      env: ENABLED_ENV,
      now,
      runActor: async () =>
        outcome({
          kind: 'no_result',
          status: 'no_result',
          items: [],
          itemCount: 0,
          chargedEventCounts: { 'apify-actor-start': 1, 'no-result': 1 },
          providerCostUsd,
        }),
    })
    const result = await adapter.search(PLAN)
    expect(result.status).toBe('no_result')
    expect(result.data).toBeNull()
    expect(result.cost_units).toBeCloseTo(1.05, 10)
  })

  it('parks billing or output drift instead of refunding a charged provider run', async () => {
    const mismatched = createApifyOpportunitySourceAdapter({
      env: ENABLED_ENV,
      now,
      runActor: async () =>
        outcome({
          chargedEventCounts: { 'apify-actor-start': 1, post: 2 },
        }),
    })
    await expect(mismatched.search(PLAN)).resolves.toMatchObject({
      status: 'ambiguous',
      cost_units: null,
      error: expect.stringContaining('billed post count'),
    })

    const unsafeRow = createApifyOpportunitySourceAdapter({
      env: ENABLED_ENV,
      now,
      runActor: async () =>
        outcome({
          items: [post({ linkedinUrl: 'javascript:alert(1)' })],
        }),
    })
    await expect(unsafeRow.search(PLAN)).resolves.toMatchObject({
      status: 'ambiguous',
      cost_units: null,
      error: expect.stringContaining('no safe public opportunity'),
    })
  })

  it('fails closed before a provider call when gates, capability, or actor drift', async () => {
    const calls = jest.fn(async () => outcome())
    const disabled = createApifyOpportunitySourceAdapter({
      env: { ...ENABLED_ENV, GTM_APIFY_ENABLED: 'false' },
      now,
      runActor: calls,
    })
    await expect(disabled.search(PLAN)).resolves.toMatchObject({
      status: 'error',
    })

    const wrongUnit = createApifyOpportunitySourceAdapter({
      env: ENABLED_ENV,
      now,
      runActor: calls,
    })
    await expect(wrongUnit.search({ ...PLAN, entity_unit: 'people' })).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('unsupported_capability'),
    })

    const drifted = createApifyOpportunitySourceAdapter({
      env: {
        ...ENABLED_ENV,
        [APIFY_OPPORTUNITY_SOURCE_ACTOR_ENV]: 'someone/another-actor',
      },
      now,
      runActor: calls,
    })
    await expect(drifted.search(PLAN)).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('actor override'),
    })
    expect(calls).not.toHaveBeenCalled()
  })
})
