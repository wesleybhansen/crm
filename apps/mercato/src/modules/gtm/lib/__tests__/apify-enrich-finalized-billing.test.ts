import type {
  ApifyFetchInit,
  ApifyFetchLike,
  ApifyFetchResponse,
} from '../adapters/apify/client'
import {
  APIFY_ENRICH_BILLING_CONTRACT_VERSION,
  APIFY_ENRICH_EVENT_PRICES_USD,
  createApifyEnrichAdapter,
} from '../adapters/apify/enrich'
import {
  APIFY_REQUIRED_PRICE_VERSION,
  APIFY_REQUIRED_TERMS_VERSION,
} from '../adapters/apify/source'
import type { EnrichRequest } from '../adapters/types'
import { FixtureLedger } from '../credits/ledger'
import { runEnrichmentWaterfall } from '../enrich/waterfall'
import { GtmCandidate, GtmContactPoint } from '../../data/entities'
import { FakeEm } from './support/fake-em'

const TOKEN = 'apify_test_token_never_logged'
const PROFILE_URL = 'https://www.linkedin.com/in/example-owner'
const RUN_ID = 'apify-run-1'
const DATASET_ID = 'apify-dataset-1'
const CLOCK = new Date('2026-08-23T20:37:01.000Z')
const now = () => CLOCK

const ENABLED_ENV = {
  GTM_APIFY_ENABLED: 'true',
  GTM_APIFY_ACCOUNT_TIER: 'BRONZE',
  GTM_APIFY_TOKEN: TOKEN,
  GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
  GTM_APIFY_TERMS_VERSION: APIFY_REQUIRED_TERMS_VERSION,
  GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
}

const request: EnrichRequest = {
  signal_kind: 'contact_discovery',
  entity_unit: 'people',
  geography: 'US',
  channel: 'email',
  candidate: {
    entity_kind: 'person',
    identity: { name: 'Example Owner', urls: [PROFILE_URL] },
  },
}

function profile(emails: string[] = []) {
  return {
    id: 'synthetic-profile',
    publicIdentifier: 'example-owner',
    linkedinUrl: PROFILE_URL,
    firstName: 'Example',
    lastName: 'Owner',
    emails,
    currentPosition: [{ companyName: 'Example Dental', position: 'Office Manager' }],
  }
}

function runRecord(
  chargedEventCounts: Record<string, number>,
  usageTotalUsd: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: RUN_ID,
    status: 'SUCCEEDED',
    defaultDatasetId: DATASET_ID,
    chargedEventCounts,
    usageTotalUsd,
    pricingInfo: {
      pricingModel: 'PAY_PER_EVENT',
      pricingPerEvent: {
        actorChargeEvents: {
          profile: { eventPriceUsd: APIFY_ENRICH_EVENT_PRICES_USD.profile },
          profile_with_email: {
            eventPriceUsd: APIFY_ENRICH_EVENT_PRICES_USD.profile_with_email,
          },
        },
      },
    },
    ...overrides,
  }
}

type FakeCall = { url: string; init: ApifyFetchInit }

function response(status: number, value: unknown): ApifyFetchResponse {
  return {
    status,
    headers: { get: () => null },
    text: async () => (typeof value === 'string' ? value : JSON.stringify(value)),
  }
}

function sequentialFetch(responses: ApifyFetchResponse[]): {
  fetchImpl: ApifyFetchLike
  calls: FakeCall[]
} {
  const calls: FakeCall[] = []
  const fetchImpl: ApifyFetchLike = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error('unexpected fake request')
    return next
  }
  return { fetchImpl, calls }
}

function finalizedAdapter(responses: ApifyFetchResponse[]) {
  const { fetchImpl, calls } = sequentialFetch(responses)
  const adapter = createApifyEnrichAdapter({
    env: ENABLED_ENV,
    now,
    fetchImpl,
    finalizationDelayMs: 0,
    sleep: async () => undefined,
  })
  return { adapter, calls }
}

