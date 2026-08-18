import type { EnrichAdapter, SourceAdapter, VerifyAdapter } from './types'
import { fixtureEnrichAdapter, fixtureSourceAdapter, fixtureVerifyAdapter } from './fixture'
import { apifySourceEnabled, createApifySourceAdapter } from './apify/source'
import { apifyEnrichEnabled, createApifyEnrichAdapter } from './apify/enrich'
import { createLeadMagicSourceAdapter, leadMagicEnabled } from './leadmagic/source'
import { createLeadMagicEnrichAdapter, leadMagicEnrichEnabled } from './leadmagic/enrich'
import { bouncerEnabled, createBouncerVerifyAdapter } from './bouncer/verify'
import { createDataForSeoMapsAdapter, dataForSeoEnabled } from './dataforseo/maps'

/*
 * Adapter registries (SPEC-066 Tranches 3/4).
 *
 * Deterministic fixture adapters are test-only by default. Local development
 * can opt in with GTM_FIXTURE_ADAPTERS_ENABLED=true, but production can never
 * register them. Missing real-provider configuration therefore produces an
 * empty registry and an honest unsupported-plan response, never synthetic
 * customer data.
 *
 * Real provider adapters register ADDITIVELY behind their own env gate, in
 * waterfall priority order. The Apify social-engagement source ships DARK
 * (GTM_APIFY_ENABLED plus a token, default off) because that source is
 * legally gated pending review; see lib/adapters/apify/source.ts.
 */
export function fixtureAdaptersEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NODE_ENV === 'test') return true
  return env.NODE_ENV !== 'production' && env.GTM_FIXTURE_ADAPTERS_ENABLED === 'true'
}

export function sourceAdapterRegistry(): Record<string, SourceAdapter> {
  const registry: Record<string, SourceAdapter> = {}
  if (fixtureAdaptersEnabled()) {
    registry[fixtureSourceAdapter.descriptor.adapter_id] = fixtureSourceAdapter
  }
  if (apifySourceEnabled()) {
    const apify = createApifySourceAdapter()
    registry[apify.descriptor.adapter_id] = apify
  }
  if (leadMagicEnabled()) {
    const leadMagic = createLeadMagicSourceAdapter()
    registry[leadMagic.descriptor.adapter_id] = leadMagic
  }
  if (dataForSeoEnabled()) {
    const dataForSeo = createDataForSeoMapsAdapter()
    registry[dataForSeo.descriptor.adapter_id] = dataForSeo
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
 * The Apify profile+email adapter appends behind the SAME dark gate as the
 * Apify source (GTM_APIFY_ENABLED plus a token, default off). With the gate off
 * this list contains no network adapter. Note it is the only pay-per-ATTEMPT
 * adapter in the stack: see lib/adapters/apify/enrich.ts.
 */
export function enrichAdapterList(): EnrichAdapter[] {
  const list: EnrichAdapter[] = fixtureAdaptersEnabled() ? [fixtureEnrichAdapter] : []
  if (leadMagicEnrichEnabled()) list.push(createLeadMagicEnrichAdapter())
  if (apifyEnrichEnabled()) list.push(createApifyEnrichAdapter())
  return list
}

// Registry ORDER is the verification order: the first adapter that returns a
// definitive verification state settles the contact point.
export function verifyAdapterList(): VerifyAdapter[] {
  const list: VerifyAdapter[] = fixtureAdaptersEnabled() ? [fixtureVerifyAdapter] : []
  if (bouncerEnabled()) list.push(createBouncerVerifyAdapter())
  return list
}
