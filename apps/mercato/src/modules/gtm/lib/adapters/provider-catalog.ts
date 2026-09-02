import {
  CREDITS_PER_USD,
  creditsForUnits,
  creditsFromUsd,
  defaultMarkupMultiplier,
} from '../credits/markup'
import {
  DATAFORSEO_DEFAULT_MAX_DEPTH,
  DATAFORSEO_DEFAULT_USD_PER_100_RESULTS,
  DATAFORSEO_REQUIRED_PRICE_VERSION,
  DATAFORSEO_REQUIRED_RETENTION_DAYS,
  DATAFORSEO_REQUIRED_TERMS_VERSION,
} from './dataforseo/maps'
import {
  DATAFORSEO_OPPORTUNITY_REQUIRED_PRICE_VERSION,
  DATAFORSEO_ORGANIC_MAX_DEPTH,
  DATAFORSEO_ORGANIC_RESULTS_PER_SERP,
  DATAFORSEO_ORGANIC_USD_PER_SERP,
} from './dataforseo/opportunity-source'
import {
  DATAFORSEO_EVENTS_MAX_DEPTH,
  DATAFORSEO_EVENTS_REQUIRED_PRICE_VERSION,
  DATAFORSEO_EVENTS_RESULTS_PER_SERP,
  DATAFORSEO_EVENTS_USD_PER_SERP,
} from './dataforseo/event-opportunity-source'
import { APIFY_MEASURED_USD } from './apify/actors'
import {
  APIFY_LINKEDIN_ENGAGER_EVENT_PRICES_USD,
  APIFY_LINKEDIN_ENGAGER_MAX_PEOPLE,
  APIFY_LINKEDIN_ENGAGER_REQUIRED_PRICE_VERSION,
} from './apify/engager-source'
import {
  APIFY_REQUIRED_PRICE_VERSION,
  APIFY_REQUIRED_TERMS_VERSION,
} from './apify/source'
import {
  APIFY_COMPANY_ACTOR_START_USD,
  APIFY_COMPANY_FULL_RESULT_USD,
  APIFY_COMPANY_REQUIRED_PRICE_VERSION,
  APIFY_COMPANY_SOURCE_MAX_BATCH,
} from './apify/company-source'
import {
  APIFY_EMAIL_VERIFY_PROVIDER_CAP_USD,
  APIFY_EMAIL_VERIFY_REQUIRED_PRICE_VERSION,
  APIFY_EMAIL_VERIFY_RESULT_USD,
  APIFY_EMAIL_VERIFY_START_USD,
} from './apify/email-verifier'
import {
  APIFY_WEBSITE_EMAIL_MAX_ADDRESSES,
  APIFY_WEBSITE_EMAIL_MAX_PAGES,
  APIFY_WEBSITE_EMAIL_PROVIDER_CAP_USD,
  APIFY_WEBSITE_EMAIL_REQUIRED_PRICE_VERSION,
} from './apify/website-email'

export type SelectedProviderCatalogItem = {
  id: string
  provider: 'DataForSEO' | 'Apify'
  category: 'lead_search' | 'enrichment'
  name: string
  description: string
  unit: string
  provider_usd_per_unit: number
  estimated_noli_credits_per_unit: number
  max_results_per_request: number
  evidence: string
  retention_days: number | null
  terms_version: string
  price_version: string
}

export type SelectedProviderCatalog = {
  basis: {
    credits_per_usd: number
    markup_multiplier: number
    quote_posture: 'estimate_until_reserved'
  }
  items: SelectedProviderCatalogItem[]
}

function item(
  input: Omit<SelectedProviderCatalogItem, 'estimated_noli_credits_per_unit'>,
  markupMultiplier: number,
): SelectedProviderCatalogItem {
  return {
    ...input,
    estimated_noli_credits_per_unit: creditsForUnits(
      1,
      creditsFromUsd(input.provider_usd_per_unit),
      markupMultiplier,
    ),
  }
}

/**
 * Customer-readable catalog for the deliberately narrow production stack.
 * It contains frozen public contract facts only: no credentials, feature
 * flags, account identifiers, runtime availability, or provider payloads.
 * A run's immutable quote remains authoritative for actual spend.
 */
