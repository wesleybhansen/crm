import type { SourceSearchPlan } from '../adapters/types'
import type { ApifyRunOutcome } from '../adapters/apify/client'
import {
  APIFY_COMPANY_ACTOR_START_USD,
  APIFY_COMPANY_FULL_RESULT_USD,
  APIFY_COMPANY_PRICE_VERSION_ENV,
  APIFY_COMPANY_REQUIRED_PRICE_VERSION,
  APIFY_COMPANY_SOURCE_ACTOR_ENV,
  APIFY_COMPANY_SOURCE_ACTOR_ID,
  APIFY_COMPANY_SOURCE_ADAPTER_ID,
  APIFY_COMPANY_SOURCE_BUILD,
  APIFY_COMPANY_START_UNITS,
  apifyCompanySourceApproved,
  buildApifyCompanySearchInput,
  createApifyCompanySourceAdapter,
  normalizeApifyCompanyItem,
} from '../adapters/apify/company-source'
import {
  APIFY_REQUIRED_PRICE_VERSION,
  APIFY_REQUIRED_TERMS_VERSION,
} from '../adapters/apify/source'

const TOKEN = 'synthetic-apify-company-token'
const CLOCK = new Date('2026-08-22T12:00:00.000Z')
const now = () => CLOCK

const ENABLED_ENV = {
  GTM_APIFY_ENABLED: 'true',
  GTM_APIFY_TOKEN: TOKEN,
  GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
  GTM_APIFY_TERMS_VERSION: APIFY_REQUIRED_TERMS_VERSION,
  GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
  [APIFY_COMPANY_PRICE_VERSION_ENV]: APIFY_COMPANY_REQUIRED_PRICE_VERSION,
}

const PLAN: SourceSearchPlan = {
  signal_kind: 'firmographic_match',
  entity_unit: 'companies',
  geography: 'US',
  query: 'small dental practices San Diego California',
  provider_query: {
    company_keywords: ['dental clinic', 'medical practice'],
    industries: ['Dentistry'],
    employee_ranges: ['1-10 employees', '11-50'],
    locations: ['San Diego, California', 'Phoenix, Arizona'],
  },
  max_candidates: 25,
  max_charge_usd: 0.101,
}

function outcome(
  values: Partial<ApifyRunOutcome> = {},
): ApifyRunOutcome {
  return {
    kind: 'ok',
    status: 'ok',
    items: [],
    actorId: APIFY_COMPANY_SOURCE_ACTOR_ID,
    runId: null,
    itemCount: 0,
    httpStatus: 201,
    retryAfterSeconds: null,
    bodySnippet: null,
    requestUrl: 'https://api.apify.com/v2/acts/harvestapi~linkedin-company-search/run-sync-get-dataset-items?token=[redacted]',
    attemptedAt: CLOCK.toISOString(),
    error: null,
    ...values,
  }
}

function companyItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'company-123',
    universalName: 'example-dental',
    linkedinUrl: 'https://www.linkedin.com/company/example-dental/',
    name: 'Example Dental',
    website: 'https://www.exampledental.test/',
    employeeCount: 17,
    employeeCountRange: { start: 11, end: 50 },
    description: 'A community dental practice.',
    locations: [{
      country: 'US',
      city: 'San Diego',
      geographicArea: 'California',
      headquarter: true,
      parsed: {
        text: 'San Diego, California, United States',
        countryCode: 'US',
        state: 'California',
        city: 'San Diego',
      },
    }],
    industries: [{ id: '13', name: 'Medical Practices' }],
    pageVerified: true,
    ...overrides,
  }
}

