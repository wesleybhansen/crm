import crypto from 'crypto'
import { adapterAudienceRights, capabilityCovers, type AdapterDescriptor, type SourceAdapter } from '../adapters/types'
import { creditsForUnits, defaultMarkupMultiplier } from '../credits/markup'
import { computeGtmPolicy, policyInputFromPlay, type GtmPolicyResult } from '../policy'
import { compileQualificationProfile, type QualificationProfile } from './qualify'
import { buildOpportunityQueryLanes, opportunitySourceRouting } from './opportunity-query-lanes'
import {
  buildOpportunityDestinationValidationPlan,
  type OpportunityDestinationValidationPlan,
} from './opportunity-destination-contract'
import {
  APIFY_REDDIT_URL_HYDRATION_ADAPTER_ID,
  REDDIT_URL_HYDRATION_CONTRACT_VERSION,
  REDDIT_URL_HYDRATION_MAX_URLS,
  REDDIT_URL_HYDRATION_ROWS_PER_URL,
  REDDIT_URL_HYDRATION_SELECTOR_VERSION,
} from './reddit-url-hydration'
import {
  APIFY_LINKEDIN_ENGAGER_ADAPTER_ID,
  APIFY_LINKEDIN_REACTOR_ADAPTER_ID,
  linkedinEngagerQueryContract,
} from './linkedin-engagement'

/*
 * Pure research-run planning (SPEC-066 sections 7 and 11.1). No ORM, no
 * framework imports, no side effects: the route persists what this returns.
 *
 * Fail-closed rules implemented here:
 * - SPEC-069 separates research eligibility from automated-email execution.
 *   Research policy is recomputed from canonical play fields and every source
 *   must also carry exact business/consumer customer-serving rights.
 * - A requested dimension with no covering adapter capability surfaces as an
 *   unsupportedDimensions entry BEFORE any spend (section 11.1).
 * - An empty adapter plan is a typed plan error, never a silent empty run.
 */

// Accepted leads are the product outcome. Raw candidates remain a separate,
// user-visible spend and volume ceiling used to refill shortfalls.
export const DEFAULT_MAX_CANDIDATES = 25
export const MAX_CANDIDATES_HARD_CAP = 100
export const DEFAULT_TARGET_ACCEPTED = 25
export const DEFAULT_MAX_RAW_CANDIDATES = 100

export type PlanPlayInput = {
  id?: string
  marketType?: string | null
  geography?: string | null
  signal?: string | null
  signalKind?: string | null
  entityUnit?: string | null
  audience?: string | null
  sourceHint?: string | null
  whyNow?: string | null
  recommendedAngle?: string | null
  providerQuery?: Record<string, unknown> | null
  recencyWindow?: string | null
}

export type ResearchLimitsInput = {
  targetAccepted?: number | null
  maxRawCandidates?: number | null
  // Backward-compatible alias for maxRawCandidates.
  maxCandidates?: number | null
  maxCredits?: number | null
}

export type ResearchLimits = {
  targetAccepted: number
  maxRawCandidates: number
  // Backward-compatible response alias for old Hub and API consumers.
  maxCandidates: number
  maxCredits: number
}

export type OpportunitySourceRoutingSignal = {
  adapterId: string
  geography?: string | null
  intent?: string | null
  opportunities: number
  accepted: number
  humanUsefulAccepted: number
  chargedCredits: number
  deadDestinationRate: number
  staleDestinationRate: number
  duplicateRate: number
}

export type OpportunitySourceRoutingInput = {
  evidenceScope?: 'market_lane' | 'play' | 'organization_recent' | 'none'
  signals?: OpportunitySourceRoutingSignal[] | null
}

export type OpportunitySourceRoutingSnapshot = {
  policyVersion: 'opportunity-source-routing-v1'
  evidenceScope: 'market_lane' | 'play' | 'organization_recent' | 'none'
  geography: string
  intent: string | null
  signals: OpportunitySourceRoutingSignal[]
}