export function selectedProviderCatalog(
  markupMultiplier: number = defaultMarkupMultiplier(),
): SelectedProviderCatalog {
  return {
    basis: {
      credits_per_usd: CREDITS_PER_USD,
      markup_multiplier: markupMultiplier,
      quote_posture: 'estimate_until_reserved',
    },
    items: [
      item({
        id: 'dataforseo-google-maps',
        provider: 'DataForSEO',
        category: 'lead_search',
        name: 'Google Maps company search',
        description: 'Finds US companies and locations that match a local-business signal.',
        unit: `one live search, up to ${DATAFORSEO_DEFAULT_MAX_DEPTH} results`,
        provider_usd_per_unit: DATAFORSEO_DEFAULT_USD_PER_100_RESULTS,
        max_results_per_request: DATAFORSEO_DEFAULT_MAX_DEPTH,
        evidence: 'Listing URL, observation time, and source metadata retained with each accepted row.',
        retention_days: DATAFORSEO_REQUIRED_RETENTION_DAYS,
        terms_version: DATAFORSEO_REQUIRED_TERMS_VERSION,
        price_version: DATAFORSEO_REQUIRED_PRICE_VERSION,
      }, markupMultiplier),
      item({
        id: 'dataforseo-google-organic-opportunities',
        provider: 'DataForSEO',
        category: 'lead_search',
        name: 'Public demand-surface search',
        description:
          'Finds current public discussions, communities, and event pages for manual consumer-demand research.',
        unit: `one live search page, up to ${DATAFORSEO_ORGANIC_RESULTS_PER_SERP} results`,
        provider_usd_per_unit: DATAFORSEO_ORGANIC_USD_PER_SERP,
        max_results_per_request: DATAFORSEO_ORGANIC_MAX_DEPTH,
        evidence:
          'Direct public URL, observation time, returned content summary, locality, and qualification evidence remain attached to each row.',
        retention_days: DATAFORSEO_REQUIRED_RETENTION_DAYS,
        terms_version: DATAFORSEO_REQUIRED_TERMS_VERSION,
        price_version: DATAFORSEO_OPPORTUNITY_REQUIRED_PRICE_VERSION,
      }, markupMultiplier),
      item({
        id: 'dataforseo-google-events-opportunities',
        provider: 'DataForSEO',
        category: 'lead_search',
        name: 'Current local event search',
        description:
          'Finds upcoming public housing workshops and local events for manual review and participation.',
        unit: `one live event-search page, up to ${DATAFORSEO_EVENTS_RESULTS_PER_SERP} results`,
        provider_usd_per_unit: DATAFORSEO_EVENTS_USD_PER_SERP,
        max_results_per_request: DATAFORSEO_EVENTS_MAX_DEPTH,
        evidence:
          'Direct destination, exact event time, venue, returned address, observation time, and qualification evidence remain attached to each row.',
        retention_days: DATAFORSEO_REQUIRED_RETENTION_DAYS,
        terms_version: DATAFORSEO_REQUIRED_TERMS_VERSION,
        price_version: DATAFORSEO_EVENTS_REQUIRED_PRICE_VERSION,
      }, markupMultiplier),
      item({
        id: 'apify-linkedin-company-search',
        provider: 'Apify',
        category: 'lead_search',
        name: 'LinkedIn company search',
        description:
          'Finds US companies by industry, employee range, and location for firmographic qualification.',
        unit: `full company result; each run also reserves a $${APIFY_COMPANY_ACTOR_START_USD.toFixed(3)} actor-start event`,
        provider_usd_per_unit: APIFY_COMPANY_FULL_RESULT_USD,
        max_results_per_request: APIFY_COMPANY_SOURCE_MAX_BATCH,
        evidence:
          'Public company URL, observed firmographics, and observation time remain attached to each row.',
        retention_days: 90,
        terms_version: APIFY_REQUIRED_TERMS_VERSION,
        price_version: APIFY_COMPANY_REQUIRED_PRICE_VERSION,
      }, markupMultiplier),
      item({
        id: 'apify-linkedin-post-comments',
        provider: 'Apify',
        category: 'lead_search',
        name: 'LinkedIn post commenters',
        description: 'Finds people who commented on a selected LinkedIn post signal.',
        unit: 'commenter result',
        provider_usd_per_unit: APIFY_MEASURED_USD.sourcing_per_result,
        max_results_per_request: 100,
        evidence: 'Source post URL and observed engagement are retained as qualification evidence.',
        retention_days: null,
        terms_version: APIFY_REQUIRED_TERMS_VERSION,
        price_version: APIFY_REQUIRED_PRICE_VERSION,
      }, markupMultiplier),
      item({
        id: 'apify-linkedin-commenter-leads',
        provider: 'Apify',
        category: 'lead_search',
        name: 'LinkedIn commenter lead discovery',
        description:
          'Finds current public LinkedIn posts from a play query and returns people who commented as higher-intent, evidence-backed leads.',
        unit: `one commenter; each bounded run also meters post and actor-start events`,
        provider_usd_per_unit: APIFY_LINKEDIN_ENGAGER_EVENT_PRICES_USD.comment,
        max_results_per_request: APIFY_LINKEDIN_ENGAGER_MAX_PEOPLE,
        evidence: 'Public profile URL, source post URL, comment observation, and finalized event receipt remain attached.',
        retention_days: 30,
        terms_version: APIFY_REQUIRED_TERMS_VERSION,
        price_version: APIFY_LINKEDIN_ENGAGER_REQUIRED_PRICE_VERSION,
      }, markupMultiplier),
      item({
        id: 'apify-linkedin-reactor-leads',
        provider: 'Apify',
        category: 'lead_search',
        name: 'LinkedIn reactor lead discovery',
        description:
          'Finds current public LinkedIn posts from a play query and returns people who reacted as separately labeled, lower-intent leads.',
        unit: `one reaction; each bounded run also meters post and actor-start events`,
        provider_usd_per_unit: APIFY_LINKEDIN_ENGAGER_EVENT_PRICES_USD.reaction,
        max_results_per_request: APIFY_LINKEDIN_ENGAGER_MAX_PEOPLE,
        evidence: 'Public profile URL, source post URL, reaction type, observation time, and finalized event receipt remain attached.',
        retention_days: 30,
        terms_version: APIFY_REQUIRED_TERMS_VERSION,
        price_version: APIFY_LINKEDIN_ENGAGER_REQUIRED_PRICE_VERSION,
      }, markupMultiplier),
      item({
        id: 'apify-linkedin-profile',
        provider: 'Apify',
        category: 'enrichment',
        name: 'LinkedIn profile enrichment',
        description: 'Adds profile and company context to a selected person without an email lookup.',
        unit: 'profile enriched',
        provider_usd_per_unit: APIFY_MEASURED_USD.profile_without_email,
        max_results_per_request: 1,
        evidence: 'Profile URL and returned field provenance stay attached to the candidate.',
        retention_days: null,
        terms_version: APIFY_REQUIRED_TERMS_VERSION,
        price_version: APIFY_REQUIRED_PRICE_VERSION,
      }, markupMultiplier),
      item({
        id: 'apify-linkedin-profile-email',
        provider: 'Apify',
        category: 'enrichment',
        name: 'LinkedIn profile + email search',
        description: 'Adds profile context and searches for an address for a selected person.',
        unit: 'profile with email search',
        provider_usd_per_unit: APIFY_MEASURED_USD.profile_with_email,
        max_results_per_request: 1,
        evidence: 'Found addresses remain source-labeled and are not represented as verified email.',
        retention_days: null,
        terms_version: APIFY_REQUIRED_TERMS_VERSION,
        price_version: APIFY_REQUIRED_PRICE_VERSION,
      }, markupMultiplier),
      item({
        id: 'apify-public-website-email',
        provider: 'Apify',
        category: 'enrichment',
        name: 'Public website contact discovery',
        description:
          `Checks up to ${APIFY_WEBSITE_EMAIL_MAX_PAGES} same-domain public pages without a proxy or AI summary. Each run is hard-capped at $${APIFY_WEBSITE_EMAIL_PROVIDER_CAP_USD.toFixed(2)} and settles from finalized platform usage.`,
        unit: `bounded website crawl, up to ${APIFY_WEBSITE_EMAIL_MAX_PAGES} pages`,
        provider_usd_per_unit: APIFY_WEBSITE_EMAIL_PROVIDER_CAP_USD,
        max_results_per_request: APIFY_WEBSITE_EMAIL_MAX_ADDRESSES,
        evidence:
          'Each found address retains its same-domain source URL, observation time, and page-content hash without retaining the page body.',
        retention_days: 90,
        terms_version: APIFY_REQUIRED_TERMS_VERSION,
        price_version: APIFY_WEBSITE_EMAIL_REQUIRED_PRICE_VERSION,
      }, markupMultiplier),
      item({
        id: 'apify-email-verification',
        provider: 'Apify',
        category: 'enrichment',
        name: 'Mailbox verification',
        description:
          `Checks one found address for explicit SMTP evidence. One emitted result has an observed event total of $${(
            APIFY_EMAIL_VERIFY_START_USD + APIFY_EMAIL_VERIFY_RESULT_USD
          ).toFixed(4)}; every provider run is hard-capped at $${APIFY_EMAIL_VERIFY_PROVIDER_CAP_USD.toFixed(2)}.`,
        unit: 'address checked with a completed verification result',
        provider_usd_per_unit:
          APIFY_EMAIL_VERIFY_START_USD + APIFY_EMAIL_VERIFY_RESULT_USD,
        max_results_per_request: 1,
        evidence:
          'Only verification method, confidence, risk flags, and a provider receipt are retained; the catalog does not promise a verified result.',
        retention_days: 90,
        terms_version: APIFY_REQUIRED_TERMS_VERSION,
        price_version: APIFY_EMAIL_VERIFY_REQUIRED_PRICE_VERSION,
      }, markupMultiplier),
    ],
  }
}
