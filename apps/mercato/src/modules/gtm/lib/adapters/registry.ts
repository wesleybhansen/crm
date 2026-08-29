import type { EnrichAdapter, SourceAdapter, VerifyAdapter } from './types'
import { fixtureEnrichAdapter, fixtureSourceAdapter, fixtureVerifyAdapter } from './fixture'
import { fixtureConsumerSourceAdapter } from './fixture-consumer'
import { apifySourceEnabled, createApifySourceAdapter } from './apify/source'
import { apifyOpportunitySourceEnabled, createApifyOpportunitySourceAdapter } from './apify/opportunity-source'
import {
  apifyRedditOpportunityEnabled,
  apifyThreadsOpportunityEnabled,
  apifyXOpportunityEnabled,
  createApifyRedditOpportunityAdapter,
  createApifyThreadsOpportunityAdapter,
  createApifyXOpportunityAdapter,
} from './apify/public-social-opportunity-source'
import { apifyEnrichEnabled, createApifyEnrichAdapter } from './apify/enrich'
import { createDataForSeoMapsAdapter, dataForSeoEnabled } from './dataforseo/maps'
import { createDataForSeoOpportunityAdapter, dataForSeoOpportunityEnabled } from './dataforseo/opportunity-source'
import { apifyCompanySourceEnabled, createApifyCompanySourceAdapter } from './apify/company-source'
import {
  apifyCompanyEmployeesEnabled,
  createApifyCompanyEmployeesAdapter,
  type DecisionMakerAdapter,
} from './apify/company-employees'
import { apifyEmailVerifierEnabled, createApifyEmailVerifierAdapter } from './apify/email-verifier'
import { apifyWebsiteEmailEnabled, createApifyWebsiteEmailAdapter } from './apify/website-email'

/*
 * Adapter registries (SPEC-066 Tranches 3/4).
 *
 * Deterministic fixture adapters are test-only by default. Local development
 * can opt in with GTM_FIXTURE_ADAPTERS_ENABLED=true. A production-mode build
 * may register them only inside the explicit ephemeral OM_TEST_MODE harness;
 * normal production can never register them. Missing real-provider configuration therefore produces an
 * empty registry and an honest unsupported-plan response, never synthetic
 * customer data.
 *
 * The selected real-provider stack is deliberately closed: DataForSEO for
 * local company discovery and Apify for separately approved company search,
 * social-signal sourcing, profile enrichment, bounded public-website email
 * discovery, and email verification. LeadMagic and Bouncer
 * implementations remain in the repository as historical, directly testable
 * adapters, but owner decision
 * R6 excludes them from every runtime registry. Their environment variables
 * therefore cannot activate them accidentally.
 *
 * Selected providers still register only behind their own credential,
 * customer-use, frozen-terms, and frozen-price gates. The company-search
 * actor additionally requires its own exact price version; see
 * lib/adapters/apify/company-source.ts.
 */
export function fixtureAdaptersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'test') return true
  if (env.GTM_FIXTURE_ADAPTERS_ENABLED !== 'true') return false
  if (env.NODE_ENV === 'production') return env.OM_TEST_MODE === '1'
  return true
}

export function sourceAdapterRegistry(): Record<string, SourceAdapter> {
  const registry: Record<string, SourceAdapter> = {}
  if (fixtureAdaptersEnabled()) {
    registry[fixtureSourceAdapter.descriptor.adapter_id] = fixtureSourceAdapter
    registry[fixtureConsumerSourceAdapter.descriptor.adapter_id] = fixtureConsumerSourceAdapter
  }
  if (apifySourceEnabled()) {
    const apify = createApifySourceAdapter()
    registry[apify.descriptor.adapter_id] = apify
  }
  if (apifyOpportunitySourceEnabled()) {
    const opportunities = createApifyOpportunitySourceAdapter()
    registry[opportunities.descriptor.adapter_id] = opportunities
  }
  if (apifyRedditOpportunityEnabled()) {
    const redditOpportunities = createApifyRedditOpportunityAdapter()
    registry[redditOpportunities.descriptor.adapter_id] = redditOpportunities
  }
  if (apifyXOpportunityEnabled()) {
    const xOpportunities = createApifyXOpportunityAdapter()
    registry[xOpportunities.descriptor.adapter_id] = xOpportunities
  }
  if (apifyThreadsOpportunityEnabled()) {
    const threadsOpportunities = createApifyThreadsOpportunityAdapter()
    registry[threadsOpportunities.descriptor.adapter_id] = threadsOpportunities
  }
  if (apifyCompanySourceEnabled()) {
    const apifyCompany = createApifyCompanySourceAdapter()
    registry[apifyCompany.descriptor.adapter_id] = apifyCompany
  }
  if (dataForSeoEnabled()) {
    const dataForSeo = createDataForSeoMapsAdapter()
    registry[dataForSeo.descriptor.adapter_id] = dataForSeo
  }
  if (dataForSeoOpportunityEnabled()) {
    const organicOpportunities = createDataForSeoOpportunityAdapter()
    registry[organicOpportunities.descriptor.adapter_id] = organicOpportunities
  }
  return registry
}

export function sourceAdapterList(): SourceAdapter[] {
  return Object.values(sourceAdapterRegistry())
}

/*
 * Registry ORDER is the enrichment waterfall order (SPEC-066 section 4.1
 * step 6): the first adapter that yields contact points wins.
 *
 * Apify is the selected enrichment provider and uses the same broad dark gate
 * as the Apify source (GTM_APIFY_ENABLED plus its approval contract, default
 * off). Each capability also has its own exact actor/price gate. Profile
 * enrichment runs first; bounded public-company-website discovery is the
 * source-backed fallback. With the gates off this list contains no network
 * adapter. Both are pay-per-attempt; see lib/adapters/apify/enrich.ts and
 * lib/adapters/apify/website-email.ts.
 */
export function enrichAdapterList(): EnrichAdapter[] {
  const list: EnrichAdapter[] = fixtureAdaptersEnabled() ? [fixtureEnrichAdapter] : []
  if (apifyEnrichEnabled()) list.push(createApifyEnrichAdapter())
  if (apifyWebsiteEmailEnabled()) list.push(createApifyWebsiteEmailAdapter())
  return list
}

export function verifyAdapterList(): VerifyAdapter[] {
  const list: VerifyAdapter[] = fixtureAdaptersEnabled() ? [fixtureVerifyAdapter] : []
  if (apifyEmailVerifierEnabled()) list.push(createApifyEmailVerifierAdapter())
  return list
}

// Decision-maker resolution is intentionally outside the general research
// source registry. It can run only for accepted, exact company matches through
// its dedicated plan/confirm route and its separate actor-price gate.
export function decisionMakerAdapter(): DecisionMakerAdapter | null {
  return apifyCompanyEmployeesEnabled() ? createApifyCompanyEmployeesAdapter() : null
}
