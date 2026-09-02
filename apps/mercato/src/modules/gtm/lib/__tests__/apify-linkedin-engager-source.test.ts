import type { ApifyRunOutcome } from '../adapters/apify/client'
import {
  APIFY_LINKEDIN_ENGAGER_ACTOR_BUILD,
  APIFY_LINKEDIN_ENGAGER_ACTOR_ID,
  APIFY_LINKEDIN_ENGAGER_ADAPTER_ID,
  APIFY_LINKEDIN_ENGAGER_DATASET_FIELDS,
  APIFY_LINKEDIN_ENGAGER_ENABLED_ENV,
  APIFY_LINKEDIN_ENGAGER_EVENT_PRICES_USD,
  APIFY_LINKEDIN_ENGAGER_PRICE_VERSION_ENV,
  APIFY_LINKEDIN_ENGAGER_REQUIRED_PRICE_VERSION,
  LINKEDIN_ENGAGER_QUERY_CONTRACT_VERSION,
  apifyLinkedInEngagerApproved,
  apifyLinkedInEngagerDescriptor,
  apifyLinkedInEngagerEnabled,
  buildApifyLinkedInEngagerInput,
  createApifyLinkedInEngagerAdapter,
} from '../adapters/apify/engager-source'
import { APIFY_REQUIRED_PRICE_VERSION, APIFY_REQUIRED_TERMS_VERSION } from '../adapters/apify/source'
import type { SourceSearchPlan } from '../adapters/types'
import { buildSourcePlan } from '../research/plan'

const CLOCK = new Date('2026-09-01T18:00:00.000Z')
const now = () => CLOCK

const ENABLED_ENV = {
  GTM_APIFY_ENABLED: 'true',
  GTM_APIFY_ACCOUNT_TIER: 'BRONZE',
  GTM_APIFY_TOKEN: 'synthetic-engager-token',
  GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
  GTM_APIFY_TERMS_VERSION: APIFY_REQUIRED_TERMS_VERSION,
  GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
  [APIFY_LINKEDIN_ENGAGER_PRICE_VERSION_ENV]: APIFY_LINKEDIN_ENGAGER_REQUIRED_PRICE_VERSION,
}

const PLAN: SourceSearchPlan = {
  signal_kind: 'social_engagement',
  entity_unit: 'people',
  geography: 'US',
  query: 'Austin homeowners asking about selling a home',
  provider_query: {
    recency_window: 'last 30 days',
    linkedin_engagement_query_contract_version: LINKEDIN_ENGAGER_QUERY_CONTRACT_VERSION,
    search_query: '("AI in real estate" OR "AI for real estate agents" OR "real estate AI") NOT (proptech OR "commercial real estate")',
    engagement_topics: ['AI in real estate', 'AI for real estate agents', 'real estate AI'],
  },
  max_candidates: 5,
  max_charge_usd: 0.02,
}

const POST_URL = 'https://www.linkedin.com/posts/example_selling-home-austin-activity-7486634839639523328'
const PROFILE_URL = 'https://www.linkedin.com/in/jamie-example'

function comment() {
  return {
    id: '7331154096848097280',
    linkedinUrl: `${POST_URL}?commentUrn=7331154096848097280`,
    commentary: 'We are considering selling our Austin home this year. What should we prepare first?',
    actor: {
      id: 'ACoAAExample',
      name: 'Jamie Example',
      linkedinUrl: PROFILE_URL,
      position: 'Austin homeowner',
    },
  }
}

function items(): unknown[] {
  return [
    {
      type: 'post',
      id: '7486634839639523328',
      linkedinUrl: POST_URL,
      content: 'How real estate agents can use AI to improve their client service.',
      comments: [comment()],
      reactions: [],
    },
    {
      type: 'comment',
      ...comment(),
      postId: '7486634839639523328',
    },
  ]
}

