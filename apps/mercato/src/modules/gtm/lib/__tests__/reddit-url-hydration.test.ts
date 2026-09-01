import type { ApifyRunOutcome } from '../adapters/apify/client'
import {
  APIFY_REDDIT_URL_HYDRATION_CONFIG,
  createApifyRedditUrlHydrationAdapter,
} from '../adapters/apify/public-social-opportunity-source'
import { APIFY_REQUIRED_PRICE_VERSION, APIFY_REQUIRED_TERMS_VERSION } from '../adapters/apify/source'
import {
  DATAFORSEO_OPPORTUNITY_PRICE_VERSION_ENV,
  DATAFORSEO_OPPORTUNITY_REQUIRED_PRICE_VERSION,
  createDataForSeoOpportunityAdapter,
} from '../adapters/dataforseo/opportunity-source'
import {
  DATAFORSEO_REQUIRED_RETENTION_DAYS,
  DATAFORSEO_REQUIRED_TERMS_VERSION,
} from '../adapters/dataforseo/maps'
import type { Candidate, SourceSearchPlan } from '../adapters/types'
import { FixtureLedger } from '../credits/ledger'
import { GtmCandidate, GtmEvidence, GtmProviderOperation, GtmResearchRun } from '../../data/entities'
import { executeResearchRun } from '../research/execute'
import { buildSourcePlan } from '../research/plan'
import { FakeEm } from './support/fake-em'
import {
  REDDIT_URL_HYDRATION_CONTRACT_VERSION,
  canonicalRedditThreadUrl,
  fuseRedditHydrationCandidates,
  mergeRedditHydrationCandidates,
  redditUrlSetHash,
  selectRedditHydrationTargets,
} from '../research/reddit-url-hydration'

const CLOCK = new Date('2026-09-01T18:00:00.000Z')
const NOW = () => CLOCK
const URL = 'https://www.reddit.com/r/Austin/comments/abc123/'

function candidate(url: string, name = 'Discovery result'): Candidate {
  return {
    entity_kind: 'opportunity',
    identity: {
      name,
      urls: [url],
      platform: 'Reddit',
      opportunity_kind: 'thread',
      location: 'Austin, Texas',
    },
    evidence: [{
      claim: `${name} evidence`,
      source_url: url,
      observed_at: CLOCK.toISOString(),
      confidence: 0.8,
    }],
  }
}

function env() {
  return {
    GTM_APIFY_ENABLED: 'true',
    GTM_APIFY_ACCOUNT_TIER: 'BRONZE',
    GTM_APIFY_TOKEN: 'synthetic-token',
    GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
    GTM_APIFY_TERMS_VERSION: APIFY_REQUIRED_TERMS_VERSION,
    GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
    GTM_APIFY_REDDIT_URL_HYDRATION_ENABLED: 'true',
    GTM_APIFY_REDDIT_URL_HYDRATION_USE_APPROVED: 'true',
    GTM_APIFY_REDDIT_URL_HYDRATION_PRICE_VERSION:
      APIFY_REDDIT_URL_HYDRATION_CONFIG.requiredPriceVersion,
  }
}

function plan(overrides: Partial<SourceSearchPlan> = {}): SourceSearchPlan {
  return {
    signal_kind: 'social_engagement',
    entity_unit: 'opportunities',
    geography: 'US',
    query: 'Austin first-time home buyer',
    provider_query: {
      locations: ['Austin, Texas'],
      reddit_url_hydration_contract_version: REDDIT_URL_HYDRATION_CONTRACT_VERSION,
      reddit_post_urls: [URL],
      reddit_post_urls_hash: redditUrlSetHash([URL]),
      reddit_returned_content_filter_version: 'semantic-intent-location-v4',
      reddit_filter_required_intent: 'buyer_intent',
      reddit_filter_require_location: true,
      reddit_subreddits: ['Austin'],
    },
    max_candidates: 2,
    max_charge_usd: 0.01,
    ...overrides,
  }
}

