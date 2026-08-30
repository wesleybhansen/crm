import {
  decisionMakerAdapter,
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
import { fixtureConsumerSourceAdapter } from '../adapters/fixture-consumer'
import { APIFY_ENRICH_ADAPTER_ID } from '../adapters/apify/enrich'
import {
  APIFY_COMPANY_PRICE_VERSION_ENV,
  APIFY_COMPANY_REQUIRED_PRICE_VERSION,
  APIFY_COMPANY_SOURCE_ADAPTER_ID,
} from '../adapters/apify/company-source'
import {
  APIFY_COMPANY_EMPLOYEES_ADAPTER_ID,
  APIFY_COMPANY_EMPLOYEES_PRICE_VERSION_ENV,
  APIFY_COMPANY_EMPLOYEES_REQUIRED_PRICE_VERSION,
} from '../adapters/apify/company-employees'
import {
  APIFY_REQUIRED_PRICE_VERSION,
  APIFY_REQUIRED_TERMS_VERSION,
  APIFY_SOURCE_ADAPTER_ID,
} from '../adapters/apify/source'
import { BOUNCER_VERIFY_ADAPTER_ID } from '../adapters/bouncer/verify'
import {
  DATAFORSEO_MAPS_ADAPTER_ID,
  DATAFORSEO_REQUIRED_PRICE_VERSION,
  DATAFORSEO_REQUIRED_RETENTION_DAYS,
  DATAFORSEO_REQUIRED_TERMS_VERSION,
} from '../adapters/dataforseo/maps'
import { LEADMAGIC_ENRICH_ADAPTER_ID } from '../adapters/leadmagic/enrich'
import { LEADMAGIC_SOURCE_ADAPTER_ID } from '../adapters/leadmagic/source'
import {
  APIFY_WEBSITE_EMAIL_ADAPTER_ID,
  APIFY_WEBSITE_EMAIL_ENABLED_ENV,
  APIFY_WEBSITE_EMAIL_PRICE_VERSION_ENV,
  APIFY_WEBSITE_EMAIL_REQUIRED_RETENTION_DAYS,
  APIFY_WEBSITE_EMAIL_REQUIRED_PRICE_VERSION,
  APIFY_WEBSITE_EMAIL_RETENTION_DAYS_ENV,
} from '../adapters/apify/website-email'
import { APIFY_MEETUP_OPPORTUNITY_CONFIG } from '../adapters/apify/public-social-opportunity-source'

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
      [fixtureConsumerSourceAdapter.descriptor.adapter_id]: fixtureConsumerSourceAdapter,
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
      fixtureConsumerSourceAdapter.descriptor.adapter_id,
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
      [fixtureConsumerSourceAdapter.descriptor.adapter_id]: fixtureConsumerSourceAdapter,
    })
  })

  it('registers only explicitly enabled real providers in production', () => {
    process.env.NODE_ENV = 'production'
    process.env.GTM_APIFY_ENABLED = 'true'
    process.env.GTM_APIFY_TOKEN = 'synthetic-test-token'
    process.env.GTM_APIFY_CUSTOMER_USE_APPROVED = 'true'
    process.env.GTM_APIFY_ACCOUNT_TIER = 'BRONZE'
    process.env.GTM_APIFY_TERMS_VERSION = APIFY_REQUIRED_TERMS_VERSION
    process.env.GTM_APIFY_PRICE_VERSION = APIFY_REQUIRED_PRICE_VERSION
    process.env[APIFY_COMPANY_PRICE_VERSION_ENV] = APIFY_COMPANY_REQUIRED_PRICE_VERSION
    process.env.GTM_DATAFORSEO_ENABLED = 'true'
    process.env.GTM_DATAFORSEO_LOGIN = 'synthetic-test-login'
    process.env.GTM_DATAFORSEO_PASSWORD = 'synthetic-test-password'
    process.env.GTM_DATAFORSEO_CUSTOMER_USE_APPROVED = 'true'
    process.env.GTM_DATAFORSEO_TERMS_VERSION = DATAFORSEO_REQUIRED_TERMS_VERSION
    process.env.GTM_DATAFORSEO_PRICE_VERSION = DATAFORSEO_REQUIRED_PRICE_VERSION
    process.env.GTM_DATAFORSEO_RETENTION_DAYS = String(DATAFORSEO_REQUIRED_RETENTION_DAYS)

    expect(Object.keys(sourceAdapterRegistry())).toEqual([
      APIFY_SOURCE_ADAPTER_ID,
      APIFY_COMPANY_SOURCE_ADAPTER_ID,
      DATAFORSEO_MAPS_ADAPTER_ID,
    ])
    expect(enrichAdapterList().map((adapter) => adapter.descriptor.adapter_id)).toEqual([
      APIFY_ENRICH_ADAPTER_ID,
    ])
    expect(verifyAdapterList()).toEqual([])
    expect(decisionMakerAdapter()).toBeNull()
  })

  it('keeps decision-maker resolution outside general sourcing and behind its exact gate', () => {
    process.env.NODE_ENV = 'production'
    process.env.GTM_APIFY_ENABLED = 'true'
    process.env.GTM_APIFY_TOKEN = 'synthetic-test-token'
    process.env.GTM_APIFY_CUSTOMER_USE_APPROVED = 'true'
    process.env.GTM_APIFY_ACCOUNT_TIER = 'BRONZE'
    process.env.GTM_APIFY_TERMS_VERSION = APIFY_REQUIRED_TERMS_VERSION
    process.env.GTM_APIFY_PRICE_VERSION = APIFY_REQUIRED_PRICE_VERSION
    process.env[APIFY_COMPANY_EMPLOYEES_PRICE_VERSION_ENV] =
      APIFY_COMPANY_EMPLOYEES_REQUIRED_PRICE_VERSION

    expect(decisionMakerAdapter()?.descriptor.adapter_id).toBe(
      APIFY_COMPANY_EMPLOYEES_ADAPTER_ID,
    )
    expect(Object.keys(sourceAdapterRegistry())).not.toContain(
      APIFY_COMPANY_EMPLOYEES_ADAPTER_ID,
    )
  })

  it('registers public website discovery only behind its separate exact gate', () => {
    process.env.NODE_ENV = 'production'
    process.env.GTM_APIFY_ENABLED = 'true'
    process.env.GTM_APIFY_TOKEN = 'synthetic-test-token'
    process.env.GTM_APIFY_CUSTOMER_USE_APPROVED = 'true'
    process.env.GTM_APIFY_ACCOUNT_TIER = 'BRONZE'
    process.env.GTM_APIFY_TERMS_VERSION = APIFY_REQUIRED_TERMS_VERSION
    process.env.GTM_APIFY_PRICE_VERSION = APIFY_REQUIRED_PRICE_VERSION
    process.env[APIFY_WEBSITE_EMAIL_ENABLED_ENV] = 'true'
    process.env[APIFY_WEBSITE_EMAIL_PRICE_VERSION_ENV] =
      APIFY_WEBSITE_EMAIL_REQUIRED_PRICE_VERSION
    process.env[APIFY_WEBSITE_EMAIL_RETENTION_DAYS_ENV] =
      String(APIFY_WEBSITE_EMAIL_REQUIRED_RETENTION_DAYS)

    expect(enrichAdapterList().map((adapter) => adapter.descriptor.adapter_id)).toEqual([
      APIFY_ENRICH_ADAPTER_ID,
      APIFY_WEBSITE_EMAIL_ADAPTER_ID,
    ])
  })

  it('registers Meetup public events only behind its capability, use, actor, and price gates', () => {
    process.env.NODE_ENV = 'production'
    process.env.GTM_APIFY_ENABLED = 'true'
    process.env.GTM_APIFY_TOKEN = 'synthetic-test-token'
    process.env.GTM_APIFY_CUSTOMER_USE_APPROVED = 'true'
    process.env.GTM_APIFY_ACCOUNT_TIER = 'BRONZE'
    process.env.GTM_APIFY_TERMS_VERSION = APIFY_REQUIRED_TERMS_VERSION
    process.env.GTM_APIFY_PRICE_VERSION = APIFY_REQUIRED_PRICE_VERSION
    process.env.GTM_APIFY_MEETUP_OPPORTUNITY_ENABLED = 'true'
    process.env.GTM_APIFY_MEETUP_OPPORTUNITY_USE_APPROVED = 'true'

    expect(Object.keys(sourceAdapterRegistry())).not.toContain(
      APIFY_MEETUP_OPPORTUNITY_CONFIG.adapterId,
    )
    process.env.GTM_APIFY_MEETUP_SEARCH_PRICE_VERSION =
      APIFY_MEETUP_OPPORTUNITY_CONFIG.requiredPriceVersion
    expect(Object.keys(sourceAdapterRegistry())).toContain(
      APIFY_MEETUP_OPPORTUNITY_CONFIG.adapterId,
    )
    process.env.GTM_APIFY_ACTOR_MEETUP_SEARCH = 'another/actor'
    expect(Object.keys(sourceAdapterRegistry())).not.toContain(
      APIFY_MEETUP_OPPORTUNITY_CONFIG.adapterId,
    )
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
