import type { ApifyRunOutcome } from '../adapters/apify/client'
import {
  APIFY_COMPANY_EMPLOYEES_ACTOR_ENV,
  APIFY_COMPANY_EMPLOYEES_ACTOR_ID,
  APIFY_COMPANY_EMPLOYEES_ACTOR_START_USD,
  APIFY_COMPANY_EMPLOYEES_ADAPTER_ID,
  APIFY_COMPANY_EMPLOYEES_BASIC_PROFILE_USD,
  APIFY_COMPANY_EMPLOYEES_MIN_CHARGE_UNITS,
  APIFY_COMPANY_EMPLOYEES_MIN_CHARGE_USD,
  APIFY_COMPANY_EMPLOYEES_PRICE_VERSION_ENV,
  APIFY_COMPANY_EMPLOYEES_PROFILE_MODE,
  APIFY_COMPANY_EMPLOYEES_PROFILE_UNITS,
  APIFY_COMPANY_EMPLOYEES_QUOTED_PROFILE_USD,
  APIFY_COMPANY_EMPLOYEES_REQUIRED_PRICE_VERSION,
  APIFY_COMPANY_EMPLOYEES_SIGNAL,
  APIFY_COMPANY_EMPLOYEES_START_UNITS,
  apifyCompanyEmployeesApproved,
  buildApifyCompanyEmployeesInput,
  createApifyCompanyEmployeesAdapter,
  normalizeApifyCompanyEmployeeItem,
  type DecisionMakerResolvePlan,
} from '../adapters/apify/company-employees'
import {
  APIFY_REQUIRED_PRICE_VERSION,
  APIFY_REQUIRED_TERMS_VERSION,
} from '../adapters/apify/source'

const CLOCK = new Date('2026-08-22T20:00:00.000Z')
const now = () => CLOCK

const ENABLED_ENV = {
  GTM_APIFY_ENABLED: 'true',
  GTM_APIFY_TOKEN: 'synthetic-company-employees-token',
  GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
  GTM_APIFY_TERMS_VERSION: APIFY_REQUIRED_TERMS_VERSION,
  GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
  [APIFY_COMPANY_EMPLOYEES_PRICE_VERSION_ENV]:
    APIFY_COMPANY_EMPLOYEES_REQUIRED_PRICE_VERSION,
}

const COMPANIES = [{
  candidate_id: '10000000-0000-4000-8000-000000000001',
  match_id: '20000000-0000-4000-8000-000000000001',
  name: 'Example Dental',
  linkedin_url: 'https://www.linkedin.com/company/example-dental/',
}]

const PLAN: DecisionMakerResolvePlan = {
  signal_kind: APIFY_COMPANY_EMPLOYEES_SIGNAL,
  entity_unit: 'people',
  geography: 'US',
  companies: COMPANIES,
  job_titles: ['Owner', 'Practice Owner', 'Founder'],
  max_profiles: 5,
  max_charge_usd: 0.05,
}

function outcome(values: Partial<ApifyRunOutcome> = {}): ApifyRunOutcome {
  return {
    kind: 'ok',
    status: 'ok',
    items: [],
    actorId: APIFY_COMPANY_EMPLOYEES_ACTOR_ID,
    runId: null,
    itemCount: 0,
    httpStatus: 201,
    retryAfterSeconds: null,
    bodySnippet: null,
    requestUrl:
      'https://api.apify.com/v2/acts/harvestapi~linkedin-company-employees/run-sync-get-dataset-items?token=[redacted]',
    attemptedAt: CLOCK.toISOString(),
    error: null,
    ...values,
  }
}

function employeeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'person-123',
    linkedinUrl: 'https://www.linkedin.com/in/alex-example/',
    firstName: 'Alex',
    lastName: 'Example',
    headline: 'Practice owner and dentist',
    location: {
      linkedinText: 'San Diego, California, United States',
      parsed: {
        text: 'San Diego, CA, United States',
        countryCode: 'US',
        state: 'California',
        city: 'San Diego',
      },
    },
    currentPosition: [{
      position: 'Practice Owner',
      companyName: 'Example Dental',
      companyLinkedinUrl: 'https://www.linkedin.com/company/example-dental/',
    }],
    ...overrides,
  }
}

