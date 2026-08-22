import {
  DATAFORSEO_DEFAULT_MAX_DEPTH,
  DATAFORSEO_DEFAULT_USD_PER_100_RESULTS,
  DATAFORSEO_REQUIRED_PRICE_VERSION,
  DATAFORSEO_REQUIRED_RETENTION_DAYS,
  DATAFORSEO_REQUIRED_TERMS_VERSION,
  createDataForSeoMapsAdapter,
  dataForSeoEnabled,
} from '../adapters/dataforseo/maps'

const approvedEnv = {
  GTM_DATAFORSEO_ENABLED: 'true',
  GTM_DATAFORSEO_LOGIN: 'login',
  GTM_DATAFORSEO_PASSWORD: 'password',
  GTM_DATAFORSEO_CUSTOMER_USE_APPROVED: 'true',
  GTM_DATAFORSEO_TERMS_VERSION: DATAFORSEO_REQUIRED_TERMS_VERSION,
  GTM_DATAFORSEO_PRICE_VERSION: DATAFORSEO_REQUIRED_PRICE_VERSION,
  GTM_DATAFORSEO_RETENTION_DAYS: String(DATAFORSEO_REQUIRED_RETENTION_DAYS),
}

describe('DataForSEO Maps adapter', () => {
  it('requires reviewed customer-use rights', () => {
    expect(dataForSeoEnabled({
      GTM_DATAFORSEO_ENABLED: 'true', GTM_DATAFORSEO_LOGIN: 'x', GTM_DATAFORSEO_PASSWORD: 'y',
    })).toBe(false)
  })

  it('requires the exact reviewed terms, price, and provider-retention contract', () => {
    const withoutRetention = { ...approvedEnv, GTM_DATAFORSEO_RETENTION_DAYS: undefined }
    expect(dataForSeoEnabled(withoutRetention)).toBe(false)
    expect(createDataForSeoMapsAdapter({ env: withoutRetention }).descriptor.constraints.license)
      .toEqual(expect.objectContaining({ status: 'provisional', retention_days: null }))
    expect(createDataForSeoMapsAdapter({ env: approvedEnv }).descriptor.constraints.license)
      .toEqual(expect.objectContaining({
        status: 'approved',
        terms_version: DATAFORSEO_REQUIRED_TERMS_VERSION,
        retention_days: DATAFORSEO_REQUIRED_RETENTION_DAYS,
      }))

    for (const stale of [
      { GTM_DATAFORSEO_TERMS_VERSION: 'reviewed-2026-08-02' },
      { GTM_DATAFORSEO_PRICE_VERSION: 'maps-live-2026-07-01' },
      { GTM_DATAFORSEO_RETENTION_DAYS: '365' },
    ]) {
      expect(dataForSeoEnabled({ ...approvedEnv, ...stale })).toBe(false)
    }
  })

  it('freezes one 100-result billing block and ignores legacy rate/depth overrides', () => {
    const adapter = createDataForSeoMapsAdapter({ env: approvedEnv })
    const quote = adapter.quote({
      signal_kind: 'local_business_listing', entity_unit: 'companies', geography: 'US',
      query: 'HVAC contractors', max_candidates: 250,
    })
    expect(quote).toEqual(expect.objectContaining({
      max_candidates: DATAFORSEO_DEFAULT_MAX_DEPTH,
      provider_units: 1,
      billable_unit: 'maps_100_results',
    }))

    const compatibilityOverrides = createDataForSeoMapsAdapter({
      env: {
        ...approvedEnv,
        GTM_DATAFORSEO_MAX_DEPTH: '700',
        GTM_DATAFORSEO_USD_PER_100_RESULTS: '99',
      },
    })
    const expanded = compatibilityOverrides.quote({
      signal_kind: 'local_business_listing', entity_unit: 'companies', geography: 'US',
      query: 'HVAC contractors', max_candidates: 700,
    })
    expect(expanded).toEqual(expect.objectContaining({
      max_candidates: DATAFORSEO_DEFAULT_MAX_DEPTH,
      provider_units: 1,
      quoted_credits_per_unit: expect.any(Number),
    }))
    expect(compatibilityOverrides.descriptor.cost_model.price_version)
      .toBe(DATAFORSEO_REQUIRED_PRICE_VERSION)
    expect(compatibilityOverrides.descriptor.cost_model.quoted_credits_per_unit)
      .toBe(createDataForSeoMapsAdapter({ env: approvedEnv }).descriptor.cost_model.quoted_credits_per_unit)
    expect(DATAFORSEO_DEFAULT_USD_PER_100_RESULTS).toBe(0.002)
  })

  it('sends the frozen default depth rather than the caller requested ceiling', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      status_code: 20000, cost: 0.002,
      tasks: [{ status_code: 20000, cost: 0.002, result: [{ items: [] }] }],
    }), { status: 200 })) as unknown as typeof fetch
    const adapter = createDataForSeoMapsAdapter({ env: approvedEnv, fetchImpl })
    await adapter.search({
      signal_kind: 'local_business_listing', entity_unit: 'companies', geography: 'US',
      query: 'HVAC contractors', max_candidates: 700,
    })
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body[0].depth).toBe(DATAFORSEO_DEFAULT_MAX_DEPTH)
  })

  it.each([
    ['overlong keyword', 'x'.repeat(701), 'bad_request'],
    ['price-multiplying operator', 'site:example.com HVAC contractors', 'unpriced_query_operator'],
    ['parenthesized price-multiplying operator', 'HVAC (site:example.com)', 'unpriced_query_operator'],
  ])('rejects an %s before provider contact', async (_label, query, errorCode) => {
    const fetchImpl = jest.fn() as unknown as typeof fetch
    const adapter = createDataForSeoMapsAdapter({ env: approvedEnv, fetchImpl })
    const result = await adapter.search({
      signal_kind: 'local_business_listing', entity_unit: 'companies', geography: 'US',
      query, max_candidates: 25,
    })
    expect(result).toEqual(expect.objectContaining({ status: 'error', cost_units: 0 }))
    expect(result.error).toContain(errorCode)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('normalizes Maps rows with place-level source URLs and exact task cost receipts', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      status_code: 20000, status_message: 'Ok.', cost: 0.002,
      tasks: [{
        id: 'task-1', status_code: 20000, cost: 0.002,
        result: [{
          datetime: '2026-08-02T12:00:00.000Z',
          items: [{
            title: 'Example HVAC', domain: 'example.test', address: 'Austin, TX',
            category: 'HVAC contractor', place_id: 'place-1',
            address_info: { city: 'Austin', region: 'Texas', country_code: 'US' },
            gps_coordinates: { latitude: 30.2672, longitude: -97.7431 },
          }],
        }],
      }],
    }), { status: 200 })) as unknown as typeof fetch
    const adapter = createDataForSeoMapsAdapter({ env: approvedEnv, fetchImpl })
    const result = await adapter.search({
      signal_kind: 'local_business_listing', entity_unit: 'companies', geography: 'US',
      query: 'HVAC contractors Austin', max_candidates: 25,
      provider_query: { company_keywords: ['HVAC contractor'], locations: ['Austin, TX'] },
    })
    expect(result.status).toBe('ok')
    expect(result.cost_units).toBe(1)
    expect(result.data?.[0].identity).toEqual(expect.objectContaining({
      provider_location: 'Austin,Texas,United States',
      city: 'Austin',
      region: 'Texas',
      country_code: 'US',
      latitude: 30.2672,
      longitude: -97.7431,
    }))
    expect(result.data?.[0].evidence[0].source_url).toContain('google.com/maps/place')
    expect(result.data?.[0].evidence[0].detail).toEqual(expect.objectContaining({
      provider_location: 'Austin,Texas,United States',
      country_code: 'US',
    }))
    expect(result.receipt).toEqual(expect.objectContaining({
      root_status_code: 20000, task_status_code: 20000,
      root_cost_usd: 0.002, task_cost_usd: 0.002,
    }))
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body).toEqual([expect.objectContaining({
      keyword: 'HVAC contractor',
      location_name: 'Austin,Texas,United States',
      language_code: 'en',
      depth: 25,
    })])
  })

  it('canonicalizes a county and full state into an exact DataForSEO location name', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      status_code: 20000, cost: 0.002,
      tasks: [{ status_code: 20000, cost: 0.002, result: [{ items: [] }] }],
    }), { status: 200 })) as unknown as typeof fetch
    const adapter = createDataForSeoMapsAdapter({ env: approvedEnv, fetchImpl })
    await adapter.search({
      signal_kind: 'local_business_listing', entity_unit: 'companies', geography: 'US',
      query: 'dental clinic', max_candidates: 100,
      provider_query: { company_keywords: ['dental clinic'], locations: ['San Diego County, California'] },
    })
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body[0].location_name).toBe('San Diego County,California,United States')
  })

  it('rejects an incomplete local location before provider contact', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch
    const adapter = createDataForSeoMapsAdapter({ env: approvedEnv, fetchImpl })
    const result = await adapter.search({
      signal_kind: 'local_business_listing', entity_unit: 'companies', geography: 'US',
      query: 'dental clinic', max_candidates: 100,
      provider_query: { company_keywords: ['dental clinic'], locations: ['Springfield'] },
    })
    expect(result).toEqual(expect.objectContaining({ status: 'error', cost_units: 0 }))
    expect(result.error).toContain('city/county plus state')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails closed on an HTTP-200 root application error without charging a result unit', async () => {
    const adapter = createDataForSeoMapsAdapter({
      env: approvedEnv,
      fetchImpl: jest.fn().mockResolvedValue(new Response(JSON.stringify({
        status_code: 40000, status_message: 'Error', cost: 0, tasks: [],
      }), { status: 200 })) as unknown as typeof fetch,
    })
    const result = await adapter.search({
      signal_kind: 'local_business_listing', entity_unit: 'companies', geography: 'US',
      query: 'HVAC contractors', max_candidates: 25,
    })
    expect(result).toEqual(expect.objectContaining({ status: 'error', cost_units: 0 }))
    expect(result.receipt).toEqual(expect.objectContaining({ root_status_code: 40000 }))
  })

  it('records the failing task code and bounded status message when the root succeeds', async () => {
    const adapter = createDataForSeoMapsAdapter({
      env: approvedEnv,
      fetchImpl: jest.fn().mockResolvedValue(new Response(JSON.stringify({
        status_code: 20000, status_message: 'Ok.', cost: 0,
        tasks: [{ status_code: 40501, status_message: "Invalid Field: 'location_name'.", cost: 0 }],
      }), { status: 200 })) as unknown as typeof fetch,
    })
    const result = await adapter.search({
      signal_kind: 'local_business_listing', entity_unit: 'companies', geography: 'US',
      query: 'HVAC contractors', max_candidates: 25,
    })
    expect(result.receipt).toEqual(expect.objectContaining({
      provider_status: 'provider_error_40501',
      root_status_code: 20000,
      task_status_code: 40501,
      task_status_message: "Invalid Field: 'location_name'.",
    }))
  })

  it('settles from authoritative USD cost rather than the requested depth', async () => {
    const adapter = createDataForSeoMapsAdapter({
      env: approvedEnv,
      fetchImpl: jest.fn().mockResolvedValue(new Response(JSON.stringify({
        status_code: 20000, cost: 0.002,
        tasks: [{ status_code: 20000, cost: 0.002, result: [{ items: [] }] }],
      }), { status: 200 })) as unknown as typeof fetch,
    })
    const result = await adapter.search({
      signal_kind: 'local_business_listing', entity_unit: 'companies', geography: 'US',
      query: 'HVAC contractors', max_candidates: 250,
    })
    expect(result).toEqual(expect.objectContaining({ status: 'no_result', cost_units: 1 }))
  })

  it('parks non-timeout transport failures for reconciliation', async () => {
    const adapter = createDataForSeoMapsAdapter({
      env: approvedEnv,
      fetchImpl: jest.fn().mockRejectedValue(new TypeError('connection reset')) as unknown as typeof fetch,
    })
    const result = await adapter.search({
      signal_kind: 'local_business_listing', entity_unit: 'companies', geography: 'US',
      query: 'HVAC contractors', max_candidates: 25,
    })
    expect(result).toEqual(expect.objectContaining({ status: 'ambiguous', cost_units: null }))
  })
})