export type SourcePlanBatch = {
  adapter_id: string
  capability: {
    signal_kind: string
    entity_unit: string
    entity_kind: 'person' | 'company' | 'opportunity'
    geography: string
  }
  // Provider-native billable units. Kept under the old key too while the
  // execution wrapper migrates, but it is never assumed to mean candidates.
  estimatedUnits: number
  providerUnits: number
  billableUnit: string
  maxCandidates: number
  expectedCandidates: {
    low: number
    high: number
    basis: 'contract' | 'historical' | 'provider_quote' | 'unknown'
  }
  quotedCreditsPerUnit: number
  estimatedCredits: number
  priceVersion: string
  termsVersion: string
  descriptorHash: string
  providerQuery: Record<string, unknown> | null
  queryLaneId?: string | null
  continuationPage?: number
  continuationOffset?: number | null
  adaptiveOrder: number
  stopWhenTargetAccepted: boolean
  dependentHydration?: SourcePlanDependentHydration | null
}

export type SourcePlanDependentHydration = {
  adapter_id: string
  capability: SourcePlanBatch['capability']
  estimatedUnits: number
  providerUnits: number
  billableUnit: string
  maxCandidates: number
  maxUrls: number
  rowsPerUrl: number
  expectedCandidates: SourcePlanBatch['expectedCandidates']
  quotedCreditsPerUnit: number
  estimatedCredits: number
  priceVersion: string
  termsVersion: string
  descriptorHash: string
  providerQuery: Record<string, unknown>
  selector: {
    version: typeof REDDIT_URL_HYDRATION_SELECTOR_VERSION
    sourceAdapterId: string
    sourceQueryLaneId: string | null
    frozenSiteScope: string
  }
}

export type UnsupportedDimension = {
  adapter_id: string
  dimension: string
  reason: string
}

export type SourcePlanErrorCode = 'play_not_researchable' | 'missing_play_dimensions' | 'empty_adapter_plan'

export type SourcePlanFailure = {
  ok: false
  code: SourcePlanErrorCode
  reason: string
  unsupportedDimensions: UnsupportedDimension[]
}

export type SourcePlanSuccess = {
  ok: true
  schemaVersion: '14'
  planHash: string
  adapterPlan: SourcePlanBatch[]
  estimatedCredits: number
  plannedRawCapacity: number
  unsupportedDimensions: UnsupportedDimension[]
  limits: ResearchLimits
  qualificationProfile: QualificationProfile
  // deterministic provider query derived from the play at plan time; frozen
  // into the run's input snapshot so execution replays the exact plan
  query: string
  // Exact normalized play geography bound into the quote hash. The adapter
  // capability remains country-level US, but CA and TX are not interchangeable
  // priced plans.
  geography: string
  entityKind: 'person' | 'company' | 'opportunity'
  destinationValidation: OpportunityDestinationValidationPlan
  sourceRouting: OpportunitySourceRoutingSnapshot
  policy: GtmPolicyResult
}

export type SourcePlanResult = SourcePlanSuccess | SourcePlanFailure