describe('Apify company-employees decision-maker contract', () => {
  it('requires the exact actor and company-employees price version', () => {
    expect(apifyCompanyEmployeesApproved(ENABLED_ENV)).toBe(true)
    expect(apifyCompanyEmployeesApproved({
      ...ENABLED_ENV,
      [APIFY_COMPANY_EMPLOYEES_PRICE_VERSION_ENV]: 'stale',
    })).toBe(false)
    expect(apifyCompanyEmployeesApproved({
      ...ENABLED_ENV,
      [APIFY_COMPANY_EMPLOYEES_ACTOR_ENV]: 'someone/another-actor',
    })).toBe(false)
  })

  it('reserves the provider minimum while settling at the conservative profile price', () => {
    const adapter = createApifyCompanyEmployeesAdapter({ env: ENABLED_ENV, now })
    expect(adapter.descriptor).toEqual(expect.objectContaining({
      adapter_id: APIFY_COMPANY_EMPLOYEES_ADAPTER_ID,
      layer: 'source',
      cost_model: expect.objectContaining({
        unit: 'apify_millidollar',
        quoted_credits_per_unit: 250,
        price_version: APIFY_COMPANY_EMPLOYEES_REQUIRED_PRICE_VERSION,
        pay_on_found: false,
      }),
    }))
    expect(APIFY_COMPANY_EMPLOYEES_BASIC_PROFILE_USD).toBe(0.003)
    expect(APIFY_COMPANY_EMPLOYEES_QUOTED_PROFILE_USD).toBe(0.004)
    expect(APIFY_COMPANY_EMPLOYEES_ACTOR_START_USD).toBe(0.02)
    expect(APIFY_COMPANY_EMPLOYEES_MIN_CHARGE_USD).toBe(0.05)
    expect(APIFY_COMPANY_EMPLOYEES_PROFILE_UNITS).toBe(4)
    expect(APIFY_COMPANY_EMPLOYEES_START_UNITS).toBe(20)
    expect(APIFY_COMPANY_EMPLOYEES_MIN_CHARGE_UNITS).toBe(50)
    expect(adapter.quote(PLAN)).toEqual({
      max_companies: 1,
      max_profiles: 5,
      provider_units: 50,
      billable_unit: 'apify_millidollar',
      quoted_credits_per_unit: 250,
      estimated_credits_before_markup: 12_500,
    })
    expect(adapter.quote({ ...PLAN, max_profiles: 25 })).toEqual(expect.objectContaining({
      provider_units: 120,
      estimated_credits_before_markup: 30_000,
    }))
  })

  it('builds only the bounded all-at-once Basic request', () => {
    expect(buildApifyCompanyEmployeesInput(PLAN)).toEqual({
      profileScraperMode: APIFY_COMPANY_EMPLOYEES_PROFILE_MODE,
      maxItems: 5,
      companies: ['https://www.linkedin.com/company/example-dental/'],
      jobTitles: ['Owner', 'Practice Owner', 'Founder'],
      companyBatchMode: 'all_at_once',
      startPage: 1,
      takePages: 1,
    })
  })

  it('normalizes only a person currently bound to an exact submitted company', () => {
    expect(normalizeApifyCompanyEmployeeItem(
      employeeItem(),
      CLOCK.toISOString(),
      COMPANIES,
    )).toEqual(expect.objectContaining({
      parent_company_url: COMPANIES[0].linkedin_url,
      current_title: 'Practice Owner',
      candidate: expect.objectContaining({
        entity_kind: 'person',
        identity: expect.objectContaining({
          name: 'Alex Example',
          company: 'Example Dental',
          title: 'Practice Owner',
          urls: ['https://www.linkedin.com/in/alex-example/'],
          country_code: 'US',
        }),
      }),
    }))
    expect(normalizeApifyCompanyEmployeeItem(employeeItem({
      currentPosition: [{
        position: 'Owner',
        companyName: 'Another Company',
        companyLinkedinUrl: 'https://www.linkedin.com/company/another-company/',
      }],
    }), CLOCK.toISOString(), COMPANIES)).toBeNull()
  })

  it('executes once, excludes raw body data, and charges returned profiles plus one start', async () => {
    const runActor = jest.fn(async () => outcome({
      items: [employeeItem()],
      itemCount: 1,
      bodySnippet: '[{"about":"synthetic personal biography"}]',
    }))
    const result = await createApifyCompanyEmployeesAdapter({
      env: ENABLED_ENV,
      now,
      runActor,
    }).resolve(PLAN)
    expect(runActor).toHaveBeenCalledTimes(1)
    expect(runActor.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      profileScraperMode: APIFY_COMPANY_EMPLOYEES_PROFILE_MODE,
      maxItems: 5,
      companyBatchMode: 'all_at_once',
    }))
    expect(runActor.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      maxItems: 5,
      maxChargeUsd: 0.05,
    }))
    expect(result).toEqual(expect.objectContaining({
      status: 'ok',
      cost_units: 24,
      data: [expect.objectContaining({ current_title: 'Practice Owner' })],
      receipt: expect.objectContaining({
        actor_id: APIFY_COMPANY_EMPLOYEES_ACTOR_ID,
        profile_mode: APIFY_COMPANY_EMPLOYEES_PROFILE_MODE,
        actor_start_billed: true,
        item_count: 1,
      }),
    }))
    expect(result.receipt).not.toHaveProperty('body_snippet')
  })

  it('charges only the start on a definitive empty run', async () => {
    const result = await createApifyCompanyEmployeesAdapter({
      env: ENABLED_ENV,
      now,
      runActor: async () => outcome({
        kind: 'no_result', status: 'no_result', items: [], itemCount: 0,
      }),
    }).resolve(PLAN)
    expect(result).toEqual(expect.objectContaining({
      status: 'no_result',
      cost_units: 20,
      receipt: expect.objectContaining({ actor_start_billed: true }),
    }))
  })

  it('parks parser drift and transport uncertainty without exposing output or guessing spend', async () => {
    const invalid = await createApifyCompanyEmployeesAdapter({
      env: ENABLED_ENV,
      now,
      runActor: async () => outcome({ items: [{ unexpected: true }], itemCount: 1 }),
    }).resolve(PLAN)
    expect(invalid).toEqual(expect.objectContaining({
      status: 'ambiguous', data: null, cost_units: null,
    }))

    const timeout = await createApifyCompanyEmployeesAdapter({
      env: ENABLED_ENV,
      now,
      runActor: async () => outcome({
        kind: 'transport_unknown', status: 'ambiguous', items: [], itemCount: 0,
        error: 'transport_unknown',
      }),
    }).resolve(PLAN)
    expect(timeout).toEqual(expect.objectContaining({
      status: 'ambiguous', data: null, cost_units: null,
    }))
  })

  it('charges every returned provider row while exposing only safely bound rows', async () => {
    const result = await createApifyCompanyEmployeesAdapter({
      env: ENABLED_ENV,
      now,
      runActor: async () => outcome({
        items: [employeeItem(), { unexpected: true }],
        itemCount: 2,
      }),
    }).resolve(PLAN)
    expect(result).toEqual(expect.objectContaining({
      status: 'partial',
      cost_units: 28,
      data: [expect.objectContaining({ current_title: 'Practice Owner' })],
      receipt: expect.objectContaining({
        item_count: 2,
        returned_count: 1,
        parser_dropped_rows: 1,
      }),
    }))
  })

  it('never contacts the Actor without the dedicated contract gate', async () => {
    const runActor = jest.fn()
    const result = await createApifyCompanyEmployeesAdapter({
      env: {
        ...ENABLED_ENV,
        [APIFY_COMPANY_EMPLOYEES_PRICE_VERSION_ENV]: undefined,
      },
      now,
      runActor,
    }).resolve(PLAN)
    expect(result).toEqual(expect.objectContaining({ status: 'error', cost_units: 0 }))
    expect(runActor).not.toHaveBeenCalled()
  })
})