describe('Apify profile enrichment finalized billing', () => {
  it('settles the observed profile-only event at $0.004 instead of the $0.01 ceiling', async () => {
    const run = runRecord({ profile: 1, profile_with_email: 0 }, 0.004)
    const { adapter, calls } = finalizedAdapter([
      response(201, {
        data: { id: RUN_ID, status: 'SUCCEEDED', defaultDatasetId: DATASET_ID },
      }),
      response(200, { data: run }),
      response(200, [profile([])]),
    ])

    const result = await adapter.enrich(request)

    expect(result.status).toBe('no_result')
    expect(result.cost_units).toBe(0.4)
    expect(result.receipt).toMatchObject({
      run_id: RUN_ID,
      billing_contract_version: APIFY_ENRICH_BILLING_CONTRACT_VERSION,
      billing_finalized: true,
      charged_event_counts: { profile: 1, profile_with_email: 0 },
      provider_cost_usd: 0.004,
      pricing_model: 'PAY_PER_EVENT',
      emails_found: 0,
    })
    expect(calls).toHaveLength(3)
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].url).toContain('/acts/harvestapi~linkedin-profile-scraper/runs?')
    expect(new URL(calls[0].url).searchParams.get('maxTotalChargeUsd')).toBe('0.01')
    expect(calls[1].url).toContain(`/actor-runs/${RUN_ID}`)
    expect(calls[2].url).toContain(`/datasets/${DATASET_ID}/items`)
    expect(calls.every((call) => !call.url.includes(TOKEN))).toBe(true)
    expect(JSON.stringify(result.receipt)).not.toContain(TOKEN)
  })

  it('re-reads the same terminal run when usage lags finalized event counts', async () => {
    const staleUsage = runRecord({ profile: 1, profile_with_email: 0 }, 0)
    const finalized = runRecord({ profile: 1, profile_with_email: 0 }, 0.004)
    const { adapter, calls } = finalizedAdapter([
      response(201, {
        data: { id: RUN_ID, status: 'SUCCEEDED', defaultDatasetId: DATASET_ID },
      }),
      response(200, { data: staleUsage }),
      response(200, { data: finalized }),
      response(200, [profile([])]),
    ])

    const result = await adapter.enrich(request)

    expect(result.status).toBe('no_result')
    expect(result.cost_units).toBe(0.4)
    expect(result.receipt).toMatchObject({
      run_id: RUN_ID,
      billing_finalized: true,
      provider_cost_usd: 0.004,
      charged_event_counts: { profile: 1, profile_with_email: 0 },
    })
    expect(calls).toHaveLength(4)
    expect(calls[1].url).toContain(`/actor-runs/${RUN_ID}`)
    expect(calls[2].url).toContain(`/actor-runs/${RUN_ID}`)
    expect(calls[3].url).toContain(`/datasets/${DATASET_ID}/items`)
    expect(calls.filter((call) => call.init.method === 'POST')).toHaveLength(1)
  })

  it('charges exactly 2,000 credits after markup for the finalized profile-only miss', async () => {
    const run = runRecord({ profile: 1, profile_with_email: 0 }, 0.004)
    const { adapter } = finalizedAdapter([
      response(201, { data: run }),
      response(200, { data: run }),
      response(200, [profile([])]),
    ])
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 1_000_000 })
    const candidate = em.create(GtmCandidate, {
      organizationId: 'org-1',
      tenantId: 'tenant-1',
      researchRunId: 'run-1',
      workspaceId: 'workspace-1',
      entityKind: 'person',
      identity: { name: 'Example Owner', urls: [PROFILE_URL] },
      dedupeKey: 'example-owner',
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
      userId: 'crm-user-1',
      noliOrgId: 'noli-org-1',
      noliUserId: 'noli-user-1',
      runId: 'run-1',
      markupMultiplier: 2,
      now,
    })

    expect(summary.enriched).toBe(0)
    expect(summary.credits).toBe(2_000)
    expect(ledger.listOperations()[0]).toMatchObject({
      status: 'charged',
      estimatedCredits: 5_000,
      chargedCredits: 2_000,
    })
    expect(em.table(GtmContactPoint)).toHaveLength(0)
  })

  it('refunds a definitive zero-event, zero-row run instead of inventing a charge', async () => {
    const run = runRecord({ profile: 0, profile_with_email: 0 }, 0)
    const { adapter } = finalizedAdapter([
      response(201, { data: run }),
      response(200, { data: run }),
      response(200, []),
    ])
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 1_000_000 })
    const candidate = em.create(GtmCandidate, {
      organizationId: 'org-1',
      tenantId: 'tenant-1',
      researchRunId: 'run-1',
      workspaceId: 'workspace-1',
      entityKind: 'person',
      identity: { name: 'Example Owner', urls: [PROFILE_URL] },
      dedupeKey: 'example-owner-zero',
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
      userId: 'crm-user-1',
      noliOrgId: 'noli-org-1',
      noliUserId: 'noli-user-1',
      runId: 'run-1',
      markupMultiplier: 2,
      now,
    })

    expect(summary.credits).toBe(0)
    expect(ledger.listOperations()[0]).toMatchObject({
      status: 'refunded',
      estimatedCredits: 5_000,
      chargedCredits: 0,
    })
  })

  it('settles one frozen email-search event when an address is actually returned', async () => {
    const run = runRecord({ profile: 0, profile_with_email: 1 }, 0.01)
    const { adapter } = finalizedAdapter([
      response(201, { data: run }),
      response(200, { data: run }),
      response(200, [profile(['owner@example-dental.test'])]),
    ])

    const result = await adapter.enrich(request)

    expect(result.status).toBe('ok')
    expect(result.cost_units).toBe(1)
    expect(result.data).toHaveLength(1)
    expect(result.receipt).toMatchObject({
      charged_event_counts: { profile: 0, profile_with_email: 1 },
      provider_cost_usd: 0.01,
      emails_found: 1,
    })
  })

  it('parks price drift before reading or exposing the dataset', async () => {
    const changed = runRecord({ profile: 1 }, 0.005, {
      pricingInfo: {
        pricingModel: 'PAY_PER_EVENT',
        pricingPerEvent: {
          actorChargeEvents: {
            profile: { eventPriceUsd: 0.005 },
            profile_with_email: { eventPriceUsd: 0.01 },
          },
        },
      },
    })
    const { adapter, calls } = finalizedAdapter([
      response(201, { data: changed }),
      response(200, { data: changed }),
    ])

    const result = await adapter.enrich(request)

    expect(result.status).toBe('ambiguous')
    expect(result.cost_units).toBeNull()
    expect(result.data).toBeNull()
    expect(result.error).toContain('finalized billing evidence')
    expect(result.receipt).toMatchObject({
      billing_finalized: true,
      charged_event_counts: { profile: 1 },
      provider_cost_usd: 0.005,
      pricing_model: 'PAY_PER_EVENT',
    })
    expect(calls).toHaveLength(2)
  })

  it('parks a successful run whose returned email lacks an email-search charge event', async () => {
    const run = runRecord({ profile: 1, profile_with_email: 0 }, 0.004)
    const { adapter } = finalizedAdapter([
      response(201, { data: run }),
      response(200, { data: run }),
      response(200, [profile(['owner@example-dental.test'])]),
    ])

    const result = await adapter.enrich(request)

    expect(result.status).toBe('ambiguous')
    expect(result.data).toBeNull()
    expect(result.cost_units).toBeNull()
    expect(result.error).toContain('returned email lacks its frozen billing event')
  })

  it.each([
    [{ profile: 0, profile_with_email: 0 }, 0],
    [{ profile: 2, profile_with_email: 0 }, 0.008],
  ])(
    'parks a returned profile when billed event cardinality is outside the one-profile contract',
    async (counts, totalUsd) => {
      const run = runRecord(counts, totalUsd)
      const { adapter } = finalizedAdapter([
        response(201, { data: run }),
        response(200, { data: run }),
        response(200, [profile([])]),
      ])

      const result = await adapter.enrich(request)

      expect(result.status).toBe('ambiguous')
      expect(result.data).toBeNull()
      expect(result.cost_units).toBeNull()
      expect(result.error).toContain('finalized billing evidence')
    },
  )

  it('retains the run id and parks when the bounded wait ends before completion', async () => {
    const running = runRecord({}, 0, { status: 'RUNNING' })
    const { adapter, calls } = finalizedAdapter([response(201, { data: running })])

    const result = await adapter.enrich(request)

    expect(result.status).toBe('ambiguous')
    expect(result.receipt).toMatchObject({ run_id: RUN_ID, billing_finalized: false })
    expect(result.error).toContain('RUNNING')
    expect(calls).toHaveLength(1)
  })
})
