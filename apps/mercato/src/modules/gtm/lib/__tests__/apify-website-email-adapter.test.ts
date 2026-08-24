import type {
  ApifyFetchInit,
  ApifyFetchLike,
  ApifyFetchResponse,
  ApifyRunOutcome,
} from '../adapters/apify/client'
import {
  APIFY_WEBSITE_EMAIL_ACTOR_BUILD,
  APIFY_WEBSITE_EMAIL_ACTOR_ID,
  APIFY_WEBSITE_EMAIL_DATASET_BYTES,
  APIFY_WEBSITE_EMAIL_ENABLED_ENV,
  APIFY_WEBSITE_EMAIL_MAX_ADDRESSES,
  APIFY_WEBSITE_EMAIL_MAX_PAGES,
  APIFY_WEBSITE_EMAIL_MEMORY_MBYTES,
  APIFY_WEBSITE_EMAIL_PRICE_VERSION_ENV,
  APIFY_WEBSITE_EMAIL_PROVIDER_CAP_USD,
  APIFY_WEBSITE_EMAIL_REQUIRED_RETENTION_DAYS,
  APIFY_WEBSITE_EMAIL_REQUIRED_PRICE_VERSION,
  APIFY_WEBSITE_EMAIL_RETENTION_DAYS_ENV,
  apifyWebsiteEmailDescriptor,
  apifyWebsiteEmailEnabled,
  buildApifyWebsiteEmailInput,
  createApifyWebsiteEmailAdapter,
} from '../adapters/apify/website-email'
import {
  APIFY_REQUIRED_PRICE_VERSION,
  APIFY_REQUIRED_TERMS_VERSION,
} from '../adapters/apify/source'
import type { EnrichRequest } from '../adapters/types'
import { FixtureLedger } from '../credits/ledger'
import { normalizeCompanyWebsite } from '../enrich/company-domain'
import { runEnrichmentWaterfall } from '../enrich/waterfall'
import { GtmCandidate, GtmContactPoint } from '../../data/entities'
import { FakeEm } from './support/fake-em'

const TOKEN = 'apify_website_email_test_token'
const CLOCK = new Date('2026-08-23T22:00:00.000Z')
const now = () => CLOCK
const RUN_ID = 'website-run-1'
const DATASET_ID = 'website-dataset-1'

const ENABLED_ENV = {
  GTM_APIFY_ENABLED: 'true',
  GTM_APIFY_TOKEN: TOKEN,
  GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
  GTM_APIFY_TERMS_VERSION: APIFY_REQUIRED_TERMS_VERSION,
  GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
  [APIFY_WEBSITE_EMAIL_ENABLED_ENV]: 'true',
  [APIFY_WEBSITE_EMAIL_PRICE_VERSION_ENV]: APIFY_WEBSITE_EMAIL_REQUIRED_PRICE_VERSION,
  [APIFY_WEBSITE_EMAIL_RETENTION_DAYS_ENV]: String(APIFY_WEBSITE_EMAIL_REQUIRED_RETENTION_DAYS),
}

const request: EnrichRequest = {
  signal_kind: 'contact_discovery',
  entity_unit: 'people',
  geography: 'US',
  channel: 'email',
  candidate: {
    entity_kind: 'person',
    identity: {
      name: 'Alex Rivera',
      company: 'Acme Industrial',
      domain: 'acme-industrial.com',
      urls: ['https://www.linkedin.com/in/alex-rivera'],
    },
  },
  max_charge_usd: APIFY_WEBSITE_EMAIL_PROVIDER_CAP_USD,
}

function page(url: string, text: string, overrides: Record<string, unknown> = {}) {
  return {
    url,
    crawl: {
      loadedUrl: url,
      loadedTime: '2026-08-23T21:59:00.000Z',
      httpStatusCode: 200,
    },
    text,
    ...overrides,
  }
}