function clampPositive(requested: number | null | undefined, fallback: number, cap: number): number {
  if (requested == null || !Number.isFinite(requested)) return fallback
  const rounded = Math.floor(requested)
  if (rounded < 1) return 1
  return Math.min(rounded, cap)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    // Code-unit ordering is total and locale-independent. localeCompare can
    // return 0 for distinct Unicode keys, making insertion order affect hashes.
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`
}

export function immutableHash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function descriptorHash(descriptor: AdapterDescriptor): string {
  return immutableHash(descriptor)
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function boundedRate(value: number): number {
  return Math.max(0, Math.min(1, finiteNonNegative(value)))
}

function normalizedRoutingSignals(
  input: OpportunitySourceRoutingInput | null | undefined,
  adapterIds: Set<string>,
): OpportunitySourceRoutingSignal[] {
  return (input?.signals ?? [])
    .filter((signal) =>
      signal != null
      && typeof signal === 'object'
      && typeof signal.adapterId === 'string'
      && adapterIds.has(signal.adapterId.trim()),
    )
    .map((signal) => ({
      adapterId: signal.adapterId.trim(),
      geography: signal.geography?.trim().replace(/\s+/g, ' ') || null,
      intent: signal.intent?.trim().toLowerCase().replace(/[\s-]+/g, '_') || null,
      opportunities: Math.floor(finiteNonNegative(signal.opportunities)),
      accepted: Math.floor(finiteNonNegative(signal.accepted)),
      humanUsefulAccepted: Math.floor(finiteNonNegative(signal.humanUsefulAccepted)),
      chargedCredits: finiteNonNegative(signal.chargedCredits),
      deadDestinationRate: boundedRate(signal.deadDestinationRate),
      staleDestinationRate: boundedRate(signal.staleDestinationRate),
      duplicateRate: boundedRate(signal.duplicateRate),
    }))
    .sort((left, right) =>
      left.adapterId.localeCompare(right.adapterId)
      || (left.geography ?? '').localeCompare(right.geography ?? '')
      || (left.intent ?? '').localeCompare(right.intent ?? ''),
    )
}

function normalizedRoutingEvidenceScope(
  value: OpportunitySourceRoutingInput['evidenceScope'],
  signalCount: number,
): OpportunitySourceRoutingSnapshot['evidenceScope'] {
  if (value === 'market_lane' || value === 'play' || value === 'organization_recent') {
    return signalCount > 0 ? value : 'none'
  }
  if (value == null && signalCount > 0) return 'organization_recent'
  return 'none'
}

function routingSignalFor(
  signals: OpportunitySourceRoutingSignal[],
  adapterId: string,
  geography: string,
  intent: string | null,
): OpportunitySourceRoutingSignal | null {
  const normalizedGeography = geography.toLowerCase()
  return signals
    .filter((signal) => signal.adapterId === adapterId)
    .map((signal) => ({
      signal,
      specificity:
        (signal.geography?.toLowerCase() === normalizedGeography ? 2 : signal.geography ? -10 : 0)
        + (signal.intent === intent ? 1 : signal.intent ? -10 : 0),
    }))
    .filter((row) => row.specificity >= 0)
    .sort((left, right) => right.specificity - left.specificity)[0]?.signal ?? null
}

function routingEvidenceTier(signal: OpportunitySourceRoutingSignal | null): number {
  if (!signal) return 2
  if (signal.humanUsefulAccepted > 0) return 0
  if (signal.accepted > 0) return 1
  if (signal.opportunities > 0 || signal.chargedCredits > 0) return 3
  return 2
}

// Maps a capabilityCovers reason string onto the dimension it names, so the
// caller can show which requested dimension is unsupported.
function dimensionFromReason(reason: string): string {
  const missing = reason.match(/^missing required dimension: (\w+)/)
  if (missing) return missing[1]
  const unsupported = reason.match(/^unsupported (\w+)/)
  if (unsupported) return unsupported[1]
  return 'unknown'
}

export function canonicalEntityKind(entityUnit: string): 'person' | 'company' | 'opportunity' | null {
  const normalized = entityUnit
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  if (['person', 'people', 'contact', 'contacts', 'employee', 'employees'].includes(normalized)) {
    return 'person'
  }
  if (
    [
      'company',
      'companies',
      'organization',
      'organizations',
      'business',
      'businesses',
      'location',
      'locations',
    ].includes(normalized)
  ) {
    return 'company'
  }
  if (
    [
      'opportunity',
      'opportunities',
      'surface',
      'surfaces',
      'community',
      'communities',
      'forum',
      'forums',
      'group',
      'groups',
      'thread',
      'threads',
      'post',
      'posts',
      'event',
      'events',
      'audience',
      'audiences',
      'creatoraudience',
      'creatoraudiences',
    ].includes(normalized)
  ) {
    return 'opportunity'
  }
  return null
}

export function buildSourcePlan(
  play: PlanPlayInput,
  adapters: SourceAdapter[],
  limits?: ResearchLimitsInput | null,
  markupMultiplier: number = defaultMarkupMultiplier(),
  opportunityRouting?: OpportunitySourceRoutingInput | null,
): SourcePlanResult {
  const policy = computeGtmPolicy(policyInputFromPlay(play))
  if (policy.research_eligibility !== 'provider_runnable') {
    return {
      ok: false,
      code: 'play_not_researchable',
      reason: policy.research_eligibility_reason,
      unsupportedDimensions: [],
    }
  }

  const signalKind = (play.signalKind ?? play.signal ?? '').trim()
  const entityUnit = (play.entityUnit ?? '').trim()
  const entityKind = canonicalEntityKind(entityUnit)
  if (!signalKind || !entityUnit || !entityKind) {
    return {
      ok: false,
      code: 'missing_play_dimensions',
      reason: `play is missing required dimensions for sourcing: ${[
        !signalKind ? 'signal' : null,
        !entityUnit || !entityKind ? 'entity_unit' : null,
      ]
        .filter(Boolean)
        .join(', ')}`,
      unsupportedDimensions: [],
    }
  }

  // Plays use customer-facing surface nouns (community, forum, group, post,
  // event, ...), while source-adapter contracts intentionally expose the one
  // canonical provider unit `opportunities`. Capability matching and the
  // frozen provider call must use that canonical unit or a valid community
  // play fails closed as an empty plan despite having approved coverage.
  const providerEntityUnit = entityKind === 'opportunity' ? 'opportunities' : entityUnit

  // V1 is US-only and eligibility above has already proven a US geography, so
  // the capability request uses the country code; the play's raw geography
  // text stays in the query for the provider.
  const geographyCode = 'US'

  const maxRawCandidates = clampPositive(
    limits?.maxRawCandidates ?? limits?.maxCandidates,
    DEFAULT_MAX_RAW_CANDIDATES,
    MAX_CANDIDATES_HARD_CAP,
  )
  const targetAccepted = Math.min(
    clampPositive(limits?.targetAccepted, DEFAULT_TARGET_ACCEPTED, MAX_CANDIDATES_HARD_CAP),
    maxRawCandidates,
  )

  const rawGeography = (play.geography ?? '').trim().replace(/\s+/g, ' ')
  const query = [play.audience, play.signal, rawGeography]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' ')

  const adapterPlan: SourcePlanBatch[] = []
  const unsupportedDimensions: UnsupportedDimension[] = []
  const eligibleAdapters: SourceAdapter[] = []
  const redditUrlHydrationAdapter =
    entityKind === 'opportunity'
      ? adapters.find((adapter) => adapter.descriptor.adapter_id === APIFY_REDDIT_URL_HYDRATION_ADAPTER_ID)
      : undefined

  for (const adapter of adapters) {
    const descriptor = adapter.descriptor
    if (descriptor.layer !== 'source') continue
    // This adapter consumes an exact URL set derived from a paid discovery
    // result. It can only appear under the source batch that governs that set.
    if (descriptor.adapter_id === APIFY_REDDIT_URL_HYDRATION_ADAPTER_ID) continue
    if (
      descriptor.adapter_id === APIFY_LINKEDIN_ENGAGER_ADAPTER_ID
      || descriptor.adapter_id === APIFY_LINKEDIN_REACTOR_ADAPTER_ID
    ) {
      const queryContract = linkedinEngagerQueryContract(play.providerQuery)
      if (!queryContract.ok) {
        unsupportedDimensions.push({
          adapter_id: descriptor.adapter_id,
          dimension: 'source_query',
          reason: queryContract.reason,
        })
        continue
      }
      const contractedAdapterId = queryContract.value.engagementKind === 'comment'
        ? APIFY_LINKEDIN_ENGAGER_ADAPTER_ID
        : APIFY_LINKEDIN_REACTOR_ADAPTER_ID
      // Comments and reactions are separately quoted source lanes. A frozen
      // play selects exactly one; enabling both runtime adapters must not
      // duplicate a run or make the other adapter's quote fail the plan.
      if (descriptor.adapter_id !== contractedAdapterId) continue
    }
    const rights = adapterAudienceRights(
      descriptor,
      policy.lead_mode === 'consumer' ? 'consumer' : 'business',
      entityKind,
    )
    if (!rights.allowed) {
      unsupportedDimensions.push({
        adapter_id: descriptor.adapter_id,
        dimension: 'license',
        reason: rights.reason ?? 'provider customer-serving rights are incomplete',
      })
      continue
    }
    const coverage = capabilityCovers(descriptor, {
      signal_kind: signalKind,
      entity_unit: providerEntityUnit,
      geography: geographyCode,
    })
    if (!coverage.covered) {
      const reason = coverage.reason ?? 'not covered'
      unsupportedDimensions.push({
        adapter_id: descriptor.adapter_id,
        dimension: dimensionFromReason(reason),
        reason,
      })
      continue
    }
    if (entityKind === 'opportunity') {
      const routing = opportunitySourceRouting(play, descriptor.adapter_id)
      if (!routing.eligible) {
        unsupportedDimensions.push({
          adapter_id: descriptor.adapter_id,
          dimension: 'source_quality',
          reason: routing.reason ?? 'source is not eligible for this opportunity lane',
        })
        continue
      }
    }
    eligibleAdapters.push(adapter)
  }

  const unorderedPlannedSources: Array<{
    adapter: SourceAdapter
    query: string
    providerQuery: Record<string, unknown> | null
    queryLaneId: string | null
  }> = []
  for (const adapter of eligibleAdapters) {
    if (entityKind !== 'opportunity') {
      unorderedPlannedSources.push({ adapter, query, providerQuery: play.providerQuery ?? null, queryLaneId: null })
      continue
    }
    unorderedPlannedSources.push(
      ...buildOpportunityQueryLanes(play, adapter.descriptor.adapter_id).map((lane) => ({
        adapter,
        query: lane.query,
        providerQuery: lane.providerQuery,
        queryLaneId: lane.id,
      })),
    )
  }

  const routingIntent = entityKind === 'opportunity'
    ? typeof unorderedPlannedSources[0]?.providerQuery?.opportunity_intent_lane === 'string'
      ? unorderedPlannedSources[0].providerQuery.opportunity_intent_lane
      : null
    : null
  const eligibleAdapterIds = new Set(eligibleAdapters.map((adapter) => adapter.descriptor.adapter_id))
  const routingSignals = entityKind === 'opportunity'
    ? normalizedRoutingSignals(opportunityRouting, eligibleAdapterIds)
    : []
  const sourceRouting: OpportunitySourceRoutingSnapshot = {
    policyVersion: 'opportunity-source-routing-v1',
    evidenceScope: entityKind === 'opportunity'
      ? normalizedRoutingEvidenceScope(opportunityRouting?.evidenceScope, routingSignals.length)
      : 'none',
    geography: rawGeography,
    intent: routingIntent,
    signals: routingSignals,
  }

  const plannedSources = (() => {
    if (entityKind !== 'opportunity') return unorderedPlannedSources
    const groups = new Map<string, typeof unorderedPlannedSources>()
    for (const source of unorderedPlannedSources) {
      const adapterId = source.adapter.descriptor.adapter_id
      const rows = groups.get(adapterId) ?? []
      rows.push(source)
      groups.set(adapterId, rows)
    }
    const representative = (adapterId: string) => groups.get(adapterId)?.[0]
    const quotedCreditsPerExpectedCandidate = (adapterId: string): number => {
      const source = representative(adapterId)
      if (!source) return Number.POSITIVE_INFINITY
      try {
        const quote = source.adapter.quote({
          signal_kind: signalKind,
          entity_unit: providerEntityUnit,
          geography: geographyCode,
          query: source.query,
          provider_query: source.providerQuery ?? undefined,
          max_candidates: Math.min(10, maxRawCandidates),
        })
        const expected = Math.max(1, quote.expected_candidates.high)
        return creditsForUnits(
          quote.provider_units,
          quote.quoted_credits_per_unit,
          markupMultiplier,
        ) / expected
      } catch {
        return Number.POSITIVE_INFINITY
      }
    }
    const adapterOrder = [...groups.keys()].sort((leftId, rightId) => {
      const left = routingSignalFor(routingSignals, leftId, rawGeography, routingIntent)
      const right = routingSignalFor(routingSignals, rightId, rawGeography, routingIntent)
      const tierDelta = routingEvidenceTier(left) - routingEvidenceTier(right)
      if (tierDelta !== 0) return tierDelta
      const leftUsefulYield = left && left.opportunities > 0
        ? left.humanUsefulAccepted / left.opportunities
        : 0
      const rightUsefulYield = right && right.opportunities > 0
        ? right.humanUsefulAccepted / right.opportunities
        : 0
      if (leftUsefulYield !== rightUsefulYield) return rightUsefulYield - leftUsefulYield
      const leftAcceptedYield = left && left.opportunities > 0 ? left.accepted / left.opportunities : 0
      const rightAcceptedYield = right && right.opportunities > 0 ? right.accepted / right.opportunities : 0
      if (leftAcceptedYield !== rightAcceptedYield) return rightAcceptedYield - leftAcceptedYield
      const leftPenalty = left
        ? left.deadDestinationRate + left.staleDestinationRate + left.duplicateRate
        : 0
      const rightPenalty = right
        ? right.deadDestinationRate + right.staleDestinationRate + right.duplicateRate
        : 0
      if (leftPenalty !== rightPenalty) return leftPenalty - rightPenalty
      const leftCost = left && (left.humanUsefulAccepted > 0 || left.accepted > 0)
        ? left.chargedCredits / Math.max(1, left.humanUsefulAccepted || left.accepted)
        : quotedCreditsPerExpectedCandidate(leftId)
      const rightCost = right && (right.humanUsefulAccepted > 0 || right.accepted > 0)
        ? right.chargedCredits / Math.max(1, right.humanUsefulAccepted || right.accepted)
        : quotedCreditsPerExpectedCandidate(rightId)
      if (leftCost !== rightCost) return leftCost - rightCost
      return leftId.localeCompare(rightId)
    })
    const interleaved: typeof unorderedPlannedSources = []
    const maxLanes = Math.max(0, ...[...groups.values()].map((rows) => rows.length))
    for (let laneIndex = 0; laneIndex < maxLanes; laneIndex += 1) {
      for (const adapterId of adapterOrder) {
        const source = groups.get(adapterId)?.[laneIndex]
        if (source) interleaved.push(source)
      }
    }
    return interleaved
  })()

  let remaining = maxRawCandidates
  for (const [index, plannedSource] of plannedSources.entries()) {
    const { adapter } = plannedSource
    const descriptor = adapter.descriptor
    if (remaining <= 0) continue
    // Divide the raw ceiling across every covering source. Execution calls
    // them in order and stops as soon as the accepted target is met, so the
    // quote is a maximum while later lanes are adaptive shortfall refills.
    const lanesRemaining = plannedSources.length - index
    const fairShare = Math.ceil(remaining / Math.max(1, lanesRemaining))
    const pagination = descriptor.constraints.pagination
    const pageSize = pagination
      ? Math.min(descriptor.constraints.max_batch, pagination.page_size)
      : descriptor.constraints.max_batch
    const maxPages = pagination?.max_pages ?? 1
    let adapterRemaining = fairShare
    for (let page = 1; page <= maxPages && adapterRemaining > 0 && remaining > 0; page += 1) {
      const requestedCandidates = Math.min(adapterRemaining, remaining, pageSize)
      if (requestedCandidates <= 0) break
      const quote = adapter.quote({
        signal_kind: signalKind,
        entity_unit: providerEntityUnit,
        geography: geographyCode,
        query: plannedSource.query,
        provider_query: plannedSource.providerQuery ?? undefined,
        max_candidates: requestedCandidates,
      })
      if (quote.max_candidates <= 0 || quote.provider_units <= 0) break
      const frozenSiteScope =
        descriptor.adapter_id === 'dataforseo-organic-demand-opportunities'
        && typeof plannedSource.providerQuery?.dataforseo_site_scope === 'string'
          ? plannedSource.providerQuery.dataforseo_site_scope.trim()
          : ''
      const scopedSubreddit = frozenSiteScope.match(/^(?:www\.)?reddit\.com\/r\/([a-z0-9_]+)\/?$/i)?.[1] ?? null
      const authoredHydrationLocations = Array.isArray(plannedSource.providerQuery?.locations)
        ? plannedSource.providerQuery.locations
            .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
            .map((value) => value.trim().replace(/\s+/g, ' '))
        : []
      const playGeography = typeof play.geography === 'string'
        ? play.geography.trim().replace(/\s+/g, ' ')
        : ''
      const hydrationLocations = authoredHydrationLocations.length > 0
        ? authoredHydrationLocations
        : playGeography
          ? [playGeography]
          : []
      let dependentHydration: SourcePlanDependentHydration | null = null
      if (redditUrlHydrationAdapter && scopedSubreddit && hydrationLocations.length > 0) {
        const hydrationDescriptor = redditUrlHydrationAdapter.descriptor
        const hydrationRights = adapterAudienceRights(
          hydrationDescriptor,
          policy.lead_mode === 'consumer' ? 'consumer' : 'business',
          'opportunity',
        )
        const hydrationCoverage = capabilityCovers(hydrationDescriptor, {
          signal_kind: signalKind,
          entity_unit: 'opportunities',
          geography: geographyCode,
        })
        if (hydrationRights.allowed && hydrationCoverage.covered) {
          const maxUrls = Math.min(quote.max_candidates, REDDIT_URL_HYDRATION_MAX_URLS)
          const hydrationProviderQuery = {
            locations: hydrationLocations,
            reddit_url_hydration_contract_version: REDDIT_URL_HYDRATION_CONTRACT_VERSION,
            reddit_url_selector_version: REDDIT_URL_HYDRATION_SELECTOR_VERSION,
            reddit_post_urls: [],
            reddit_post_urls_hash: null,
            reddit_returned_content_filter_version: 'semantic-intent-location-v4',
            reddit_filter_required_intent: plannedSource.providerQuery?.opportunity_intent_lane,
            reddit_filter_require_location: true,
            reddit_subreddits: [scopedSubreddit],
            source_adapter_id: descriptor.adapter_id,
            source_query_lane_id: plannedSource.queryLaneId,
            source_site_scope: frozenSiteScope,
          }
          const hydrationQuote = redditUrlHydrationAdapter.quote({
            signal_kind: signalKind,
            entity_unit: 'opportunities',
            geography: geographyCode,
            query: plannedSource.query,
            provider_query: hydrationProviderQuery,
            max_candidates: maxUrls * REDDIT_URL_HYDRATION_ROWS_PER_URL,
          })
          if (hydrationQuote.max_candidates > 0 && hydrationQuote.provider_units > 0) {
            dependentHydration = {
              adapter_id: hydrationDescriptor.adapter_id,
              capability: {
                signal_kind: signalKind,
                entity_unit: 'opportunities',
                entity_kind: 'opportunity',
                geography: geographyCode,
              },
              estimatedUnits: hydrationQuote.provider_units,
              providerUnits: hydrationQuote.provider_units,
              billableUnit: hydrationQuote.billable_unit,
              maxCandidates: hydrationQuote.max_candidates,
              maxUrls,
              rowsPerUrl: REDDIT_URL_HYDRATION_ROWS_PER_URL,
              expectedCandidates: hydrationQuote.expected_candidates,
              quotedCreditsPerUnit: hydrationQuote.quoted_credits_per_unit,
              estimatedCredits: creditsForUnits(
                hydrationQuote.provider_units,
                hydrationQuote.quoted_credits_per_unit,
                markupMultiplier,
              ),
              priceVersion: hydrationDescriptor.cost_model.price_version,
              termsVersion: hydrationDescriptor.constraints.license.terms_version,
              descriptorHash: descriptorHash(hydrationDescriptor),
              providerQuery: hydrationProviderQuery,
              selector: {
                version: REDDIT_URL_HYDRATION_SELECTOR_VERSION,
                sourceAdapterId: descriptor.adapter_id,
                sourceQueryLaneId: plannedSource.queryLaneId,
                frozenSiteScope,
              },
            }
          }
        }
      }
      adapterPlan.push({
        adapter_id: descriptor.adapter_id,
        capability: {
          signal_kind: signalKind,
          entity_unit: providerEntityUnit,
          entity_kind: entityKind,
          geography: geographyCode,
        },
        estimatedUnits: quote.provider_units,
        providerUnits: quote.provider_units,
        billableUnit: quote.billable_unit,
        maxCandidates: quote.max_candidates,
        expectedCandidates: quote.expected_candidates,
        quotedCreditsPerUnit: quote.quoted_credits_per_unit,
        estimatedCredits: creditsForUnits(quote.provider_units, quote.quoted_credits_per_unit, markupMultiplier),
        priceVersion: descriptor.cost_model.price_version,
        termsVersion: descriptor.constraints.license.terms_version,
        descriptorHash: descriptorHash(descriptor),
        providerQuery: plannedSource.providerQuery,
        queryLaneId: plannedSource.queryLaneId,
        continuationPage: page,
        continuationOffset: pagination ? (page - 1) * pageSize : null,
        adaptiveOrder: adapterPlan.length + 1,
        stopWhenTargetAccepted: true,
        ...(dependentHydration ? { dependentHydration } : {}),
      })
      adapterRemaining -= quote.max_candidates
      remaining -= quote.max_candidates
      if (!pagination) break
    }
  }

  // An empty adapter plan fails closed: never a silent empty run.
  if (adapterPlan.length === 0) {
    return {
      ok: false,
      code: 'empty_adapter_plan',
      reason: 'no adapter capability covers the requested play dimensions',
      unsupportedDimensions,
    }
  }

  const estimatedCredits = adapterPlan.reduce(
    (sum, batch) => sum + batch.estimatedCredits + (batch.dependentHydration?.estimatedCredits ?? 0),
    0,
  )
  const plannedRawCapacity = adapterPlan.reduce((sum, batch) => sum + batch.maxCandidates, 0)
  const requestedMaxCredits = limits?.maxCredits
  const maxCredits =
    requestedMaxCredits != null && Number.isFinite(requestedMaxCredits) && requestedMaxCredits >= 1
      ? Math.floor(requestedMaxCredits)
      : estimatedCredits

  const pricedPlan = {
    schemaVersion: '14' as const,
    adapterPlan,
    estimatedCredits,
    plannedRawCapacity,
    unsupportedDimensions,
    limits: {
      targetAccepted,
      maxRawCandidates,
      maxCandidates: maxRawCandidates,
      maxCredits,
    },
    qualificationProfile: compileQualificationProfile(play, entityKind),
    query,
    geography: rawGeography,
    entityKind,
    destinationValidation: buildOpportunityDestinationValidationPlan(entityKind, maxRawCandidates),
    sourceRouting,
    policy,
  }
  return {
    ok: true,
    ...pricedPlan,
    planHash: immutableHash(pricedPlan),
  }
}