describe('Apify LinkedIn company source contract', () => {
  it('requires the exact actor, general stack, and company price versions', () => {
    expect(apifyCompanySourceApproved(ENABLED_ENV)).toBe(true)
    expect(apifyCompanySourceApproved({
      ...ENABLED_ENV,
      [APIFY_COMPANY_PRICE_VERSION_ENV]: 'stale-price',
    })).toBe(false)
    expect(apifyCompanySourceApproved({
      ...ENABLED_ENV,
      [APIFY_COMPANY_SOURCE_ACTOR_ENV]: 'someone/another-actor',
    })).toBe(false)
  })

  it('freezes the actor build and conservative pay-per-event price', () => {
    const descriptor = createApifyCompanySourceAdapter({ env: ENABLED_ENV, now }).descriptor
    expect(descriptor).toEqual(expect.objectContaining({
      adapter_id: APIFY_COMPANY_SOURCE_ADAPTER_ID,
      layer: 'source',
      cost_model: expect.objectContaining({
        unit: 'full_company',
        quoted_credits_per_unit: 1_000,
        pay_on_found: false,
        price_version: APIFY_COMPANY_REQUIRED_PRICE_VERSION,
      }),
    }))
    expect(APIFY_COMPANY_SOURCE_BUILD).toBe('0.0.17')
    expect(APIFY_COMPANY_FULL_RESULT_USD).toBe(0.004)
    expect(APIFY_COMPANY_ACTOR_START_USD).toBe(0.001)
    expect(APIFY_COMPANY_START_UNITS).toBe(0.25)
  })

  it('quotes every possible result plus the fixed actor-start event', () => {
    const quote = createApifyCompanySourceAdapter({ env: ENABLED_ENV, now }).quote(PLAN)
    expect(quote).toEqual(expect.objectContaining({
      max_candidates: 25,
      provider_units: 25.25,
      billable_unit: 'full_company',
      estimated_credits_before_markup: 25_250,
    }))
  })

  it('maps only supported filters into the frozen full-search input', () => {
    expect(buildApifyCompanySearchInput(PLAN)).toEqual({
      scraperMode: 'full',
      maxItems: 25,
      searchQuery: '"dental clinic" OR "medical practice"',
      locations: ['San Diego, California', 'Phoenix, Arizona'],
      companySize: ['1-10', '11-50'],
      startPage: 1,
      takePages: 1,
    })
  })

  it('normalizes exact company firmographics and a public evidence URL', () => {
    const candidate = normalizeApifyCompanyItem(companyItem(), CLOCK.toISOString())
    expect(candidate).toEqual(expect.objectContaining({
      entity_kind: 'company',
      identity: expect.objectContaining({
        name: 'Example Dental',
        domain: 'exampledental.test',
        industry: 'Medical Practices',
        employee_count: 17,
        employee_range: '11-50',
        location: 'San Diego, California, United States',
        city: 'San Diego',
        region: 'California',
        country_code: 'US',
      }),
    }))
    expect(candidate?.evidence[0]).toEqual(expect.objectContaining({
      source_url: 'https://www.linkedin.com/company/example-dental/',
      observed_at: CLOCK.toISOString(),
      confidence: 0.9,
    }))
  })

  it('selects the returned office that proves the frozen target location', () => {
    const candidate = normalizeApifyCompanyItem(companyItem({
      locations: [
        {
          country: 'US', city: 'Austin', geographicArea: 'Texas', headquarter: true,
          parsed: { text: 'Austin, Texas, United States', countryCode: 'US', state: 'Texas', city: 'Austin' },
        },
        {
          country: 'US', city: 'San Diego', geographicArea: 'California', headquarter: false,
          parsed: { text: 'San Diego, California, United States', countryCode: 'US', state: 'California', city: 'San Diego' },
        },
      ],
    }), CLOCK.toISOString(), ['San Diego, California'])
    expect(candidate?.identity).toEqual(expect.objectContaining({
      location: 'San Diego, California, United States',
      city: 'San Diego',
      region: 'California',
    }))
  })

  it('rejects a non-LinkedIn evidence URL before it becomes a candidate', () => {
    expect(normalizeApifyCompanyItem(companyItem({
      linkedinUrl: 'https://example.test/company/example-dental',
    }), CLOCK.toISOString())).toBeNull()
  })

  it('executes one bounded actor call and settles returned rows plus the start event', async () => {
    const calls: Array<{ input: Record<string, unknown>; options: Record<string, unknown> }> = []
    const item = companyItem()
    const adapter = createApifyCompanySourceAdapter({
      env: ENABLED_ENV,
      now,
      runActor: async (_actorId, input, options) => {
        calls.push({ input, options })
        return outcome({ items: [item], itemCount: 1 })
      },
    })
    const result = await adapter.search(PLAN)
    expect(result).toEqual(expect.objectContaining({
      status: 'ok',
      cost_units: 1.25,
      data: [expect.objectContaining({ entity_kind: 'company' })],
      receipt: expect.objectContaining({
        actor_id: APIFY_COMPANY_SOURCE_ACTOR_ID,
        actor_build: APIFY_COMPANY_SOURCE_BUILD,
        item_count: 1,
        actor_start_billed: true,
        max_charge_usd: 0.101,
      }),
    }))
    expect(calls).toHaveLength(1)
    expect(calls[0].input).toEqual(expect.objectContaining({ maxItems: 25, scraperMode: 'full' }))
    expect(calls[0].options).toEqual(expect.objectContaining({
      build: APIFY_COMPANY_SOURCE_BUILD,
      maxItems: 25,
      maxChargeUsd: 0.101,
    }))
  })

  it('charges only the fixed start event on a definitive empty run', async () => {
    const adapter = createApifyCompanySourceAdapter({
      env: ENABLED_ENV,
      now,
      runActor: async () => outcome({
        kind: 'no_result', status: 'no_result', items: [], itemCount: 0,
      }),
    })
    await expect(adapter.search(PLAN)).resolves.toEqual(expect.objectContaining({
      status: 'no_result',
      cost_units: 0.25,
      receipt: expect.objectContaining({ actor_start_billed: true }),
    }))
  })

  it('parks transport ambiguity without guessing the actor charge', async () => {
    const adapter = createApifyCompanySourceAdapter({
      env: ENABLED_ENV,
      now,
      runActor: async () => outcome({
        kind: 'transport_unknown',
        status: 'ambiguous',
        items: [],
        itemCount: 0,
        httpStatus: null,
        error: 'transport_unknown',
      }),
    })
    await expect(adapter.search(PLAN)).resolves.toEqual(expect.objectContaining({
      status: 'ambiguous', cost_units: null,
    }))
  })

  it('never contacts an actor when the company-specific contract is absent', async () => {
    const runActor = jest.fn()
    const adapter = createApifyCompanySourceAdapter({
      env: {
        ...ENABLED_ENV,
        [APIFY_COMPANY_PRICE_VERSION_ENV]: undefined,
      },
      now,
      runActor,
    })
    await expect(adapter.search(PLAN)).resolves.toEqual(expect.objectContaining({
      status: 'error', cost_units: 0,
    }))
    expect(runActor).not.toHaveBeenCalled()
  })
})
