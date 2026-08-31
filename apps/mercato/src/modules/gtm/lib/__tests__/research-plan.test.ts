import { fixtureSourceAdapter, fixtureSourceDescriptor } from '../adapters/fixture'
import { fixtureConsumerSourceAdapter, fixtureConsumerSourceDescriptor } from '../adapters/fixture-consumer'
import type { SourceAdapter } from '../adapters/types'
import {
  APIFY_COMPANY_REQUIRED_PRICE_VERSION,
  APIFY_COMPANY_PRICE_VERSION_ENV,
  createApifyCompanySourceAdapter,
} from '../adapters/apify/company-source'
import { APIFY_REQUIRED_PRICE_VERSION, APIFY_REQUIRED_TERMS_VERSION } from '../adapters/apify/source'
import {
  buildOpportunityQueryLanes,
  DATAFORSEO_EVENTS_OPPORTUNITY_DATE_RANGE,
  DATAFORSEO_OPPORTUNITY_FRESHNESS_SEARCH_PARAM,
  opportunitySourceRouting,
} from '../research/opportunity-query-lanes'
import { hasPriceMultiplyingDataForSeoOpportunityQueryOperator } from '../adapters/dataforseo/opportunity-source'
import { buildSourcePlan, DEFAULT_MAX_CANDIDATES, MAX_CANDIDATES_HARD_CAP, type PlanPlayInput } from '../research/plan'

const executablePlay: PlanPlayInput = {
  marketType: 'b2b',
  geography: 'California, US',
  signal: 'hiring_activity',
  entityUnit: 'companies',
  audience: 'B2B companies hiring revenue operations leads',
}

const adapters: SourceAdapter[] = [fixtureSourceAdapter]

const approvedCompanySource = createApifyCompanySourceAdapter({
  env: {
    GTM_APIFY_ENABLED: 'true',
    GTM_APIFY_ACCOUNT_TIER: 'BRONZE',
    GTM_APIFY_TOKEN: 'synthetic-planning-only-token',
    GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
    GTM_APIFY_TERMS_VERSION: APIFY_REQUIRED_TERMS_VERSION,
    GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
    [APIFY_COMPANY_PRICE_VERSION_ENV]: APIFY_COMPANY_REQUIRED_PRICE_VERSION,
  },
})

