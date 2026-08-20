import {
  enrichAdapterList,
  fixtureAdaptersEnabled,
  sourceAdapterRegistry,
  verifyAdapterList,
} from '../adapters/registry'
import {
  fixtureEnrichAdapter,
  fixtureSourceAdapter,
  fixtureVerifyAdapter,
} from '../adapters/fixture'
import { APIFY_ENRICH_ADAPTER_ID } from '../adapters/apify/enrich'
import { APIFY_SOURCE_ADAPTER_ID } from '../adapters/apify/source'

describe('adapter registry environment boundaries', () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env = { ...saved }
  })

  it('keeps deterministic fixtures available in tests', () => {
    process.env.NODE_ENV = 'test'
    expect(fixtureAdaptersEnabled()).toBe(true)
    expect(sourceAdapterRegistry()).toEqual({
      [fixtureSourceAdapter.descriptor.adapter_id]: fixtureSourceAdapter,
    })
    expect(enrichAdapterList()).toEqual([fixtureEnrichAdapter])
    expect(verifyAdapterList()).toEqual([fixtureVerifyAdapter])
  })

  it('allows local development to opt into fixtures explicitly', () => {
    process.env.NODE_ENV = 'development'
    process.env.GTM_FIXTURE_ADAPTERS_ENABLED = 'true'
    expect(fixtureAdaptersEnabled()).toBe(true)
    expect(Object.keys(sourceAdapterRegistry())).toEqual([
      fixtureSourceAdapter.descriptor.adapter_id,
    ])
  })

  it('never registers fixture adapters in production, even when requested', () => {
    process.env.NODE_ENV = 'production'
    process.env.GTM_FIXTURE_ADAPTERS_ENABLED = 'true'
    delete process.env.GTM_APIFY_ENABLED
    delete process.env.GTM_APIFY_TOKEN
    delete process.env.APIFY_TOKEN

    expect(fixtureAdaptersEnabled()).toBe(false)
    expect(sourceAdapterRegistry()).toEqual({})
    expect(enrichAdapterList()).toEqual([])
    expect(verifyAdapterList()).toEqual([])
  })

  it('registers only explicitly enabled real providers in production', () => {
    process.env.NODE_ENV = 'production'
    process.env.GTM_APIFY_ENABLED = 'true'
    process.env.GTM_APIFY_TOKEN = 'synthetic-test-token'
    process.env.GTM_APIFY_CUSTOMER_USE_APPROVED = 'true'
    process.env.GTM_APIFY_TERMS_VERSION = 'reviewed-2026-08-02'
    process.env.GTM_APIFY_PRICE_VERSION = 'measured-2026-07-24'

    expect(Object.keys(sourceAdapterRegistry())).toEqual([APIFY_SOURCE_ADAPTER_ID])
    expect(enrichAdapterList().map((adapter) => adapter.descriptor.adapter_id)).toEqual([
      APIFY_ENRICH_ADAPTER_ID,
    ])
    expect(verifyAdapterList()).toEqual([])
  })
})
