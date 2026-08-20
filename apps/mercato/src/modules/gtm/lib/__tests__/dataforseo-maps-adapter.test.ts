import {
  DATAFORSEO_DEFAULT_MAX_DEPTH,
  createDataForSeoMapsAdapter,
  dataForSeoEnabled,
} from '../adapters/dataforseo/maps'

const approvedEnv = {
  GTM_DATAFORSEO_ENABLED: 'true',
  GTM_DATAFORSEO_LOGIN: 'login',
  GTM_DATAFORSEO_PASSWORD: 'password',
  GTM_DATAFORSEO_CUSTOMER_USE_APPROVED: 'true',
  GTM_DATAFORSEO_TERMS_VERSION: 'reviewed-2026-08-02',
  GTM_DATAFORSEO_PRICE_VERSION: 'maps-live-2026-07-01',
  GTM_DATAFORSEO_RETENTION_DAYS: '365',
}

describe('DataForSEO Maps adapter', () => {
  it('requires reviewed customer-use rights', () => {
    expect(dataForSeoEnabled({
      GTM_DATAFORSEO_ENABLED: 'true', GTM_DATAFORSEO_LOGIN: 'x', GTM_DATAFORSEO_PASSWORD: 'y',
    })).toBe(false)
  })

  it('requires explicit reviewed provider-retention truth', () => {
    const withoutRetention = { ...approvedEnv, GTM_DATAFORSEO_RETENTION_DAYS: undefined }
    expect(dataForSeoEnabled(withoutRetention)).toBe(false)
    expect(createDataForSeoMapsAdapter({ env: withoutRetention }).descriptor.constraints.license)
      .toEqual(expect.objectContaining({ status: 'provisional', retention_days: null }))
    expect(createDataForSeoMapsAdapter({ env: approvedEnv }).descriptor.constraints.license)
      .toEqual(expect.objectContaining({ status: 'approved', retention_days: 365 }))
  })

  it('defaults to one 100-result billing block and requires an explicit lower-risk depth override', () => {
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

    const expanded = createDataForSeoMapsAdapter({
      env: { ...approvedEnv, GTM_DATAFORSEO_MAX_DEPTH: '250' },
    }).quote({
      signal_kind: 'local_business_listing', entity_unit: 'companies', geography: 'US',
      query: 'HVAC contractors', max_candidates: 700,
    })
    expect(expanded).toEqual(expect.objectContaining({ max_candidates: 250, provider_units: 3 }))

    const providerCapped = createDataForSeoMapsAdapter({
      env: { ...approvedEnv, GTM_DATAFORSEO_MAX_DEPTH: '9999' },
    }).quote({
      signal_kind: 'local_business_listing', entity_unit: 'companies', geography: 'US',
      query: 'HVAC contractors', max_candidates: 9999,
    })
    expect(providerCapped).toEqual(expect.objectContaining({ max_candidates: 700, provider_units: 7 }))
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
    expect(result.data?.[0].evidence[0].source_url).toContain('google.com/maps/place')
    expect(result.receipt).toEqual(expect.objectContaining({
      root_status_code: 20000, task_status_code: 20000,
      root_cost_usd: 0.002, task_cost_usd: 0.002,
    }))
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