describe('buildSourcePlan fail-closed boundaries', () => {
  it('does not let a legacy business source serve a consumer play', () => {
    const plan = buildSourcePlan({ ...executablePlay, marketType: 'b2c' }, adapters)
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.code).toBe('empty_adapter_plan')
      expect(plan.unsupportedDimensions).toContainEqual(
        expect.objectContaining({
          adapter_id: 'fixture-source',
          dimension: 'license',
          reason: expect.stringContaining('consumer'),
        }),
      )
    }
  })

  it('keeps non-US provider research fail-closed', () => {
    const plan = buildSourcePlan({ ...executablePlay, geography: 'Berlin, Germany' }, adapters)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('play_not_researchable')
  })

  it('prices safe US consumer leads only through an explicit consumer contract', () => {
    const plan = buildSourcePlan(
      {
        marketType: 'b2c',
        geography: 'Los Angeles, California',
        signal: 'Public workshop information request',
        signalKind: 'social_engagement',
        entityUnit: 'people',
        audience: 'People who requested a local market update at a public workshop',
      },
      [fixtureConsumerSourceAdapter],
      { targetAccepted: 2, maxRawCandidates: 5 },
    )
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.policy).toEqual(
        expect.objectContaining({
          lead_mode: 'consumer',
          research_eligibility: 'provider_runnable',
          outreach_mode: 'manual_only',
          execution_eligibility: 'strategy_only',
        }),
      )
      expect(plan.adapterPlan).toEqual([
        expect.objectContaining({
          adapter_id: fixtureConsumerSourceDescriptor.adapter_id,
          maxCandidates: 5,
          billableUnit: 'public_profile',
        }),
      ])
    }
  })

  it('plans consumer demand opportunities through the explicit consumer source contract', () => {
    const plan = buildSourcePlan(
      {
        marketType: 'b2c',
        geography: 'South Bay, California',
        signal: 'Public buyer and seller intent conversations',
        signalKind: 'social_engagement',
        entityUnit: 'opportunities',
        audience: 'People publicly discussing buying or selling a home in the South Bay',
      },
      [fixtureConsumerSourceAdapter],
      { targetAccepted: 4, maxRawCandidates: 4 },
    )

    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.entityKind).toBe('opportunity')
      expect(plan.adapterPlan[0]).toEqual(
        expect.objectContaining({
          adapter_id: fixtureConsumerSourceDescriptor.adapter_id,
          capability: expect.objectContaining({
            entity_kind: 'opportunity',
            entity_unit: 'opportunities',
          }),
        }),
      )
    }
  })

  it.each(['community', 'forum', 'group', 'thread', 'post', 'event'])(
    'canonicalizes the customer-facing %s unit into the provider opportunity contract',
    (entityUnit) => {
      const plan = buildSourcePlan(
        {
          marketType: 'b2c',
          geography: 'Austin, Texas',
          signal: 'A current public destination gathers locally relevant housing participants.',
          signalKind: 'social_engagement',
          entityUnit,
          audience: 'Public local housing communities and events in Austin',
          providerQuery: { opportunity_intent_lane: 'local_audience' },
        },
        [fixtureConsumerSourceAdapter],
        { targetAccepted: 2, maxRawCandidates: 3 },
      )

      expect(plan.ok).toBe(true)
      if (plan.ok) {
        expect(plan.entityKind).toBe('opportunity')
        expect(plan.adapterPlan).not.toHaveLength(0)
        expect(plan.adapterPlan.every((batch) => batch.capability.entity_unit === 'opportunities')).toBe(true)
      }
    },
  )

  it('freezes multiple source-specific consumer query lanes as separately quoted batches', () => {
    const plan = buildSourcePlan(
      {
        marketType: 'b2c',
        geography: 'Austin, Texas',
        signal: 'Public questions from people preparing to buy a home',
        signalKind: 'social_engagement',
        entityUnit: 'opportunities',
        audience: 'Austin first-time home buyers',
        providerQuery: {
          opportunity_intent_lane: 'buyer_intent',
          source_search_keywords: ['first-time buyer questions', 'moving to Austin home search'],
        },
      },
      [fixtureConsumerSourceAdapter],
      { targetAccepted: 3, maxRawCandidates: 9 },
    )

    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.schemaVersion).toBe('11')
      expect(plan.destinationValidation).toEqual({
        version: 'safe-public-destination-v4',
        enabled: true,
        maxAttempts: 9,
        maxRedirects: 3,
        timeoutMs: 8_000,
        maxBodyBytes: 300_000,
        socialNetworkPolicy: 'provider_evidence_only',
      })
      expect(plan.adapterPlan).toHaveLength(3)
      expect(plan.adapterPlan.reduce((sum, batch) => sum + batch.maxCandidates, 0)).toBe(9)
      expect(new Set(plan.adapterPlan.map((batch) => batch.queryLaneId)).size).toBe(3)
      expect(
        plan.adapterPlan.every(
          (batch) => batch.providerQuery?.opportunity_intent_lane === 'buyer_intent'
            && typeof batch.providerQuery?.search_query === 'string'
            && Array.isArray(batch.providerQuery?.negative_terms),
        ),
      ).toBe(true)
      expect(plan.qualificationProfile).toEqual(
        expect.objectContaining({
          version: 'qualification-profile-v4',
          criteria: expect.arrayContaining([
            expect.objectContaining({ id: 'opportunity.audience' }),
            expect.objectContaining({ id: 'opportunity.intent', expected: ['buyer_intent'] }),
          ]),
        }),
      )
    }
  })

  it('keeps source-specific queries concise and versions the frozen lane contract', () => {
    const play = {
      marketType: 'b2c' as const,
      geography: 'Austin, Texas',
      signal: 'Public questions from people preparing to buy a home',
      signalKind: 'social_engagement',
      entityUnit: 'opportunities',
      audience: 'Austin first-time home buyers',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
    }
    const social = buildSourcePlan(play, [fixtureConsumerSourceAdapter], { maxRawCandidates: 6 })
    expect(social.ok).toBe(true)
    if (social.ok) {
      expect(social.adapterPlan).toHaveLength(3)
      expect(social.adapterPlan.every((batch) => batch.providerQuery?.query_lane_version === 'opportunity-query-v57')).toBe(true)
      const queries = social.adapterPlan.map((batch) => String(batch.providerQuery?.search_query ?? ''))
      expect(queries.every((query) => !query.includes('-"just listed"'))).toBe(true)
      expect(queries.every((query) => !/relocat|moving to/i.test(query))).toBe(true)
      expect(new Set(queries).size).toBe(3)
    }
  })

  it('keeps ordinary buy-a-home language on the realtor query contract', () => {
    const lanes = buildOpportunityQueryLanes(
      {
        geography: 'Austin, Texas, United States',
        audience: 'People publicly demonstrating that they want to buy a home in Austin',
        signal: 'A recent public question demonstrates home-buying intent.',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      'dataforseo-organic-demand-opportunities',
    )

    expect(lanes).toHaveLength(5)
    expect(lanes.map((lane) => lane.query)).toEqual([
      'Austin, Texas site:reddit.com/r/Austin "house hunting"',
      'Austin, Texas first time home buyer workshop registration',
      'Austin, Texas home buyer education class registration',
      'Austin, Texas homeownership workshop public registration',
      'Austin, Texas home buying seminar public registration',
    ])
    expect(lanes.every((lane) => (
      lane.providerQuery.query_lane_version === 'opportunity-query-v85'
      && lane.providerQuery.realtor_retrieval_contract_version
        === 'evidence-first-public-destination-v2'
    ))).toBe(true)
    expect(lanes.map((lane) => lane.providerQuery.dataforseo_price_operator_contract)).toEqual([
      'single-positive-site-v1',
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(lanes.map((lane) => lane.providerQuery.dataforseo_price_multiplier)).toEqual([
      5,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(lanes.map((lane) => lane.providerQuery.dataforseo_site_scope)).toEqual([
      'reddit.com/r/Austin',
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  it('builds five independently scoped freshness-enforcing Reddit lanes for realtor demand', () => {
    const play = {
      geography: 'Phoenix, Arizona, United States',
      audience: 'People publicly demonstrating that they want to buy a home in Phoenix',
      signal: 'A recent public question demonstrates home-buying intent.',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
    }
    const lanes = buildOpportunityQueryLanes(
      play,
      'apify-reddit-fresh-demand-opportunities',
    )

    expect(lanes).toHaveLength(5)
    expect(lanes.map((lane) => lane.query)).toEqual([
      '(title:"looking to buy" OR selftext:"looking to buy")',
      '(title:"house hunting" OR selftext:"house hunting")',
      '(title:"looking for a realtor" OR selftext:"looking for a realtor")',
      '(title:"buy a house" OR selftext:"buy a house")',
      '(title:"mortgage lender" OR selftext:"mortgage lender")',
    ])
    expect(lanes.map((lane) => lane.providerQuery.reddit_subreddits)).toEqual([
      ['Phoenix'],
      ['Phoenix'],
      ['Phoenix'],
      ['AskPhoenix'],
      ['FirstTimeHomeBuyer'],
    ])
    expect(lanes.every((lane) => (
      lane.providerQuery.query_lane_version === 'opportunity-query-v71'
      && lane.providerQuery.reddit_fresh_contract_version === 'public-post-search-v2'
      && lane.providerQuery.reddit_search_syntax_version === 'field-qualified-exact-phrase-bank-v4'
      && lane.providerQuery.reddit_fresh_window_days === 30
      && lane.providerQuery.reddit_returned_content_filter_version === 'semantic-intent-location-v3'
    ))).toBe(true)
    expect(lanes.map((lane) => lane.providerQuery.reddit_filter_require_location)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ])
    expect(opportunitySourceRouting(
      { ...play, providerQuery: { opportunity_intent_lane: 'local_audience' } },
      'apify-reddit-fresh-demand-opportunities',
    ).eligible).toBe(false)
  })

  it('uses only bounded exact-phrase Reddit title and body clauses for every transaction lane', () => {
    for (const intent of ['seller_intent', 'mixed_intent'] as const) {
      const lanes = buildOpportunityQueryLanes({
        geography: 'Tampa, Florida, United States',
        audience: `Tampa realtor ${intent}`,
        signal: 'A current public post demonstrates a residential property decision.',
        providerQuery: { opportunity_intent_lane: intent },
      }, 'apify-reddit-fresh-demand-opportunities')

      expect(lanes).toHaveLength(5)
      expect(new Set(lanes.map((lane) => lane.query)).size).toBe(5)
      expect(lanes.every((lane) => (
        lane.query.length <= 500
        && /\btitle:"[^"]+"/.test(lane.query)
        && /\bselftext:"[^"]+"/.test(lane.query)
        && lane.query.includes(' OR ')
        && !lane.query.includes(' AND ')
        && !/\b(?:author|subreddit|site|url|flair):/i.test(lane.query)
        && lane.providerQuery.query_lane_version === 'opportunity-query-v71'
        && lane.providerQuery.reddit_search_syntax_version === 'field-qualified-exact-phrase-bank-v4'
      ))).toBe(true)
    }
  })

  it('searches direct seller phrases in the exact market before broader communities', () => {
    const play = {
      geography: 'Tampa, Florida, United States',
      audience: 'Tampa homeowners considering selling a home',
      signal: 'A current public post demonstrates a residential sale decision.',
      providerQuery: { opportunity_intent_lane: 'seller_intent' },
    }
    const lanes = buildOpportunityQueryLanes(play, 'apify-reddit-fresh-demand-opportunities')

    expect(lanes.map((lane) => lane.query)).toEqual([
      '(title:"looking to sell" OR selftext:"looking to sell")',
      '(title:"sell my house" OR selftext:"sell my house")',
      '(title:"selling my house" OR selftext:"selling my house")',
      '(title:"thinking about selling" OR selftext:"thinking about selling")',
      '(title:"realtor recommendation" OR selftext:"realtor recommendation")',
    ])
    expect(lanes.map((lane) => lane.providerQuery.reddit_subreddits)).toEqual([
      ['Tampa'],
      ['Tampa'],
      ['Tampa'],
      ['AskTampa'],
      ['homeowners'],
    ])
    expect(lanes.map((lane) => lane.providerQuery.reddit_filter_require_location)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ])
    expect(opportunitySourceRouting(
      play,
      'apify-reddit-fresh-demand-opportunities',
    )).toEqual({
      eligible: false,
      reason: expect.stringContaining('zero seller rows'),
    })
  })

  it('uses source-native realtor queries and three economical hashtag X lanes', () => {
    const play = {
      geography: 'Austin, Texas',
      audience: 'Austin homeowners considering selling a home',
      signal: 'A public question demonstrates home-selling intent',
      providerQuery: { opportunity_intent_lane: 'seller_intent' },
    }
    const x = buildOpportunityQueryLanes(play, 'apify-x-demand-opportunities')
    const linkedin = buildOpportunityQueryLanes(play, 'apify-linkedin-demand-opportunities')
    const reddit = buildOpportunityQueryLanes(play, 'apify-reddit-demand-opportunities')
    const web = buildOpportunityQueryLanes(play, 'dataforseo-organic-demand-opportunities')
    const events = buildOpportunityQueryLanes(play, 'dataforseo-events-demand-opportunities')
    const buyerWeb = buildOpportunityQueryLanes(
      {
        geography: 'Austin, Texas',
        audience: 'Austin first-time home buyers',
        signal: 'A public question demonstrates home-buying intent',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      'dataforseo-organic-demand-opportunities',
    )

    expect(x.map((lane) => lane.query)).toEqual([
      '#AustinHomeSeller',
      '#SellingInAustin',
      '#AustinHomeValue',
    ])
    expect(x.every((lane) => lane.providerQuery.query_lane_version === 'opportunity-query-v57')).toBe(true)
    expect(linkedin).toHaveLength(1)
    expect(reddit).toHaveLength(5)
    expect(web).toHaveLength(5)
    expect(events).toHaveLength(3)
    expect(events.map((lane) => lane.query)).toEqual([
      'home seller workshop',
      'selling a home seminar',
      'home valuation workshop',
    ])
    expect(events.every((lane) =>
      lane.providerQuery.date_range === DATAFORSEO_EVENTS_OPPORTUNITY_DATE_RANGE
      && lane.providerQuery.query_lane_version === 'opportunity-query-v57'
    )).toBe(true)
    expect(web.every((lane) => lane.query.startsWith('Austin, Texas '))).toBe(true)
    expect(
      web.every(
        (lane) => lane.providerQuery.search_param === DATAFORSEO_OPPORTUNITY_FRESHNESS_SEARCH_PARAM,
      ),
    ).toBe(true)
    expect(web.every((lane) => !lane.query.includes('United States'))).toBe(true)
    expect(web.every((lane) => !/[()]/.test(lane.query))).toBe(true)
    expect(web.map((lane) => lane.providerQuery.dataforseo_site_scope)).toEqual([
      'reddit.com/r/Austin',
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(x.every((lane) => !lane.query.includes('-jobs'))).toBe(true)
    expect(
      reddit.slice(0, 3).every((lane) => /sell|selling|realtor|house/i.test(lane.query)),
    ).toBe(true)
    expect(reddit.slice(0, 3).every((lane) => !lane.query.includes('Austin'))).toBe(true)
    expect(reddit.every((lane) => lane.providerQuery.query_lane_version === 'opportunity-query-v80')).toBe(true)
    expect(reddit.every((lane) => !/\b(?:AND|OR|NOT)\b|[()]/.test(lane.query))).toBe(true)
    expect(
      reddit.every((lane) => Array.isArray(lane.providerQuery.reddit_subreddits)),
    ).toBe(true)
    expect(reddit[0]?.providerQuery.reddit_subreddits).toEqual(['Austin'])
    expect(reddit[0]?.providerQuery).toMatchObject({
      reddit_subreddits: ['Austin'],
      reddit_auto_discover: false,
      reddit_sort: 'relevance',
      reddit_content_type: 'posts',
      reddit_returned_content_filter_version: 'semantic-intent-location-v4',
      reddit_filter_required_intent: 'seller_intent',
      reddit_filter_require_location: false,
    })
    expect(reddit[1]?.providerQuery).toMatchObject({
      reddit_subreddits: ['AskAustin'],
      reddit_auto_discover: false,
      reddit_sort: 'relevance',
      reddit_content_type: 'posts',
      reddit_filter_require_location: false,
    })
    expect(reddit[2]?.providerQuery).toMatchObject({
      reddit_subreddits: ['Austin'],
      reddit_auto_discover: false,
      reddit_sort: 'relevance',
      reddit_content_type: 'comments',
      reddit_returned_content_filter_version: 'semantic-intent-location-v4',
      reddit_filter_required_intent: 'seller_intent',
      reddit_filter_require_location: false,
    })
    expect(reddit[3]?.providerQuery).toMatchObject({
      reddit_subreddits: ['AskAustin'],
      reddit_auto_discover: false,
      reddit_sort: 'relevance',
      reddit_content_type: 'comments',
      reddit_filter_require_location: true,
    })
    expect(reddit[4]?.providerQuery).toMatchObject({
      reddit_subreddits: ['Austin'],
      reddit_auto_discover: false,
      reddit_sort: 'relevance',
      reddit_content_type: 'comments',
      reddit_filter_require_location: true,
    })
    expect(reddit.map((lane) => lane.query)).toEqual([
      'selling house',
      'realtor recommendation',
      'realtor recommendation',
      'selling house advice',
      'thinking about selling',
    ])
    expect(
      web.every((lane) => !lane.query.includes(' -')),
    ).toBe(true)
    expect(web.map((lane) => lane.query)).toEqual([
        'Austin, Texas site:reddit.com/r/Austin "looking to sell home"',
        'Austin, Texas home seller workshop public registration',
        'Austin, Texas selling your home seminar public registration',
        'Austin, Texas home seller education class registration',
        'Austin, Texas prepare your home for sale workshop',
    ])
    expect(web.map((lane) => hasPriceMultiplyingDataForSeoOpportunityQueryOperator(lane.query))).toEqual([
      true,
      false,
      false,
      false,
      false,
    ])
    expect(web.every((lane) => (
      lane.providerQuery.query_lane_version === 'opportunity-query-v85'
      && lane.providerQuery.realtor_retrieval_contract_version
        === 'evidence-first-public-destination-v2'
    ))).toBe(true)
    expect(web.every((lane) => lane.query.startsWith('Austin, Texas '))).toBe(true)
    expect(web.every((lane) => lane.query.length < 240)).toBe(true)
    expect(new Set(web.map((lane) => lane.query)).size).toBe(5)
    expect(buyerWeb).toHaveLength(5)
    expect(buyerWeb.map((lane) => lane.query)).toEqual(
      expect.arrayContaining([
        'Austin, Texas site:reddit.com/r/Austin "house hunting"',
        'Austin, Texas first time home buyer workshop registration',
        'Austin, Texas home buyer education class registration',
        'Austin, Texas homeownership workshop public registration',
        'Austin, Texas home buying seminar public registration',
      ]),
    )
    expect(buyerWeb.every((lane) => lane.query.length < 240)).toBe(true)

    const threads = buildOpportunityQueryLanes(play, 'apify-threads-demand-opportunities')
    expect(threads.map((lane) => lane.query)).toEqual([
      'austinhomeseller',
      'austinsellingmyhome',
      'austinhomevalue',
    ])
    expect(
      threads.every((lane) => lane.providerQuery.query_lane_version === 'opportunity-query-v57'),
    ).toBe(true)
    expect(opportunitySourceRouting(play, 'apify-threads-demand-opportunities')).toEqual({
      eligible: false,
      reason: expect.stringContaining('Starter/BRONZE realtor probe'),
    })
    expect(opportunitySourceRouting(
      {
        geography: 'Austin, Texas',
        audience: 'People discussing independent pottery classes',
        signal: 'A current public post asks about learning pottery',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      'apify-threads-demand-opportunities',
    )).toEqual({ eligible: true, reason: null })
  })

  it('uses short source-native queries in three exact-market and two location-proven housing-community Reddit lanes', () => {
    const reddit = buildOpportunityQueryLanes(
      {
        geography: 'Phoenix, Arizona',
        audience: 'Phoenix first-time home buyers',
        signal: 'A public question demonstrates home-buying intent',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      'apify-reddit-demand-opportunities',
    )

    expect(reddit.map((lane) => lane.query)).toEqual([
      'buying home',
      'house hunting',
      'first time home buyer',
      'Phoenix',
      'Phoenix',
    ])
    expect(reddit.map((lane) => lane.providerQuery.reddit_subreddits)).toEqual([
      ['Phoenix'],
      ['AskPhoenix'],
      ['Phoenix'],
      ['FirstTimeHomeBuyer'],
      ['RealEstate'],
    ])
    expect(reddit[0]?.providerQuery).toMatchObject({
      query_lane_version: 'opportunity-query-v80',
      reddit_auto_discover: false,
      reddit_content_type: 'posts',
      reddit_filter_require_location: false,
    })
    expect(reddit[1]?.providerQuery).toMatchObject({
      query_lane_version: 'opportunity-query-v80',
      reddit_auto_discover: false,
      reddit_content_type: 'posts',
      reddit_filter_require_location: false,
    })
    expect(reddit[2]?.providerQuery).toMatchObject({
      query_lane_version: 'opportunity-query-v80',
      reddit_auto_discover: false,
      reddit_content_type: 'comments',
      reddit_filter_require_location: false,
    })
    expect(reddit[3]?.providerQuery).toMatchObject({
      query_lane_version: 'opportunity-query-v80',
      reddit_subreddits: ['FirstTimeHomeBuyer'],
      reddit_auto_discover: false,
      reddit_content_type: 'posts',
      reddit_filter_require_location: true,
    })
    expect(reddit[4]?.providerQuery).toMatchObject({
      query_lane_version: 'opportunity-query-v80',
      reddit_subreddits: ['RealEstate'],
      reddit_auto_discover: false,
      reddit_content_type: 'posts',
      reddit_filter_require_location: true,
    })
  })

  it('plans three separately quoted, exact-subreddit Reddit post-and-comment lanes', () => {
    const play = {
      geography: 'Phoenix, Arizona',
      audience: 'Phoenix first-time home buyers',
      signal: 'A current public conversation demonstrates home-buying intent',
      providerQuery: { opportunity_intent_lane: 'buyer_intent' },
    }
    const lanes = buildOpportunityQueryLanes(
      play,
      'apify-reddit-thread-demand-opportunities',
    )

    expect(lanes).toHaveLength(3)
    expect(lanes.map((lane) => lane.query)).toEqual([
      'buying home',
      'house hunting',
      'first time home buyer',
    ])
    expect(lanes.map((lane) => lane.providerQuery.reddit_subreddits)).toEqual([
      ['Phoenix'],
      ['AskPhoenix'],
      ['Phoenix'],
    ])
    expect(lanes.every((lane) => (
      lane.providerQuery.query_lane_version === 'opportunity-query-v64'
      && lane.providerQuery.reddit_thread_contract_version === 'public-post-comments-v2'
      && lane.providerQuery.reddit_returned_content_filter_version === 'semantic-intent-location-v3'
      && lane.providerQuery.reddit_filter_required_intent === 'buyer_intent'
      && lane.providerQuery.reddit_filter_require_location === false
      && lane.providerQuery.reddit_auto_discover === false
      && lane.providerQuery.reddit_global_search === false
      && !lane.query.includes('subreddit:')
    ))).toBe(true)
    expect(opportunitySourceRouting(
      play,
      'apify-reddit-thread-demand-opportunities',
    )).toEqual({ eligible: true, reason: null })
  })

  it('keeps Reddit post-and-comment trees off generic and local-audience plays', () => {
    expect(opportunitySourceRouting(
      {
        geography: 'Austin, Texas',
        audience: 'Austin homeowners and neighborhood communities',
        signal: 'Current public community discussions',
        providerQuery: { opportunity_intent_lane: 'local_audience' },
      },
      'apify-reddit-thread-demand-opportunities',
    )).toEqual({
      eligible: false,
      reason: expect.stringContaining('buyer, seller, and mixed-intent'),
    })
    expect(opportunitySourceRouting(
      {
        geography: 'Seattle, Washington',
        audience: 'Independent ceramic artists',
        signal: 'A current public discussion about kiln access',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      'apify-reddit-thread-demand-opportunities',
    )).toEqual({
      eligible: false,
      reason: expect.stringContaining('realtor'),
    })
  })

  it('keeps X realtor intent lanes atomic, market-bound, and under the actor limit', () => {
    const buyer = buildOpportunityQueryLanes(
      {
        geography: 'Austin, Texas',
        audience: 'Austin first-time home buyers',
        signal: 'A public post demonstrates home-buying intent',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      'apify-x-demand-opportunities',
    )
    const mixed = buildOpportunityQueryLanes(
      {
        geography: 'Austin, Texas',
        audience: 'Austin homeowners buying and selling a home',
        signal: 'A public post demonstrates a linked home sale and purchase',
        providerQuery: { opportunity_intent_lane: 'mixed_intent' },
      },
      'apify-x-demand-opportunities',
    )

    expect(buyer.map((lane) => lane.query)).toEqual([
      '#AustinHomebuyer',
      '#AustinHouseHunting',
      '#MovingToAustin',
    ])
    expect(mixed.map((lane) => lane.query)).toEqual([
      '#AustinMoveUpBuyer',
      '#AustinBuyAndSell',
      '#MovingInAustin',
    ])
    expect([...buyer, ...mixed].every((lane) => (
      lane.query.includes('Austin')
      && lane.query.startsWith('#')
      && lane.query.length <= 100
      && !/[()]/.test(lane.query)
      && lane.providerQuery.query_lane_version === 'opportunity-query-v57'
    ))).toBe(true)
  })

  it('routes realtor local-audience discovery to sources that can prove participation', () => {
    const play = {
      geography: 'Austin, Texas',
      audience: 'Austin homeowners and neighborhood communities',
      signal: 'Current public community meetings and housing events',
      providerQuery: { opportunity_intent_lane: 'local_audience' },
    }
    const web = buildOpportunityQueryLanes(play, 'dataforseo-organic-demand-opportunities')
    const redditAdapter: SourceAdapter = {
      ...fixtureConsumerSourceAdapter,
      descriptor: {
        ...fixtureConsumerSourceDescriptor,
        adapter_id: 'apify-reddit-demand-opportunities',
      },
    }
    const planned = buildSourcePlan(
      {
        ...play,
        marketType: 'b2c',
        signalKind: 'social_engagement',
        entityUnit: 'opportunities',
      },
      [redditAdapter, fixtureConsumerSourceAdapter],
      { maxRawCandidates: 10 },
    )

    expect(opportunitySourceRouting(play, 'apify-reddit-demand-opportunities')).toEqual({
      eligible: false,
      reason: expect.stringContaining('public venue, date, and participation path'),
    })
    expect(opportunitySourceRouting(play, 'dataforseo-organic-demand-opportunities')).toEqual({
      eligible: true,
      reason: null,
    })
    expect(web).toHaveLength(5)
    expect(web.map((lane) => lane.query)).toEqual([
      'Austin, Texas neighborhood association upcoming meeting',
      'Austin, Texas neighborhood association community calendar',
      'Austin, Texas homeowners association public meeting',
      'Austin, Texas resident organization upcoming events',
      'Austin, Texas neighborhood community get involved',
    ])
    expect(web.every(
      (lane) => lane.providerQuery.query_lane_version === 'opportunity-query-v85'
        && lane.providerQuery.realtor_retrieval_contract_version
          === 'evidence-first-public-destination-v2',
    )).toBe(true)
    expect(planned.ok).toBe(true)
    if (planned.ok) {
      expect(planned.adapterPlan.some(
        (batch) => batch.adapter_id === 'apify-reddit-demand-opportunities',
      )).toBe(false)
      expect(planned.unsupportedDimensions).toContainEqual(expect.objectContaining({
        adapter_id: 'apify-reddit-demand-opportunities',
        dimension: 'source_quality',
      }))
    }
  })

  it('does not inject realtor terminology into a non-real-estate consumer play', () => {
    const lanes = buildOpportunityQueryLanes(
      {
        geography: 'Seattle, Washington',
        audience: 'Independent ceramic artists looking for local studio communities',
        signal: 'A current public discussion about kiln access and shared studio space',
        providerQuery: {
          opportunity_intent_lane: 'local_audience',
          source_search_keywords: ['ceramic artist studio community', 'shared kiln discussion'],
        },
      },
      'apify-reddit-demand-opportunities',
    )
    expect(lanes).toHaveLength(3)
    expect(lanes.every((lane) => !/home|housing|realtor/i.test(lane.query))).toBe(true)
    expect(lanes[0]?.query).toContain('ceramic artist studio community')
    expect(opportunitySourceRouting(
      {
        geography: 'Seattle, Washington',
        audience: 'Independent ceramic artists looking for local studio communities',
        signal: 'A current public discussion about kiln access and shared studio space',
        providerQuery: { opportunity_intent_lane: 'local_audience' },
      },
      'apify-reddit-demand-opportunities',
    )).toEqual({ eligible: true, reason: null })
  })

  it('blocks sensitive consumer targeting before a provider quote', () => {
    const plan = buildSourcePlan(
      {
        marketType: 'b2c',
        geography: 'United States',
        signal: 'Recent foreclosure filing',
        signalKind: 'social_engagement',
        entityUnit: 'people',
        audience: 'Homeowners in foreclosure',
      },
      [fixtureConsumerSourceAdapter],
    )
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.code).toBe('play_not_researchable')
      expect(plan.reason).toContain('sensitive')
    }
  })

  it('fails closed on an unsupported signal with an empty adapter plan', () => {
    const plan = buildSourcePlan({ ...executablePlay, signal: 'website_visits' }, adapters)
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.code).toBe('empty_adapter_plan')
      expect(plan.unsupportedDimensions).toEqual([
        expect.objectContaining({
          adapter_id: 'fixture-source',
          dimension: 'signal_kind',
        }),
      ])
    }
  })

  it('fails closed when the play is missing sourcing dimensions', () => {
    const plan = buildSourcePlan({ ...executablePlay, signal: null }, adapters)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('missing_play_dimensions')
  })

  it('never silently plans with zero adapters', () => {
    const plan = buildSourcePlan(executablePlay, [])
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('empty_adapter_plan')
  })
})

describe('buildSourcePlan pricing and limits', () => {
  it('freezes a firmographic company-source quote including the actor-start event', () => {
    const play: PlanPlayInput = {
      marketType: 'b2b',
      geography: 'San Diego, California, US',
      signal: 'firmographic_match',
      signalKind: 'firmographic_match',
      entityUnit: 'companies',
      audience: 'Independent dental practices with 1-50 employees',
      providerQuery: {
        company_keywords: ['dental practice'],
        industries: ['Dentistry'],
        employee_ranges: ['1-10', '11-50'],
        locations: ['San Diego, California'],
      },
    }
    const plan = buildSourcePlan(
      play,
      [approvedCompanySource],
      {
        targetAccepted: 5,
        maxRawCandidates: 10,
      },
      2,
    )
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.adapterPlan).toEqual([
        expect.objectContaining({
          adapter_id: 'apify-linkedin-company-search',
          providerUnits: 10.25,
          billableUnit: 'full_company',
          maxCandidates: 10,
          estimatedCredits: 20_500,
          priceVersion: APIFY_COMPANY_REQUIRED_PRICE_VERSION,
          providerQuery: play.providerQuery,
        }),
      ])
      expect(plan.estimatedCredits).toBe(20_500)
      expect(plan.limits.maxCredits).toBe(20_500)
      expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('pursues 25 accepted leads under a separate 100-row raw ceiling', () => {
    const plan = buildSourcePlan(executablePlay, adapters, null, 2)
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(DEFAULT_MAX_CANDIDATES).toBe(25)
      expect(plan.limits).toEqual(
        expect.objectContaining({
          targetAccepted: 25,
          maxRawCandidates: 100,
          maxCandidates: 100,
        }),
      )
      expect(plan.adapterPlan).toEqual([
        expect.objectContaining({
          adapter_id: 'fixture-source',
          estimatedUnits: 25,
          quotedCreditsPerUnit: 1,
          estimatedCredits: 50,
        }),
      ])
      expect(plan.estimatedCredits).toBe(50)
      // maxCredits defaults to the plan estimate: the run can never reserve
      // beyond what was priced
      expect(plan.limits.maxCredits).toBe(50)
      expect(plan.query).toContain('revenue operations')
    }
  })

  it('caps maxCandidates at the hard cap of 100', () => {
    const plan = buildSourcePlan(executablePlay, adapters, { maxCandidates: 500 }, 2)
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(MAX_CANDIDATES_HARD_CAP).toBe(100)
      expect(plan.limits.maxCandidates).toBe(100)
      // one adapter with max_batch 25 can only take one 25-unit batch
      expect(plan.adapterPlan[0].estimatedUnits).toBe(fixtureSourceDescriptor.constraints.max_batch)
    }
  })

  it('respects an explicit maxCredits limit', () => {
    const plan = buildSourcePlan(executablePlay, adapters, { maxCandidates: 10, maxCredits: 12 }, 2)
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.limits).toEqual({
        targetAccepted: 10,
        maxRawCandidates: 10,
        maxCandidates: 10,
        maxCredits: 12,
      })
      expect(plan.estimatedCredits).toBe(20)
    }
  })

  it('allocates remaining candidates across additional covering adapters', () => {
    const secondAdapter: SourceAdapter = {
      descriptor: {
        ...fixtureSourceDescriptor,
        adapter_id: 'fixture-source-b',
      },
      quote: fixtureSourceAdapter.quote,
      search: fixtureSourceAdapter.search,
    }
    const plan = buildSourcePlan(executablePlay, [fixtureSourceAdapter, secondAdapter], {
      maxCandidates: 30,
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.adapterPlan.map((batch) => [batch.adapter_id, batch.estimatedUnits])).toEqual([
        ['fixture-source', 15],
        ['fixture-source-b', 15],
      ])
      expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/)
      expect(plan.schemaVersion).toBe('11')
    }
  })

  it('quotes bounded deterministic offset pages when one source needs continuation', () => {
    const paginated: SourceAdapter = {
      descriptor: {
        ...fixtureSourceDescriptor,
        adapter_id: 'fixture-paginated',
        constraints: {
          ...fixtureSourceDescriptor.constraints,
          max_batch: 25,
          pagination: { mode: 'offset', page_size: 25, max_pages: 2 },
        },
      },
      quote: fixtureSourceAdapter.quote,
      search: fixtureSourceAdapter.search,
    }
    const plan = buildSourcePlan(executablePlay, [paginated], {
      targetAccepted: 10,
      maxRawCandidates: 50,
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(
        plan.adapterPlan.map((batch) => ({
          units: batch.maxCandidates,
          page: batch.continuationPage,
          offset: batch.continuationOffset,
        })),
      ).toEqual([
        { units: 25, page: 1, offset: 0 },
        { units: 25, page: 2, offset: 25 },
      ])
      expect(plan.plannedRawCapacity).toBe(50)
    }
  })

  it('changes the immutable hash when price or reviewed terms change', () => {
    const baseline = buildSourcePlan(executablePlay, adapters)
    const changed: SourceAdapter = {
      descriptor: {
        ...fixtureSourceDescriptor,
        cost_model: {
          ...fixtureSourceDescriptor.cost_model,
          price_version: 'fixture-v-next',
        },
      },
      quote: fixtureSourceAdapter.quote,
      search: fixtureSourceAdapter.search,
    }
    const repriced = buildSourcePlan(executablePlay, [changed])
    expect(baseline.ok && repriced.ok).toBe(true)
    if (baseline.ok && repriced.ok) expect(repriced.planHash).not.toBe(baseline.planHash)
  })

  it('binds exact geography and canonical entity kind into the priced hash', () => {
    const california = buildSourcePlan(executablePlay, adapters)
    const texas = buildSourcePlan({ ...executablePlay, geography: 'Texas, US' }, adapters)
    expect(california.ok && texas.ok).toBe(true)
    if (california.ok && texas.ok) {
      expect(california.geography).toBe('California, US')
      expect(california.entityKind).toBe('company')
      expect(california.adapterPlan[0].capability.entity_kind).toBe('company')
      expect(texas.planHash).not.toBe(california.planHash)
    }
  })

  it('fails closed on an unknown entity-unit vocabulary', () => {
    const plan = buildSourcePlan({ ...executablePlay, entityUnit: 'mystery_rows' }, adapters)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('missing_play_dimensions')
  })

  it('freezes explicit accepted and raw targets plus the qualification profile', () => {
    const plan = buildSourcePlan(
      {
        ...executablePlay,
        providerQuery: {
          industries: ['Software'],
          company_keywords: ['revenue operations'],
          exclude_industries: ['Consumer gambling'],
        },
        recencyWindow: 'last 30 days',
      },
      adapters,
      { targetAccepted: 12, maxRawCandidates: 60 },
    )
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.limits).toEqual(
        expect.objectContaining({
          targetAccepted: 12,
          maxRawCandidates: 60,
          maxCandidates: 60,
        }),
      )
      expect(plan.qualificationProfile.criteria.map((row) => row.id)).toEqual(
        expect.arrayContaining(['account.industry', 'account.keywords', 'exclusion.industry', 'signal.recency']),
      )
      expect(plan.adapterPlan[0]).toEqual(
        expect.objectContaining({
          adaptiveOrder: 1,
          stopWhenTargetAccepted: true,
        }),
      )
    }
  })

  it('hashes distinct Unicode keys independently of insertion order', () => {
    const first = buildSourcePlan(
      {
        ...executablePlay,
        providerQuery: { '\u00e9': ['one'], 'e\u0301': ['two'] },
      },
      adapters,
    )
    const second = buildSourcePlan(
      {
        ...executablePlay,
        providerQuery: { 'e\u0301': ['two'], '\u00e9': ['one'] },
      },
      adapters,
    )
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) expect(first.planHash).toBe(second.planHash)
  })

  it('does not plan a provider whose customer-use rights are provisional', () => {
    const provisional: SourceAdapter = {
      descriptor: {
        ...fixtureSourceDescriptor,
        constraints: {
          ...fixtureSourceDescriptor.constraints,
          license: {
            ...fixtureSourceDescriptor.constraints.license,
            status: 'provisional',
          },
        },
      },
      quote: fixtureSourceAdapter.quote,
      search: fixtureSourceAdapter.search,
    }
    const plan = buildSourcePlan(executablePlay, [provisional])
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.unsupportedDimensions[0]?.dimension).toBe('license')
  })
})