function outcome(values: Partial<ApifyRunOutcome> = {}): ApifyRunOutcome {
  return {
    kind: 'ok',
    status: 'ok',
    items: items(),
    actorId: APIFY_LINKEDIN_ENGAGER_ACTOR_ID,
    runId: 'synthetic-engager-run',
    itemCount: 2,
    httpStatus: 201,
    retryAfterSeconds: null,
    bodySnippet: null,
    requestUrl: 'https://api.apify.com/v2/acts/harvestapi~linkedin-post-search/runs?token=[redacted]',
    attemptedAt: CLOCK.toISOString(),
    error: null,
    billingFinalized: true,
    chargedEventCounts: { 'apify-actor-start': 1, post: 1, comment: 1 },
    providerCostUsd:
      APIFY_LINKEDIN_ENGAGER_EVENT_PRICES_USD['apify-actor-start'] +
      APIFY_LINKEDIN_ENGAGER_EVENT_PRICES_USD.post +
      APIFY_LINKEDIN_ENGAGER_EVENT_PRICES_USD.comment,
    pricingModel: 'PAY_PER_EVENT',
    ...values,
  }
}

describe('Apify LinkedIn commenter-lead contract', () => {
  it('stays held unless every exact deployment gate is present', () => {
    expect(apifyLinkedInEngagerEnabled(ENABLED_ENV)).toBe(false)
    expect(
      apifyLinkedInEngagerEnabled({
        ...ENABLED_ENV,
        [APIFY_LINKEDIN_ENGAGER_ENABLED_ENV]: 'true',
      }),
    ).toBe(true)
    expect(
      apifyLinkedInEngagerApproved({
        ...ENABLED_ENV,
        [APIFY_LINKEDIN_ENGAGER_PRICE_VERSION_ENV]: 'stale-price',
      }),
    ).toBe(false)
  })

  it('is a business-and-consumer people source with manual public-profile rights', () => {
    const descriptor = apifyLinkedInEngagerDescriptor(ENABLED_ENV)
    expect(descriptor.adapter_id).toBe(APIFY_LINKEDIN_ENGAGER_ADAPTER_ID)
    expect(descriptor.capabilities).toEqual([
      {
        signal_kind: 'social_engagement',
        entity_units: ['people'],
        geographies: ['US'],
        channels: ['linkedin'],
      },
    ])
    expect(descriptor.constraints.license).toMatchObject({
      audience_modes: ['business', 'consumer'],
      public_profile_contact_allowed: true,
      automated_email_allowed: false,
      retention_days: 30,
    })
  })

  it('scrapes bounded comments but leaves lower-intent reactions off', () => {
    expect(buildApifyLinkedInEngagerInput(PLAN)).toEqual({
      searchQueries: ['("AI in real estate" OR "AI for real estate agents" OR "real estate AI") NOT (proptech OR "commercial real estate")'],
      maxPosts: 1,
      postedLimit: 'month',
      sortBy: 'relevance',
      scrapeComments: true,
      postNestedComments: true,
      maxComments: 5,
      commentsProfileScraperMode: 'short',
      scrapeReactions: false,
      postNestedReactions: false,
    })
  })

  it('quotes the full post-plus-comment ceiling before markup', () => {
    const adapter = createApifyLinkedInEngagerAdapter({ env: ENABLED_ENV, now })
    const quote = adapter.quote(PLAN)
    expect(quote.max_candidates).toBe(5)
    expect(quote.provider_units).toBeCloseTo(12.05)
    expect(quote.billable_unit).toBe('apify_millidollar')
  })

  it('refuses a quote without the frozen returned-content query contract', () => {
    const adapter = createApifyLinkedInEngagerAdapter({ env: ENABLED_ENV, now })
    expect(() => adapter.quote({
      ...PLAN,
      provider_query: { recency_window: 'last 30 days' },
    })).toThrow('missing frozen LinkedIn engagement query contract')
  })

  it('returns one deduplicated commenter anchored to the public post and finalized spend', async () => {
    const calls: Array<{ input: Record<string, unknown>; options: Record<string, unknown> }> = []
    const adapter = createApifyLinkedInEngagerAdapter({
      env: ENABLED_ENV,
      now,
      runActor: async (_actorId, input, options) => {
        calls.push({ input, options })
        return outcome()
      },
    })
    const result = await adapter.search(PLAN)
    expect(result.status).toBe('ok')
    expect(result.cost_units).toBeCloseTo(4.05)
    expect(result.data).toEqual([
      expect.objectContaining({
        entity_kind: 'person',
        identity: expect.objectContaining({ name: 'Jamie Example', urls: [PROFILE_URL] }),
        evidence: [expect.objectContaining({
          claim: 'Commented on a public LinkedIn post (COMMENT)',
          source_url: POST_URL,
          detail: expect.objectContaining({
            post_content: 'How real estate agents can use AI to improve their client service.',
          }),
        })],
      }),
    ])
    expect(result.receipt).toMatchObject({
      actor_id: APIFY_LINKEDIN_ENGAGER_ACTOR_ID,
      actor_build: APIFY_LINKEDIN_ENGAGER_ACTOR_BUILD,
      billing_finalized: true,
      charged_event_counts: { 'apify-actor-start': 1, post: 1, comment: 1 },
      returned_count: 1,
      skipped_child_rows: 1,
      query_contract_version: LINKEDIN_ENGAGER_QUERY_CONTRACT_VERSION,
      engagement_topics: ['AI in real estate', 'AI for real estate agents', 'real estate AI'],
      reactions_scraped: false,
    })
    expect(calls[0]?.options.datasetFields).toEqual([...APIFY_LINKEDIN_ENGAGER_DATASET_FIELDS])
  })

  it('parks an unexpected reaction charge instead of billing it under the approved quote', async () => {
    const adapter = createApifyLinkedInEngagerAdapter({
      env: ENABLED_ENV,
      now,
      runActor: async () =>
        outcome({
          chargedEventCounts: { 'apify-actor-start': 1, post: 1, comment: 1, reaction: 1 },
          providerCostUsd: 0.00605,
        }),
    })
    await expect(adapter.search(PLAN)).resolves.toMatchObject({
      status: 'ambiguous',
      cost_units: null,
      error: expect.stringContaining('unapproved LinkedIn engager event'),
    })
  })

  it.each(['b2b', 'b2c'] as const)('plans a governed %s commenter-lead run', (marketType) => {
    const adapter = createApifyLinkedInEngagerAdapter({ env: ENABLED_ENV, now })
    const plan = buildSourcePlan(
      {
        marketType,
        geography: 'Austin, TX',
        signal: 'Public LinkedIn comments demonstrating real-estate demand',
        signalKind: 'social_engagement',
        entityUnit: 'people',
        audience: 'Homeowners considering a move',
        sourceHint: 'public LinkedIn posts',
        providerQuery: PLAN.provider_query,
      },
      [adapter],
      { targetAccepted: 2, maxRawCandidates: 5 },
    )
    expect(plan).toMatchObject({
      ok: true,
      adapterPlan: [
        expect.objectContaining({
          adapter_id: APIFY_LINKEDIN_ENGAGER_ADAPTER_ID,
          capability: expect.objectContaining({ entity_kind: 'person', entity_unit: 'people' }),
        }),
      ],
    })
    if (plan.ok) {
      expect(plan.policy.outreach_mode).toBe(marketType === 'b2b' ? 'automated_email' : 'manual_only')
    }
  })

  it('excludes the adapter from a plan when returned-content topics are not frozen', () => {
    const adapter = createApifyLinkedInEngagerAdapter({ env: ENABLED_ENV, now })
    const plan = buildSourcePlan(
      {
        marketType: 'b2b',
        geography: 'Austin, TX',
        signal: 'Public LinkedIn comments demonstrating real-estate demand',
        signalKind: 'social_engagement',
        entityUnit: 'people',
        audience: 'Residential real-estate agents',
        sourceHint: 'public LinkedIn posts',
        providerQuery: { recency_window: 'last 30 days' },
      },
      [adapter],
      { targetAccepted: 2, maxRawCandidates: 5 },
    )
    expect(plan).toMatchObject({
      ok: false,
      code: 'empty_adapter_plan',
      unsupportedDimensions: [expect.objectContaining({
        adapter_id: APIFY_LINKEDIN_ENGAGER_ADAPTER_ID,
        dimension: 'source_query',
        reason: 'missing frozen LinkedIn engagement query contract',
      })],
    })
  })
})