function outcome(
  items: unknown[],
  overrides: Partial<ApifyRunOutcome> = {},
): ApifyRunOutcome {
  return {
    kind: items.length > 0 ? 'ok' : 'no_result',
    status: items.length > 0 ? 'ok' : 'no_result',
    items,
    actorId: APIFY_WEBSITE_EMAIL_ACTOR_ID,
    runId: RUN_ID,
    itemCount: items.length,
    httpStatus: 201,
    retryAfterSeconds: null,
    bodySnippet: null,
    requestUrl: 'https://api.apify.com/v2/acts/apify~website-content-crawler/runs?token=[redacted]',
    attemptedAt: CLOCK.toISOString(),
    error: null,
    billingFinalized: true,
    chargedEventCounts: {},
    providerCostUsd: 0.002,
    pricingModel: 'FREE',
    ...overrides,
  }
}

function response(status: number, value: unknown): ApifyFetchResponse {
  return {
    status,
    headers: { get: () => null },
    text: async () => (typeof value === 'string' ? value : JSON.stringify(value)),
  }
}

function sequentialFetch(responses: ApifyFetchResponse[]) {
  const calls: Array<{ url: string; init: ApifyFetchInit }> = []
  const fetchImpl: ApifyFetchLike = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error('unexpected fake request')
    return next
  }
  return { calls, fetchImpl }
}

function runRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    status: 'SUCCEEDED',
    defaultDatasetId: DATASET_ID,
    chargedEventCounts: {},
    usageTotalUsd: 0.002,
    pricingInfo: { pricingModel: 'FREE' },
    ...overrides,
  }
}