function outcome(): ApifyRunOutcome {
  const items = [
    {
      _type: 'post',
      _post_id: 't3_abc123',
      _status: 'found',
      id: 'abc123',
      title: 'Austin first-time buyer looking for a home',
      selftext: 'We are house hunting in Austin and comparing neighborhoods this month.',
      author: 'thread_starter',
      subreddit: 'Austin',
      score: 12,
      num_comments: 4,
      created_utc: Date.parse('2026-08-31T17:00:00.000Z') / 1_000,
      permalink: '/r/Austin/comments/abc123/austin_first_time_buyer/',
      over_18: false,
      stickied: false,
      locked: false,
      archived: false,
    },
    {
      _type: 'comment',
      _post_id: 't3_abc123',
      _status: 'found',
      id: 't1_comment',
      postId: 't3_abc123',
      postTitle: 'Austin first-time buyer looking for a home',
      author: 'another_buyer',
      subreddit: 'Austin',
      score: 3,
      createdAt: '2026-08-31T18:00:00.000Z',
      parentId: 't3_abc123',
      permalink: '/r/Austin/comments/abc123/austin_first_time_buyer/comment/',
      body: 'We are also looking to buy a home in Austin this month.',
      isStickied: false,
      isLocked: false,
      isDeleted: false,
      isArchived: false,
      isRemoved: false,
      isCommercialCommunication: false,
    },
  ]
  return {
    kind: 'ok',
    status: 'ok',
    items,
    actorId: APIFY_REDDIT_URL_HYDRATION_CONFIG.actorId,
    runId: 'synthetic-hydration-run',
    itemCount: 2,
    httpStatus: 201,
    retryAfterSeconds: null,
    bodySnippet: null,
    requestUrl: 'https://api.apify.com/v2/acts/clearpath~reddit-post-comments-bulk-scraper/runs?token=[redacted]',
    attemptedAt: CLOCK.toISOString(),
    error: null,
    billingFinalized: true,
    chargedEventCounts: {
      'apify-actor-start': 1,
      'apify-default-dataset-item': 2,
      'post-scraped': 1,
      'comment-scraped': 1,
    },
    providerCostUsd: 0.0045,
    pricingModel: 'PAY_PER_EVENT',
  }
}

