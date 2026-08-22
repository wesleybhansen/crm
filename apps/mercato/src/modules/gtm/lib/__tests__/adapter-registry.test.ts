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
import { BOUNCER_VERIFY_ADAPTER_ID } from '../adapters/bouncer/verify'
import { DATAFORSEO_MAPS_ADAPTER_ID } from '../adapters/dataforseo/maps'
import { LEADMAGIC_ENRICH_ADAPTER_ID } from '../adapters/leadmagic/enrich'
import { LEADMAGIC_SOURCE_ADAPTER_ID } from '../adapters/leadmagic/source'

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

  it('never registers fixture adapters in normal production, even when requested', () => {
    process.env.NODE_ENV = 'production'
    process.env.GTM_FIXTURE_ADAPTERS_ENABLED = 'true'
    delete process.env.OM_TEST_MODE
    delete process.env.GTM_APIFY_ENABLED
    delete process.env.GTM_APIFY_TOKEN
    delete process.env.APIFY_TOKEN

    expect(fixtureAdaptersEnabled()).toBe(false)
    expect(sourceAdapterRegistry()).toEqual({})
    expect(enrichAdapterList()).toEqual([])
    expect(verifyAdapterList()).toEqual([])
  })

  it('allows fixtures in the explicit production-mode ephemeral harness only', () => {
    process.env.NODE_ENV = 'production'
    process.env.OM_TEST_MODE = '1'
    process.env.GTM_FIXTURE_ADAPTERS_ENABLED = 'true'

    expect(fixtureAdaptersEnabled()).toBe(true)
    expect(sourceAdapterRegistry()).toEqual({
      [fixtureSourceAdapter.descriptor.adapter_id]: fixtureSourceAdapter,
    })
  })

  it('registers only explicitly enabled real providers in production', () => {
    process.env.NODE_ENV = 'production'
    process.env.GTM_APIFY_ENABLED = 'true'
    process.env.GTM_APIFY_TOKEN = 'synthetic-test-token'
    process.env.GTM_APIFY_CUSTOMER_USE_APPROVED = 'true'
    process.env.GTM_APIFY_TERMS_VERSION = 'reviewed-2026-08-02'
    process.env.GTM_APIFY_PRICE_VERSION = 'measured-2026-07-24'
    process.env.GTM_DATAFORSEO_ENABLED = 'true'
    process.env.GTM_DATAFORSEO_LOGIN = 'synthetic-test-login'
    process.env.GTM_DATAFORSEO_PASSWORD = 'synthetic-test-password'
    process.env.GTM_DATAFORSEO_CUSTOMER_USE_APPROVED = 'true'
    process.env.GTM_DATAFORSEO_TERMS_VERSION = 'tos-2026-06-12'
    process.env.GTM_DATAFORSEO_PRICE_VERSION = 'maps-live-2026-08-20'
    process.env.GTM_DATAFORSEO_RETENTION_DAYS = '30'

    expect(Object.keys(sourceAdapterRegistry())).toEqual([
      APIFY_SOURCE_ADAPTER_ID,
      DATAFORSEO_MAPS_ADAPTER_ID,
    ])
    expect(enrichAdapterList().map((adapter) => adapter.descriptor.adapter_id)).toEqual([
      APIFY_ENRICH_ADAPTER_ID,
    ])
    expect(verifyAdapterList()).toEqual([])
  })

  it('cannot register owner-excluded LeadMagic or Bouncer adapters', () => {
    process.env.NODE_ENV = 'production'
    process.env.GTM_LEADMAGIC_ENABLED = 'true'
    process.env.GTM_LEADMAGIC_API_KEY = 'synthetic-test-key'
    process.env.GTM_LEADMAGIC_CUSTOMER_USE_APPROVED = 'true'
    process.env.GTM_LEADMAGIC_TERMS_VERSION = 'synthetic-terms'
    process.env.GTM_LEADMAGIC_PRICE_VERSION = 'synthetic-price'
    process.env.GTM_BOUNCER_ENABLED = 'true'
    process.env.GTM_BOUNCER_API_KEY = 'synthetic-test-key'
    process.env.GTM_BOUNCER_CUSTOMER_USE_APPROVED = 'true'
    process.env.GTM_BOUNCER_TERMS_VERSION = 'synthetic-terms'
    process.env.GTM_BOUNCER_PRICE_VERSION = 'synthetic-price'

    expect(Object.keys(sourceAdapterRegistry())).not.toContain(LEADMAGIC_SOURCE_ADAPTER_ID)
    expect(enrichAdapterList().map((adapter) => adapter.descriptor.adapter_id)).not.toContain(
      LEADMAGIC_ENRICH_ADAPTER_ID,
    )
    expect(verifyAdapterList().map((adapter) => adapter.descriptor.adapter_id)).not.toContain(
      BOUNCER_VERIFY_ADAPTER_ID,
    )
    expect(sourceAdapterRegistry()).toEqual({})
    expect(enrichAdapterList()).toEqual([])
    expect(verifyAdapterList()).toEqual([])
  })
})