describe('Apify public website email adapter', () => {
  it('ships dark behind its own exact actor, terms, price, and account-retention gate', async () => {
    const runActor = jest.fn(async () => outcome([]))
    const adapter = createApifyWebsiteEmailAdapter({
      env: { ...ENABLED_ENV, [APIFY_WEBSITE_EMAIL_ENABLED_ENV]: 'false' },
      runActor,
      now,
    })

    expect(apifyWebsiteEmailEnabled({ ...ENABLED_ENV, [APIFY_WEBSITE_EMAIL_ENABLED_ENV]: 'false' })).toBe(false)
    expect(apifyWebsiteEmailEnabled({ ...ENABLED_ENV, [APIFY_WEBSITE_EMAIL_RETENTION_DAYS_ENV]: '90' })).toBe(false)
    expect(apifyWebsiteEmailDescriptor(ENABLED_ENV).constraints.license.retention_days)
      .toBe(APIFY_WEBSITE_EMAIL_REQUIRED_RETENTION_DAYS)
    await expect(adapter.enrich(request)).resolves.toMatchObject({
      status: 'error',
      cost_units: 0,
      error: expect.stringContaining('provider_disabled'),
    })
    expect(runActor).not.toHaveBeenCalled()
  })

  it('builds a five-page raw-HTTP crawl with robots, no proxy, no files, and no AI summary', () => {
    const website = normalizeCompanyWebsite('https://www.acme-industrial.com/contact')
    expect(website).not.toBeNull()
    expect(buildApifyWebsiteEmailInput(website!)).toMatchObject({
      startUrls: [{ url: 'https://www.acme-industrial.com/' }],
      crawlerType: 'cheerio',
      maxCrawlDepth: 1,
      maxCrawlPages: APIFY_WEBSITE_EMAIL_MAX_PAGES,
      maxResults: APIFY_WEBSITE_EMAIL_MAX_PAGES,
      initialConcurrency: 1,
      maxConcurrency: 1,
      useSitemaps: false,
      respectRobotsTxtFile: true,
      proxyConfiguration: { useApifyProxy: false },
      htmlTransformer: 'none',
      saveHtml: false,
      saveHtmlAsFile: false,
      saveMarkdown: false,
      saveScreenshots: false,
      saveFiles: false,
      summarize: false,
    })
  })

  it('returns only source-backed same-domain addresses and ranks a person match first', async () => {
    const runActor = jest.fn(async () => outcome([
      page(
        'https://www.acme-industrial.com/contact',
        'Email INFO@ACME-INDUSTRIAL.COM or alex.rivera@acme-industrial.com. '
          + 'Ignore external.person@gmail.com and noreply@acme-industrial.com.',
      ),
      page('https://acme-industrial.com/team', 'Team: arivera@acme-industrial.com'),
      page('https://other-company.com/contact', 'wrong@other-company.com'),
    ]))
    const adapter = createApifyWebsiteEmailAdapter({ env: ENABLED_ENV, runActor, now })

    const result = await adapter.enrich(request)

    expect(adapter.maxContactPointsPerCandidate).toBe(APIFY_WEBSITE_EMAIL_MAX_ADDRESSES)
    expect(result.status).toBe('ok')
    expect(result.cost_units).toBe(0.2)
    expect(result.data?.map((point) => point.value)).toEqual([
      'alex.rivera@acme-industrial.com',
      'arivera@acme-industrial.com',
      'info@acme-industrial.com',
    ])
    expect(result.data?.[0]?.provenance).toMatchObject({
      source: 'public_company_website',
      source_url: 'https://www.acme-industrial.com/contact',
      company_domain: 'acme-industrial.com',
      match_kind: 'person_name',
      page_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(result.receipt).toMatchObject({
      actor_id: APIFY_WEBSITE_EMAIL_ACTOR_ID,
      actor_build: APIFY_WEBSITE_EMAIL_ACTOR_BUILD,
      billing_finalized: true,
      pricing_model: 'FREE',
      provider_cost_usd: 0.002,
      pages_scoped: 2,
      pages_off_scope: 1,
      emails_found: 3,
    })
    const serializedReceipt = JSON.stringify(result.receipt)
    expect(serializedReceipt).not.toContain('alex.rivera@')
    expect(serializedReceipt).not.toContain('acme-industrial.com')
    expect(serializedReceipt).not.toContain(TOKEN)
  })

  it('charges finalized usage honestly when scoped pages contain no company-domain address', async () => {
    const adapter = createApifyWebsiteEmailAdapter({
      env: ENABLED_ENV,
      runActor: async () => outcome([
        page('https://acme-industrial.com/', 'Call us today. Email person@gmail.com.'),
      ], { providerCostUsd: 0.0015 }),
      now,
    })

    await expect(adapter.enrich(request)).resolves.toMatchObject({
      status: 'no_result',
      data: null,
      cost_units: 0.15,
      receipt: { pages_scoped: 1, emails_found: 0 },
    })
  })

  it('parks malformed billed rows instead of exposing partial schema drift', async () => {
    const adapter = createApifyWebsiteEmailAdapter({
      env: ENABLED_ENV,
      runActor: async () => outcome([{ url: 'https://acme-industrial.com/', text: 'a@acme-industrial.com' }]),
      now,
    })

    await expect(adapter.enrich(request)).resolves.toMatchObject({
      status: 'ambiguous',
      data: null,
      cost_units: null,
      error: expect.stringContaining('frozen output contract'),
    })
  })

  it('finalizes FREE platform usage before reading the bounded dataset', async () => {
    const run = runRecord()
    const { calls, fetchImpl } = sequentialFetch([
      response(201, { data: run }),
      response(200, { data: run }),
      response(200, [page('https://acme-industrial.com/team', 'alex@acme-industrial.com')]),
    ])
    const adapter = createApifyWebsiteEmailAdapter({
      env: ENABLED_ENV,
      fetchImpl,
      finalizationDelayMs: 0,
      sleep: async () => undefined,
      now,
    })

    const result = await adapter.enrich(request)

    expect(result.status).toBe('ok')
    expect(result.cost_units).toBe(0.2)
    expect(calls).toHaveLength(3)
    const startUrl = new URL(calls[0].url)
    expect(startUrl.pathname).toContain('/acts/apify~website-content-crawler/runs')
    expect(startUrl.searchParams.get('build')).toBe(APIFY_WEBSITE_EMAIL_ACTOR_BUILD)
    expect(startUrl.searchParams.get('memory')).toBe(String(APIFY_WEBSITE_EMAIL_MEMORY_MBYTES))
    expect(startUrl.searchParams.get('maxTotalChargeUsd')).toBe('0.01')
    expect(calls[2].url).toContain('fields=url%2Ccrawl%2Ctext')
    expect(calls.every((call) => !call.url.includes(TOKEN))).toBe(true)
  })

  it('parks pricing-model drift and never reads the dataset', async () => {
    const changed = runRecord({
      usageTotalUsd: 0.004,
      chargedEventCounts: { result: 1 },
      pricingInfo: {
        pricingModel: 'PAY_PER_EVENT',
        pricingPerEvent: { actorChargeEvents: { result: { eventPriceUsd: 0.004 } } },
      },
    })
    const { calls, fetchImpl } = sequentialFetch([
      response(201, { data: changed }),
      response(200, { data: changed }),
    ])
    const adapter = createApifyWebsiteEmailAdapter({
      env: ENABLED_ENV,
      fetchImpl,
      finalizationDelayMs: 0,
      sleep: async () => undefined,
      now,
    })

    await expect(adapter.enrich(request)).resolves.toMatchObject({
      status: 'ambiguous',
      data: null,
      cost_units: null,
      error: expect.stringContaining('finalized billing evidence'),
      receipt: expect.objectContaining({
        billing_finalized: true,
        charged_event_counts: { result: 1 },
        provider_cost_usd: 0.004,
        pricing_model: 'PAY_PER_EVENT',
      }),
    })
    expect(calls).toHaveLength(2)
  })

  it('parks a finalized dataset beyond the one-megabyte response ceiling', async () => {
    const run = runRecord()
    const oversized = JSON.stringify([
      page('https://acme-industrial.com/', 'x'.repeat(APIFY_WEBSITE_EMAIL_DATASET_BYTES + 1)),
    ])
    const { calls, fetchImpl } = sequentialFetch([
      response(201, { data: run }),
      response(200, { data: run }),
      response(200, oversized),
    ])
    const adapter = createApifyWebsiteEmailAdapter({
      env: ENABLED_ENV,
      fetchImpl,
      finalizationDelayMs: 0,
      sleep: async () => undefined,
      now,
    })

    await expect(adapter.enrich(request)).resolves.toMatchObject({
      status: 'ambiguous',
      data: null,
      cost_units: null,
      error: expect.stringContaining('byte ceiling'),
    })
    expect(calls).toHaveLength(3)
  })

  it('settles the exact finalized usage through the canonical waterfall wrapper', async () => {
    const adapter = createApifyWebsiteEmailAdapter({
      env: ENABLED_ENV,
      runActor: async (_actorId, _input, options) => {
        expect(options).toMatchObject({
          build: APIFY_WEBSITE_EMAIL_ACTOR_BUILD,
          maxChargeUsd: APIFY_WEBSITE_EMAIL_PROVIDER_CAP_USD,
          memoryMbytes: APIFY_WEBSITE_EMAIL_MEMORY_MBYTES,
          maxDatasetBodyBytes: APIFY_WEBSITE_EMAIL_DATASET_BYTES,
        })
        return outcome([
          page('https://acme-industrial.com/team', 'alex.rivera@acme-industrial.com'),
        ], { providerCostUsd: 0.002 })
      },
      now,
    })
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 1_000_000 })
    const candidate = em.create(GtmCandidate, {
      organizationId: 'org-1',
      tenantId: 'tenant-1',
      researchRunId: 'run-1',
      workspaceId: 'workspace-1',
      entityKind: 'person',
      identity: request.candidate.identity,
      dedupeKey: 'alex-rivera',
      fitStatus: 'accepted',
    })
    em.persist(candidate)
    await em.flush()

    const summary = await runEnrichmentWaterfall({
      em,
      ledger,
      enrichAdapters: [adapter],
      verifyAdapters: [],
      candidates: [candidate],
      contactPoints: [],
      noliOrgId: 'noli-org-1',
      noliUserId: 'noli-user-1',
      runId: 'run-1',
      markupMultiplier: 2,
      now,
    })

    expect(summary).toMatchObject({ enriched: 1, credits: 1_000, ambiguous: 0 })
    expect(ledger.listOperations()[0]).toMatchObject({
      estimatedCredits: 5_000,
      chargedCredits: 1_000,
      status: 'charged',
      idempotencyKey: expect.stringMatching(/^enrich:.+:apify-public-website-email:[a-f0-9]{64}$/),
    })
    expect(em.table(GtmContactPoint)).toHaveLength(1)
  })
})