describe('Reddit URL hydration contract', () => {
  it('canonicalizes only public Reddit post destinations', () => {
    expect(canonicalRedditThreadUrl('https://old.reddit.com/r/Austin/comments/ABC123/slug/comment/')).toBe(URL)
    expect(canonicalRedditThreadUrl('https://redd.it/abc123?share_id=tracking')).toBe(
      'https://www.reddit.com/comments/abc123/',
    )
    expect(canonicalRedditThreadUrl('https://www.reddit.com/r/Austin/')).toBeNull()
    expect(canonicalRedditThreadUrl('https://example.com/r/Austin/comments/abc123/')).toBeNull()
  })

  it('selects, deduplicates, sorts, and scope-binds returned discovery URLs', () => {
    const rows = [
      candidate('https://www.reddit.com/r/Austin/comments/def456/second/'),
      candidate('https://old.reddit.com/r/Austin/comments/abc123/first/comment/'),
      candidate('https://www.reddit.com/r/Denver/comments/ghi789/wrong_market/'),
      candidate('https://old.reddit.com/r/Austin/comments/abc123/duplicate/'),
    ]
    expect(selectRedditHydrationTargets(rows, 'reddit.com/r/Austin', 10)).toEqual([
      URL,
      'https://www.reddit.com/r/Austin/comments/def456/',
    ])
    expect(selectRedditHydrationTargets(rows, 'reddit.com/r/Denver', 1)).toEqual([
      'https://www.reddit.com/r/Denver/comments/ghi789/',
    ])
    expect(selectRedditHydrationTargets(rows, 'reddit.com', 10)).toEqual([])
  })

  it('merges bounded post/comment rows and fuses only their exact discovery destination', () => {
    const post = candidate('https://www.reddit.com/r/Austin/comments/abc123/post/', 'Post')
    const comment = candidate('https://www.reddit.com/r/Austin/comments/abc123/post/comment/', 'Comment')
    comment.evidence[0]!.confidence = 0.92
    const merged = mergeRedditHydrationCandidates([post, comment], [URL])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.identity.name).toBe('Comment')
    expect(merged[0]?.evidence).toHaveLength(2)

    const untouched = candidate('https://www.reddit.com/r/Austin/comments/def456/other/', 'Other')
    const fused = fuseRedditHydrationCandidates([candidate(URL), untouched], merged)
    expect(fused[0]?.identity.name).toBe('Comment')
    expect(fused[0]?.evidence).toHaveLength(3)
    expect(fused[1]?.identity.name).toBe('Other')
  })

  it('pins the current actor, reserves the exact two-row ceiling, and returns one destination', async () => {
    const runActor = jest.fn(async () => outcome())
    const adapter = createApifyRedditUrlHydrationAdapter({ env: env(), now: NOW, runActor })
    expect(APIFY_REDDIT_URL_HYDRATION_CONFIG).toMatchObject({
      actorBuild: '0.0.65',
      requiredPriceVersion: 'clearpath-reddit-post-comments-0.0.65-starter-bronze-events-2026-09-01',
      perItemQuoteUsd: 0.002,
      oneTimeQuoteUsd: 0.0005,
      minimumBatch: 2,
      maxBatch: 20,
    })
    expect(adapter.quote(plan())).toMatchObject({
      max_candidates: 2,
      provider_units: 10,
      billable_unit: 'apify_millidollar',
    })

    const result = await adapter.search(plan())
    expect(result.status).toBe('ok')
    expect(result.data).toHaveLength(1)
    expect(result.cost_units).toBe(4.5)
    expect(result.receipt).toMatchObject({
      requested_url_count: 1,
      requested_url_hash: redditUrlSetHash([URL]),
      hydrated_destination_count: 1,
      normalized_source_rows: 2,
    })
    expect(runActor).toHaveBeenCalledWith(
      APIFY_REDDIT_URL_HYDRATION_CONFIG.actorId,
      {
        postUrls: [URL],
        sort: 'new',
        maxCommentsPerPost: 1,
        expandAllComments: false,
      },
      expect.objectContaining({ build: '0.0.65', maxItems: 2, maxChargeUsd: 0.01 }),
    )
  })

  it('keeps a destination-grounded buyer decision while filtering an unrelated returned comment', async () => {
    const paidShape = outcome()
    paidShape.items = [
      {
        _type: 'post',
        _post_id: 't3_abc123',
        _status: 'found',
        id: 'abc123',
        title: 'Torn between two scenarios for where to buy our next house. If you have a long commute please weigh in',
        selftext: '[deleted]',
        author: 'thread_starter',
        subreddit: 'Austin',
        score: 12,
        num_comments: 4,
        created_utc: Date.parse('2026-08-31T17:00:00.000Z') / 1_000,
        permalink: '/r/Austin/comments/abc123/torn_between_two_scenarios/',
        over_18: false,
        stickied: false,
        locked: false,
        archived: false,
      },
      {
        _type: 'comment',
        _post_id: 't3_abc123',
        _status: 'found',
        id: 't1_comment',
        postId: 't3_abc123',
        postTitle: 'Torn between two scenarios for where to buy our next ...',
        author: 'local_commenter',
        subreddit: 'Austin',
        score: 3,
        createdAt: '2026-08-31T18:00:00.000Z',
        parentId: 't3_abc123',
        permalink: '/r/Austin/comments/abc123/torn_between_two_scenarios/comment/',
        body: 'Following this discussion.',
        isStickied: false,
        isLocked: false,
        isDeleted: false,
        isArchived: false,
        isRemoved: false,
        isCommercialCommunication: false,
      },
    ]
    const adapter = createApifyRedditUrlHydrationAdapter({
      env: env(),
      now: NOW,
      runActor: async () => paidShape,
    })

    const result = await adapter.search(plan())

    expect(result).toMatchObject({
      status: 'partial',
      cost_units: 4.5,
      receipt: {
        returned_content_filter_version: 'semantic-intent-location-v4',
        returned_content_filtered_rows: 1,
        returned_content_filter_reasons: { returned_content_semantic_mismatch: 1 },
        requested_url_count: 1,
        hydrated_destination_count: 1,
      },
    })
    expect(result.data).toHaveLength(1)
    expect(result.data?.[0]?.identity.location).toBe('Austin, Texas')
    expect(result.data?.[0]?.identity.name).toBe(
      'Torn between two scenarios for where to buy our next house. If you have a long commute please weigh in',
    )
  })

  it('does not treat a country code embedded inside a subreddit name as local-market evidence', async () => {
    const adapter = createApifyRedditUrlHydrationAdapter({
      env: env(),
      now: NOW,
      runActor: async () => outcome(),
    })
    const countryOnly = plan({
      geography: 'US',
      provider_query: {
        ...plan().provider_query,
        locations: [],
      },
    })

    const result = await adapter.search(countryOnly)

    expect(result).toMatchObject({
      status: 'no_result',
      receipt: {
        returned_content_filtered_rows: 2,
        returned_content_filter_reasons: { returned_content_semantic_mismatch: 2 },
      },
    })
    expect(result.data).toBeNull()
  })

  it('freezes hydration under only the priced DataForSEO Reddit discovery batches', () => {
    const discovery = createDataForSeoOpportunityAdapter({
      env: {
        GTM_DATAFORSEO_ENABLED: 'true',
        GTM_DATAFORSEO_LOGIN: 'login',
        GTM_DATAFORSEO_PASSWORD: 'password',
        GTM_DATAFORSEO_CUSTOMER_USE_APPROVED: 'true',
        GTM_DATAFORSEO_CONSUMER_OPPORTUNITY_USE_APPROVED: 'true',
        GTM_DATAFORSEO_TERMS_VERSION: DATAFORSEO_REQUIRED_TERMS_VERSION,
        GTM_DATAFORSEO_RETENTION_DAYS: String(DATAFORSEO_REQUIRED_RETENTION_DAYS),
        [DATAFORSEO_OPPORTUNITY_PRICE_VERSION_ENV]: DATAFORSEO_OPPORTUNITY_REQUIRED_PRICE_VERSION,
      },
    })
    const hydration = createApifyRedditUrlHydrationAdapter({ env: env(), now: NOW })
    const result = buildSourcePlan(
      {
        marketType: 'b2c',
        geography: 'Austin, Texas, US',
        signal: 'social_engagement',
        signalKind: 'social_engagement',
        entityUnit: 'opportunities',
        audience: 'Austin home buyers looking for local real estate guidance',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      [discovery, hydration],
      { targetAccepted: 3, maxRawCandidates: 6 },
      2,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.schemaVersion).toBe('13')
    expect(result.adapterPlan.every((batch) => batch.adapter_id !== hydration.descriptor.adapter_id)).toBe(true)
    const dependent = result.adapterPlan
      .map((batch) => batch.dependentHydration)
      .filter((value) => value != null)
    expect(dependent).not.toHaveLength(0)
    expect(dependent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adapter_id: hydration.descriptor.adapter_id,
          maxUrls: expect.any(Number),
          rowsPerUrl: 2,
          priceVersion: APIFY_REDDIT_URL_HYDRATION_CONFIG.requiredPriceVersion,
          selector: expect.objectContaining({
            version: 'canonical-reddit-thread-url-v1',
            sourceAdapterId: discovery.descriptor.adapter_id,
            frozenSiteScope: 'reddit.com/r/Austin',
          }),
          providerQuery: expect.objectContaining({
            locations: ['Austin, Texas, US'],
            reddit_url_hydration_contract_version: REDDIT_URL_HYDRATION_CONTRACT_VERSION,
            reddit_post_urls: [],
            reddit_post_urls_hash: null,
            reddit_filter_required_intent: 'buyer_intent',
            reddit_subreddits: ['Austin'],
          }),
        }),
      ]),
    )
    const frozenMaximum = result.adapterPlan.reduce(
      (sum, batch) => sum + batch.estimatedCredits + (batch.dependentHydration?.estimatedCredits ?? 0),
      0,
    )
    expect(result.estimatedCredits).toBe(frozenMaximum)
  })

  it('rejects a mismatched URL hash before provider contact', async () => {
    const runActor = jest.fn(async () => outcome())
    const adapter = createApifyRedditUrlHydrationAdapter({ env: env(), now: NOW, runActor })
    const invalid = plan({
      provider_query: {
        ...plan().provider_query,
        reddit_post_urls_hash: '0'.repeat(64),
      },
    })
    const result = await adapter.search(invalid)
    expect(result.status).toBe('error')
    expect(result.error).toContain('URL hash')
    expect(runActor).not.toHaveBeenCalled()
  })

  it('uses a separate exact-URL ledger operation and attributes hydrated evidence to it', async () => {
    const discovery = createDataForSeoOpportunityAdapter({
      env: {
        GTM_DATAFORSEO_ENABLED: 'true',
        GTM_DATAFORSEO_LOGIN: 'login',
        GTM_DATAFORSEO_PASSWORD: 'password',
        GTM_DATAFORSEO_CUSTOMER_USE_APPROVED: 'true',
        GTM_DATAFORSEO_CONSUMER_OPPORTUNITY_USE_APPROVED: 'true',
        GTM_DATAFORSEO_TERMS_VERSION: DATAFORSEO_REQUIRED_TERMS_VERSION,
        GTM_DATAFORSEO_RETENTION_DAYS: String(DATAFORSEO_REQUIRED_RETENTION_DAYS),
        [DATAFORSEO_OPPORTUNITY_PRICE_VERSION_ENV]: DATAFORSEO_OPPORTUNITY_REQUIRED_PRICE_VERSION,
      },
    })
    const hydrationRun = jest.fn(async () => outcome())
    const hydration = createApifyRedditUrlHydrationAdapter({
      env: env(),
      now: NOW,
      runActor: hydrationRun,
    })
    const priced = buildSourcePlan(
      {
        marketType: 'b2c',
        geography: 'Austin, Texas, US',
        signal: 'social_engagement',
        signalKind: 'social_engagement',
        entityUnit: 'opportunities',
        audience: 'Austin home buyers looking for local real estate guidance',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      [discovery, hydration],
      { targetAccepted: 3, maxRawCandidates: 6 },
      2,
    )
    if (!priced.ok) throw new Error(priced.reason)
    const parent = priced.adapterPlan.find((batch) => batch.dependentHydration)
    if (!parent?.dependentHydration) throw new Error('expected a frozen hydration dependency')
    const discoverySearch = jest.fn(async () => ({
      status: 'ok' as const,
      data: [candidate('https://www.reddit.com/r/Austin/comments/abc123/discovery_slug/')],
      receipt: { provider_request_id: 'synthetic-dataforseo-task' },
      cost_units: 1,
    }))
    const discoverySpy = {
      descriptor: discovery.descriptor,
      quote: discovery.quote,
      search: discoverySearch,
    }
    const em = new FakeEm()
    const run = em.create(GtmResearchRun, {
      organizationId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      workspaceId: '33333333-3333-4333-8333-333333333333',
      playId: '44444444-4444-4444-8444-444444444444',
      status: 'running',
      providerPlan: {
        schemaVersion: priced.schemaVersion,
        adapterPlan: [parent],
        query: priced.query,
      },
      limits: {
        targetAccepted: 3,
        maxRawCandidates: 6,
        maxCandidates: 6,
        maxCredits: parent.estimatedCredits + parent.dependentHydration.estimatedCredits,
      },
      estimatedCredits: String(parent.estimatedCredits + parent.dependentHydration.estimatedCredits),
    })
    const ledger = new FixtureLedger({ poolBalance: 10_000 })
    const result = await executeResearchRun({
      em,
      ledger,
      adapters: {
        [discoverySpy.descriptor.adapter_id]: discoverySpy,
        [hydration.descriptor.adapter_id]: hydration,
      },
      run,
      play: {
        id: run.playId,
        signal: 'social_engagement',
        entityUnit: 'opportunities',
        geography: 'Austin, Texas, US',
        audience: 'Austin home buyers looking for local real estate guidance',
      },
      noliOrgId: '55555555-5555-4555-8555-555555555555',
      noliUserId: '66666666-6666-4666-8666-666666666666',
      markupMultiplier: 2,
      now: NOW,
      destinationValidationEnabled: false,
    })

    expect(result.status).toBe('completed')
    expect(discoverySearch).toHaveBeenCalledTimes(1)
    expect(hydrationRun).toHaveBeenCalledTimes(1)
    expect(result.batches).toHaveLength(2)
    expect(result.batches[1]).toMatchObject({
      adapterId: hydration.descriptor.adapter_id,
      outcome: 'ok',
      hydrationRequestedUrls: 1,
      hydratedDestinations: 1,
      candidatesInserted: 0,
    })
    const operations = ledger.listOperations()
    expect(operations.map((operation) => operation.provider)).toEqual([
      discovery.descriptor.adapter_id,
      hydration.descriptor.adapter_id,
    ])
    expect(operations[1]?.fingerprint).toMatchObject({
      parent_provider_operation_id: operations[0]?.operationId,
      exact_reddit_urls: [URL],
      exact_reddit_urls_hash: redditUrlSetHash([URL]),
      selector_version: 'canonical-reddit-thread-url-v1',
    })
    expect(em.table(GtmProviderOperation)).toHaveLength(2)
    expect(em.table(GtmCandidate)).toHaveLength(1)
    const evidenceProviders = em.table(GtmEvidence).map((row) =>
      (row.providerRef as Record<string, unknown>).provider,
    )
    expect(evidenceProviders).toContain(discovery.descriptor.adapter_id)
    expect(evidenceProviders).toContain(hydration.descriptor.adapter_id)
  })

  it('does not reserve or contact hydration when discovery returns no eligible Reddit URL', async () => {
    const discovery = createDataForSeoOpportunityAdapter({
      env: {
        GTM_DATAFORSEO_ENABLED: 'true',
        GTM_DATAFORSEO_LOGIN: 'login',
        GTM_DATAFORSEO_PASSWORD: 'password',
        GTM_DATAFORSEO_CUSTOMER_USE_APPROVED: 'true',
        GTM_DATAFORSEO_CONSUMER_OPPORTUNITY_USE_APPROVED: 'true',
        GTM_DATAFORSEO_TERMS_VERSION: DATAFORSEO_REQUIRED_TERMS_VERSION,
        GTM_DATAFORSEO_RETENTION_DAYS: String(DATAFORSEO_REQUIRED_RETENTION_DAYS),
        [DATAFORSEO_OPPORTUNITY_PRICE_VERSION_ENV]: DATAFORSEO_OPPORTUNITY_REQUIRED_PRICE_VERSION,
      },
    })
    const hydrationRun = jest.fn(async () => outcome())
    const hydration = createApifyRedditUrlHydrationAdapter({
      env: env(),
      now: NOW,
      runActor: hydrationRun,
    })
    const priced = buildSourcePlan(
      {
        marketType: 'b2c',
        geography: 'Austin, Texas, US',
        signal: 'social_engagement',
        signalKind: 'social_engagement',
        entityUnit: 'opportunities',
        audience: 'Austin home buyers looking for local real estate guidance',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      [discovery, hydration],
      { targetAccepted: 3, maxRawCandidates: 6 },
      2,
    )
    if (!priced.ok) throw new Error(priced.reason)
    const parent = priced.adapterPlan.find((batch) => batch.dependentHydration)
    if (!parent?.dependentHydration) throw new Error('expected a frozen hydration dependency')
    const discoverySearch = jest.fn(async () => ({
      status: 'ok' as const,
      data: [candidate('https://example.com/austin-home-buyers')],
      receipt: { provider_request_id: 'synthetic-dataforseo-task-no-reddit' },
      cost_units: 1,
    }))
    const discoverySpy = {
      descriptor: discovery.descriptor,
      quote: discovery.quote,
      search: discoverySearch,
    }
    const em = new FakeEm()
    const run = em.create(GtmResearchRun, {
      organizationId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      workspaceId: '33333333-3333-4333-8333-333333333333',
      playId: '44444444-4444-4444-8444-444444444444',
      status: 'running',
      providerPlan: {
        schemaVersion: priced.schemaVersion,
        adapterPlan: [parent],
        query: priced.query,
      },
      limits: {
        targetAccepted: 3,
        maxRawCandidates: 6,
        maxCandidates: 6,
        maxCredits: parent.estimatedCredits + parent.dependentHydration.estimatedCredits,
      },
      estimatedCredits: String(parent.estimatedCredits + parent.dependentHydration.estimatedCredits),
    })
    const ledger = new FixtureLedger({ poolBalance: 10_000 })
    const result = await executeResearchRun({
      em,
      ledger,
      adapters: {
        [discoverySpy.descriptor.adapter_id]: discoverySpy,
        [hydration.descriptor.adapter_id]: hydration,
      },
      run,
      play: {
        id: run.playId,
        signal: 'social_engagement',
        entityUnit: 'opportunities',
        geography: 'Austin, Texas, US',
        audience: 'Austin home buyers looking for local real estate guidance',
      },
      noliOrgId: '55555555-5555-4555-8555-555555555555',
      noliUserId: '66666666-6666-4666-8666-666666666666',
      markupMultiplier: 2,
      now: NOW,
      destinationValidationEnabled: false,
    })

    expect(result.status).toBe('completed')
    expect(discoverySearch).toHaveBeenCalledTimes(1)
    expect(hydrationRun).not.toHaveBeenCalled()
    expect(result.batches).toHaveLength(2)
    expect(result.batches[1]).toMatchObject({
      adapterId: hydration.descriptor.adapter_id,
      outcome: 'skipped_no_hydration_destinations',
      hydrationRequestedUrls: 0,
      hydratedDestinations: 0,
    })
    expect(ledger.listOperations().map((operation) => operation.provider)).toEqual([
      discovery.descriptor.adapter_id,
    ])
    expect(em.table(GtmProviderOperation)).toHaveLength(1)
  })
})
