import type { Candidate, CandidateEvidence } from '../adapters/types'
import { isUsGeography } from '../eligibility'
import {
  assessRealtorOpportunitySuitability,
  assessOpportunityDestination,
  classifyOpportunityIntent,
  classifyOpportunityIntentAtDestination,
  demonstratedPublicSourceGeography,
  demonstratedOpportunityLocation,
  opportunityHasContradictoryUsState,
  publicSourceGeographyConflict,
  opportunityEvidenceText,
  realtorOpportunityNoiseReasons,
  resolveOpportunityEventStart,
} from './opportunity-quality'

export type FitVerdict = 'accepted' | 'review' | 'rejected'

export type FitBreakdown = {
  identity: number
  account: number
  persona: number
  geography: number
  evidence: number
}

export type CriterionStatus = 'pass' | 'fail' | 'unknown' | 'not_applicable'

export type CriterionResult = {
  id: string
  dimension: 'account' | 'persona' | 'geography' | 'signal' | 'exclusion'
  label: string
  expected: string[]
  observed: string[]
  status: CriterionStatus
  hard: boolean
}

export type QualificationProfile = {
  version:
    | 'qualification-profile-v1'
    | 'qualification-profile-v2'
    | 'qualification-profile-v3'
    | 'qualification-profile-v4'
  criteria: Array<{
    id: string
    dimension: CriterionResult['dimension']
    label: string
    expected: string[]
    hard: boolean
  }>
}

export type FitResult = {
  fitScore: number
  verdict: FitVerdict
  reason: string
  version: 'fit-v2' | 'fit-v3' | 'fit-v4' | 'fit-v5' | 'fit-v6' | 'fit-v7'
  breakdown: FitBreakdown
  unknowns: string[]
  contradictions: string[]
  profile?: QualificationProfile
  criteria?: CriterionResult[]
}

export type FitPlayInput = {
  entityUnit?: string | null
  geography?: string | null
  audience?: string | null
  signal?: string | null
  recencyWindow?: string | null
  providerQuery?: Record<string, unknown> | null
  referenceTime?: string | Date | null
}

export type FitCandidateInput = Pick<Candidate, 'entity_kind' | 'identity'>

export interface FitScorer {
  score(candidate: FitCandidateInput, play: FitPlayInput, evidence: CandidateEvidence[]): FitResult
}

export const FIT_ACCEPT_THRESHOLD = 70
export const FIT_REVIEW_THRESHOLD = 45
export const FIT_SCORER_VERSION = 'fit-v7' as const
export const FIT_SCORER_REVISION = 'fit-v7-quality-v38' as const

export const FIT_REASONS = {
  accepted: 'meets_fit_rules',
  review: 'insufficient_decisive_fit_data',
  entityKindMismatch: 'entity_kind_mismatch',
  missingName: 'missing_identity_name',
  missingDestination: 'missing_public_destination',
  outsideGeography: 'outside_play_geography',
  noEvidence: 'no_supporting_evidence',
  weakEvidence: 'weak_evidence_confidence',
  noDomain: 'no_domain',
  belowThreshold: 'below_fit_threshold',
  criterionMismatch: 'required_criterion_mismatch',
  criterionUnknown: 'required_criterion_unknown',
  excluded: 'matches_exclusion_criterion',
  staleSignal: 'outside_signal_recency_window',
  inaccessibleDestination: 'public_destination_inaccessible',
  expiredDestination: 'public_destination_expired',
  audienceMismatch: 'opportunity_audience_mismatch',
  intentMismatch: 'opportunity_intent_mismatch',
  notActionable: 'opportunity_not_actionable_under_observed_rules',
  irrelevantOpportunity: 'opportunity_not_relevant_to_play',
  realtorNoise: 'realtor_false_positive',
} as const

const EMPTY_BREAKDOWN: FitBreakdown = {
  identity: 0,
  account: 0,
  persona: 0,
  geography: 0,
  evidence: 0,
}

type CriterionDefinition = QualificationProfile['criteria'][number] & {
  fields: string[]
  // Provider targeting proves why a row was returned, but is not proof that
  // the entity itself is inside the requested boundary. A match here can
  // soften a contradiction to unknown/review; it can never produce pass.
  targetingFields?: string[]
  useEvidence?: boolean
  employeeRange?: boolean
  exclusion?: boolean
  recencyDays?: number
}

function result(
  fitScore: number,
  verdict: FitVerdict,
  reason: string,
  breakdown: FitBreakdown,
  unknowns: string[] = [],
  contradictions: string[] = [],
  profile?: QualificationProfile,
  criteria?: CriterionResult[],
): FitResult {
  return {
    fitScore: Math.max(0, Math.min(100, Math.round(fitScore))),
    verdict,
    reason,
    version: FIT_SCORER_VERSION,
    breakdown,
    unknowns,
    contradictions,
    ...(profile ? { profile } : {}),
    ...(criteria ? { criteria } : {}),
  }
}

function unitWantsCompany(entityUnit: string): boolean {
  return entityUnit.trim().toLowerCase().startsWith('compan')
}

function unitWantsPerson(entityUnit: string): boolean {
  const unit = entityUnit.trim().toLowerCase()
  return unit.startsWith('people') || unit.startsWith('person') || unit.startsWith('contact')
}

function unitWantsOpportunity(entityUnit: string): boolean {
  const unit = entityUnit
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  return [
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
  ].includes(unit)
}

function queryStrings(query: Record<string, unknown>, keys: string[]): string[] {
  return [
    ...new Set(
      keys.flatMap((key) => {
        const value = query[key]
        if (typeof value === 'string' && value.trim()) return [value.trim()]
        if (Array.isArray(value)) {
          return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
        }
        return []
      }),
    ),
  ]
}

const OPPORTUNITY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'at',
  'for',
  'from',
  'in',
  'is',
  'of',
  'on',
  'or',
  'people',
  'the',
  'to',
  'us',
  'who',
  'with',
])

function meaningfulTokens(value: string): string[] {
  return canonicalTokens(value).filter((token) => token.length >= 3 && !OPPORTUNITY_STOP_WORDS.has(token))
}

function semanticallyMatches(expected: string[], observedText: string): boolean {
  const observed = new Set(meaningfulTokens(observedText))
  return expected.some((phrase) => {
    const wanted = [...new Set(meaningfulTokens(phrase))]
    if (wanted.length === 0) return false
    const hits = wanted.filter((token) => observed.has(token)).length
    const required = wanted.length <= 2 ? 1 : Math.max(2, Math.ceil(wanted.length * 0.4))
    return hits >= required
  })
}

function expectedOpportunityIntent(play: FitPlayInput): string[] {
  const query = play.providerQuery ?? {}
  const explicit = queryStrings(query, [
    'opportunity_intent_lane',
    'intent_kind',
    'intent_kinds',
    'opportunity_intent',
  ])
    .map((value) => normalized(value).replace(/ /g, '_'))
    .filter((value) => ['buyer_intent', 'seller_intent', 'local_audience', 'mixed_intent'].includes(value))
  if (explicit.length > 0) return [...new Set(explicit)]
  const targetingText = [
    play.audience,
    play.signal,
    ...queryStrings(query, ['source_search_keywords', 'search_query', 'topics', 'audiences']),
  ]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .join('\n')
  const inferred = classifyOpportunityIntent(targetingText).kind
  return inferred ? [inferred] : []
}

function intentMatchesLane(expected: string[], observed: string): boolean {
  if (expected.includes(observed)) return true
  // A local-audience play asks for public places where relevant consumers
  // gather. A returned event or community can therefore demonstrate a more
  // specific buyer, seller, or mixed housing intent and still satisfy that
  // umbrella lane. Preserve the observed subtype in criterion evidence; this
  // compatibility rule must not relabel it or make the inverse true for a
  // frozen buyer- or seller-intent play.
  if (
    expected.includes('local_audience')
    && ['buyer_intent', 'seller_intent', 'mixed_intent'].includes(observed)
  ) {
    return true
  }
  // A result can demonstrate both buyer and seller language while still
  // satisfying a frozen single-intent lane. Preserve the requested signal
  // instead of discarding a seller question merely because the author also
  // mentions the home they intend to buy next (and vice versa).
  if (
    observed === 'mixed_intent'
    && (expected.includes('buyer_intent') || expected.includes('seller_intent'))
  ) {
    return true
  }
  // A mixed lane deliberately asks for either demonstrated buyer or seller
  // demand. Do not require an individual result to prove both kinds of intent;
  // that would reject the precise single-intent results the lane is meant to
  // collect. Local-audience discovery remains its own lane.
  return expected.includes('mixed_intent')
    && (observed === 'buyer_intent' || observed === 'seller_intent')
}

function expectedAudience(play: FitPlayInput): string[] {
  const query = play.providerQuery ?? {}
  return [
    play.audience,
    play.signal,
    // Audience keywords are customer-authored qualification anchors. Source
    // search keywords are provider targeting and cannot prove that a returned
    // result actually fits the play.
    ...queryStrings(query, ['audience_keywords', 'topics']),
  ].filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
}

function expectedGeographies(play: FitPlayInput): string[] {
  return [
    play.geography,
    ...queryStrings(play.providerQuery ?? {}, ['locations', 'geographies']),
  ].filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
}

function geographyCriterionStatus(
  expected: string[],
  observed: string[],
  targeting: string[],
  countryCode: string | null,
  returnedText: string,
): CriterionStatus {
  if (expected.length === 0) return 'unknown'
  const expectedUs = expected.every((value) => isUsGeography(value))
  if (expectedUs && countryCode && countryCode !== 'US' && countryCode !== 'USA') return 'fail'
  if (expected.some((value) => opportunityHasContradictoryUsState(returnedText, value))) return 'fail'
  if (expected.some((value) => demonstratedOpportunityLocation(returnedText, value))) return 'pass'
  if (observed.length === 0) return 'unknown'
  const expectedTokens = expected.flatMap(meaningfulTokens).filter((value) => value !== 'united' && value !== 'states')
  const observedTokens = new Set(observed.flatMap(meaningfulTokens))
  if (expectedTokens.length === 0 && expectedUs) return countryCode === 'US' || countryCode === 'USA' ? 'pass' : 'unknown'
  if (expectedTokens.some((token) => observedTokens.has(token))) return 'pass'
  if (targeting.length > 0 && semanticallyMatches(expected, targeting.join('\n'))) return 'unknown'
  return 'fail'
}

function criterion(
  id: string,
  dimension: CriterionResult['dimension'],
  label: string,
  expected: string[],
  observed: string[],
  status: CriterionStatus,
  hard = true,
): CriterionResult {
  return { id, dimension, label, expected, observed, status, hard }
}

function opportunityActionabilityStatus(args: {
  recommendedAction: string | null
  messageAngle: string | null
  participationRules: string | null
  participationRulesStatus: string | null
  sourceContent: string
}): CriterionStatus {
  const {
    recommendedAction,
    messageAngle,
    participationRules,
    participationRulesStatus,
    sourceContent,
  } = args
  if (!recommendedAction || recommendedAction.length < 20 || !messageAngle || messageAngle.length < 20) {
    return 'unknown'
  }
  // A live public event proves that a destination exists, but not that a
  // realtor may attend or participate. Some consumer workshops explicitly
  // prohibit agents, brokers, or lenders. Keep actionability unknown until
  // the source's participation terms have been observed.
  // A provider row that merely tells the customer to review the rules does
  // not demonstrate that the venue permits the proposed participation.
  if (participationRulesStatus !== 'observed' || !participationRules) return 'unknown'

  const rules = `${participationRules}\n${sourceContent}`.toLowerCase()
  const proposedAction = `${recommendedAction}\n${messageAngle}`.toLowerCase()
  const promotionRestricted =
    /\b(?:no|prohibit(?:s|ed)?|forbid(?:s|den)?|not allowed)\b.{0,70}\b(?:self[- ]?promot|promot|advertis|solicit|marketing|commercial)\w*/i.test(rules)
    || /\b(?:self[- ]?promot|promot|advertis|solicit|marketing|commercial)\w*\b.{0,70}\b(?:prohibit(?:s|ed)?|forbid(?:s|den)?|not allowed)\b/i.test(rules)
  const proposedPromotion =
    /\b(?:mention|offer|pitch|promot|advertis|solicit|market)\w*\b.{0,50}\b(?:service|business|professional help|agent|realtor)\w*/i.test(proposedAction)
    || /\b(?:contact|direct message|dm)\w*\b/i.test(proposedAction)
  const professionalParticipationForbidden =
    /\b(?:agent|realtor|industry|professional|business|commercial)\w*\b.{0,50}\b(?:may not|must not|cannot|can't|prohibit(?:ed)?|forbid(?:den)?|not allowed)\b.{0,30}\b(?:participat|post|comment|reply|contribut)/i.test(rules)
    || /\b(?:no|prohibit(?:s|ed)?|forbid(?:s|den)?|not allowed)\b.{0,50}\b(?:agent|realtor|industry|professional|business|commercial)\w*\b/i.test(rules)
    || /\b(?:agents?|realtors?|brokers?|lenders?|industry professionals?)\b.{0,80}\b(?:may not|must not|cannot|can't|prohibited|forbidden|not allowed)\b/i.test(rules)
    || /\bnot allow(?:ed|ing)?\b.{0,80}\b(?:agents?|realtors?|brokers?|lenders?|industry professionals?)\b.{0,80}\b(?:attend|participat|register|join)\w*/i.test(rules)
    || /\b(?:agents?|realtors?|brokers?|lenders?|industry professionals?)\b.{0,80}\b(?:not allow(?:ed|ing)?|may not|must not|cannot|can't|prohibited|forbidden)\b.{0,80}\b(?:attend|participat|register|join)\w*/i.test(rules)

  if (professionalParticipationForbidden || (promotionRestricted && proposedPromotion)) return 'fail'
  return 'pass'
}

const PUBLIC_EVENT_POST = /\b(?:event|fair|workshop|seminar|webinar|class|meetup|panel|clinic|home tour)\b/i

function effectiveOpportunityIdentity(
  identity: Record<string, unknown>,
  observedText: string,
  referenceTime: Date | null,
): { identity: Record<string, unknown>; kind: string | null } {
  const kind = stringValue(identity, ['opportunity_kind'])
  if (kind !== 'post' || !PUBLIC_EVENT_POST.test(observedText)) {
    return { identity, kind }
  }
  const eventStart = resolveOpportunityEventStart(
    identity.event_start_at,
    observedText,
    referenceTime,
  )
  if (!eventStart) return { identity, kind }
  // Public search sources frequently return an event as a social post URL.
  // The URL shape describes the container, while the returned content and
  // date prove the actual participation surface. Score that bounded evidence
  // as an event so future dates, expiry, relevance, and event-safe actions are
  // evaluated consistently. Query text and provider targeting are absent from
  // this decision, so they still cannot manufacture an event.
  return {
    identity: {
      ...identity,
      opportunity_kind: 'event',
      event_start_at: eventStart.toISOString(),
    },
    kind: 'event',
  }
}

function scoreOpportunity(
  identity: Record<string, unknown>,
  play: FitPlayInput,
  evidence: CandidateEvidence[],
  referenceTime: Date | null,
): FitResult {
  if (evidence.length === 0) {
    return result(0, 'rejected', FIT_REASONS.noEvidence, EMPTY_BREAKDOWN, [], ['no_supporting_evidence'])
  }
  const observedText = opportunityEvidenceText(identity, evidence)
  const effective = effectiveOpportunityIdentity(identity, observedText, referenceTime)
  const opportunityKind = effective.kind
  const platform = stringValue(identity, ['platform'])
  const recommendedAction = stringValue(identity, ['recommended_action'])
  const messageAngle = stringValue(identity, ['message_angle'])
  const participationRules = stringValue(identity, ['participation_rules'])
  const participationRulesStatus = stringValue(identity, ['participation_rules_status'])
  const expectedIntent = expectedOpportunityIntent(play)
  const audienceExpected = expectedAudience(play)
  const geographyExpected = expectedGeographies(play)
  const locations = observedValues(identity, ['location', 'city', 'region'])
  const targetingLocations = observedValues(identity, ['provider_location'])
  const countryCode = stringValue(identity, ['country_code', 'countryCode'])?.toUpperCase() ?? null
  const destination = assessOpportunityDestination({
    identity: effective.identity,
    evidence,
    referenceTime,
    maxAgeDays: recencyDays(play.recencyWindow),
    content: observedText,
  })
  const demonstratedIntent = classifyOpportunityIntentAtDestination(
    observedText,
    destination.canonicalUrl,
  )
  const isRealtorPlay = /\b(?:realtor|real estate|homeowners?|home ?buyers?|home ?sellers?|buy(?:ing)? a home|sell(?:ing)? a home|home for sale|price a home|housing)\b/i.test(
    [...audienceExpected, ...expectedIntent, ...geographyExpected].join(' '),
  )
  const requestedIntent = expectedIntent.find((value) =>
    ['buyer_intent', 'seller_intent', 'local_audience', 'mixed_intent'].includes(value),
  ) as 'buyer_intent' | 'seller_intent' | 'local_audience' | 'mixed_intent' | undefined
  const suitability = assessRealtorOpportunitySuitability(
    observedText,
    requestedIntent ?? null,
    destination.canonicalUrl,
    opportunityKind,
  )
  const accessObserved = stringValue(identity, ['access_type'])
  const destinationObserved = [
    ...(destination.canonicalUrl ? [destination.canonicalUrl] : []),
    ...(accessObserved ? [accessObserved] : []),
    ...destination.issues,
  ]
  const audienceStatus =
    audienceExpected.length === 0
      ? 'unknown'
      : isRealtorPlay && suitability.relevant
        ? 'pass'
        : !isRealtorPlay && semanticallyMatches(audienceExpected, observedText)
          ? 'pass'
        : observedText.trim()
          ? 'fail'
          : 'unknown'
  const observedIntent = demonstratedIntent.kind
  const intentStatus =
    expectedIntent.length === 0 || observedIntent == null
      ? 'unknown'
      : intentMatchesLane(expectedIntent, observedIntent)
        ? 'pass'
        : 'fail'
  const sourceGeographyConflict = publicSourceGeographyConflict(
    destination.canonicalUrl,
    geographyExpected,
    observedText,
  )
  const sourceGeographyEvidence = demonstratedPublicSourceGeography(
    destination.canonicalUrl,
    geographyExpected,
  )
  const geoStatus = sourceGeographyConflict
    ? 'fail'
    : sourceGeographyEvidence
      ? 'pass'
    : geographyCriterionStatus(
        geographyExpected,
        locations,
        targetingLocations,
        countryCode,
        observedText,
      )
  const freshStatus: CriterionStatus = destination.issues.includes('stale_destination')
    || destination.issues.includes('event_expired')
    ? 'fail'
    : destination.issues.includes('destination_freshness_unknown')
      || destination.issues.includes('event_time_unknown')
      ? 'unknown'
      : 'pass'
  const actionStatus = opportunityActionabilityStatus({
    recommendedAction,
    messageAngle,
    participationRules,
    participationRulesStatus,
    sourceContent: observedText,
  })
  const noise = isRealtorPlay
    ? realtorOpportunityNoiseReasons(observedText, destination.canonicalUrl)
    : []
  const criteria: CriterionResult[] = [
    criterion(
      'opportunity.destination',
      'account',
      'Public destination',
      ['live public HTTPS destination'],
      destinationObserved,
      destination.status,
    ),
    criterion(
      'opportunity.audience',
      'account',
      'Play audience relevance',
      audienceExpected,
      observedText ? [observedText] : [],
      audienceStatus,
    ),
    criterion(
      'opportunity.intent',
      'persona',
      'Demand intent lane',
      expectedIntent,
      observedIntent
        ? [
            observedIntent,
            ...demonstratedIntent.buyerSignals,
            ...demonstratedIntent.sellerSignals,
            ...demonstratedIntent.localAudienceSignals,
          ]
        : [],
      intentStatus,
    ),
    criterion(
      'geography.location',
      'geography',
      'Location',
      geographyExpected,
      [
        ...locations,
        ...(sourceGeographyConflict ? [`destination conflict: ${sourceGeographyConflict}`] : []),
        ...(sourceGeographyEvidence ? [`destination locality: ${sourceGeographyEvidence}`] : []),
        ...geographyExpected
          .map((value) => demonstratedOpportunityLocation(observedText, value))
          .filter((value): value is string => Boolean(value)),
      ],
      geoStatus,
    ),
    criterion(
      'signal.freshness',
      'signal',
      'Destination freshness',
      play.recencyWindow ? [play.recencyWindow] : ['current'],
      [
        ...(destination.newestObservation ? [destination.newestObservation] : []),
        ...(destination.ageDays == null ? [] : [`${Math.floor(destination.ageDays)} days old`]),
      ],
      freshStatus,
    ),
    criterion(
      'opportunity.actionability',
      'signal',
      'Manual next action',
      ['source-observed participation rules and a compatible venue-appropriate manual action'],
      [
        participationRulesStatus ? `rules_status:${participationRulesStatus}` : null,
        participationRules,
        recommendedAction,
        messageAngle,
      ].filter((value): value is string => Boolean(value)),
      actionStatus,
      false,
    ),
    criterion(
      'exclusion.realtor_noise',
      'exclusion',
      'Realtor false positives',
      ['no provider-origin promotion, listing inventory, recruiting, lead sales, jobs, or generic news'],
      noise,
      noise.length > 0 ? 'fail' : 'pass',
    ),
  ]
  const profile: QualificationProfile = {
    version: 'qualification-profile-v4',
    criteria: criteria.map(({ id, dimension, label, expected, hard }) => ({ id, dimension, label, expected, hard })),
  }
  const unknowns = [
    ...(!opportunityKind ? ['opportunity_kind'] : []),
    ...(!platform ? ['platform'] : []),
    ...criteria.filter((row) => row.status === 'unknown').map((row) => row.id),
  ]
  const contradictions = criteria.filter((row) => row.status === 'fail').map((row) => row.id)
  const avgConfidence = averageConfidence(evidence)
  const earned = (status: CriterionStatus, pass: number, unknown: number) =>
    status === 'pass' ? pass : status === 'unknown' ? unknown : 0
  const breakdown: FitBreakdown = {
    identity: earned(destination.status, 15, 6),
    account: earned(audienceStatus, 25, 7),
    persona: earned(intentStatus, 20, 5),
    geography: earned(geoStatus, 15, 5),
    evidence:
      avgConfidence * 12.5 + earned(freshStatus, 7.5, 2.5) + earned(actionStatus, 5, 1.5),
  }
  const fitScore = Object.values(breakdown).reduce((sum, value) => sum + value, 0)
  if (noise.length > 0) {
    return result(Math.min(fitScore, 15), 'rejected', FIT_REASONS.realtorNoise, breakdown, unknowns, contradictions, profile, criteria)
  }
  if (destination.status === 'fail') {
    const reason = destination.issues.includes('event_expired')
      || destination.issues.includes('destination_inactive')
      ? FIT_REASONS.expiredDestination
      : destination.issues.includes('missing_or_invalid_public_destination')
        ? FIT_REASONS.missingDestination
        : FIT_REASONS.inaccessibleDestination
    return result(Math.min(fitScore, 20), 'rejected', reason, breakdown, unknowns, contradictions, profile, criteria)
  }
  if (intentStatus === 'fail') {
    return result(Math.min(fitScore, 30), 'rejected', FIT_REASONS.intentMismatch, breakdown, unknowns, contradictions, profile, criteria)
  }
  if (audienceStatus === 'fail') {
    return result(Math.min(fitScore, 25), 'rejected', FIT_REASONS.audienceMismatch, breakdown, unknowns, contradictions, profile, criteria)
  }
  if (geoStatus === 'fail') {
    return result(Math.min(fitScore, 20), 'rejected', FIT_REASONS.outsideGeography, breakdown, unknowns, contradictions, profile, criteria)
  }
  if (freshStatus === 'fail') {
    return result(Math.min(fitScore, 10), 'rejected', FIT_REASONS.staleSignal, breakdown, unknowns, contradictions, profile, criteria)
  }
  if (actionStatus === 'fail') {
    return result(Math.min(fitScore, 20), 'rejected', FIT_REASONS.notActionable, breakdown, unknowns, contradictions, profile, criteria)
  }
  if (criteria.some((row) => row.hard && row.status === 'unknown')) {
    return result(
      Math.min(fitScore, FIT_ACCEPT_THRESHOLD - 1),
      'review',
      FIT_REASONS.criterionUnknown,
      breakdown,
      unknowns,
      contradictions,
      profile,
      criteria,
    )
  }
  if (fitScore >= FIT_ACCEPT_THRESHOLD && avgConfidence >= 0.5 && actionStatus === 'pass') {
    return result(fitScore, 'accepted', FIT_REASONS.accepted, breakdown, unknowns, contradictions, profile, criteria)
  }
  if (fitScore >= FIT_REVIEW_THRESHOLD) {
    return result(
      Math.min(fitScore, FIT_ACCEPT_THRESHOLD - 1),
      'review',
      avgConfidence < 0.5 ? FIT_REASONS.weakEvidence : FIT_REASONS.review,
      breakdown,
      unknowns,
      contradictions,
      profile,
      criteria,
    )
  }
  return result(
    fitScore,
    'rejected',
    FIT_REASONS.irrelevantOpportunity,
    breakdown,
    unknowns,
    contradictions,
    profile,
    criteria,
  )
}

function stringValue(identity: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = identity[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function averageConfidence(evidence: CandidateEvidence[]): number {
  if (evidence.length === 0) return 0
  return (
    evidence.reduce((total, row) => {
      const value = Number(row.confidence)
      return total + (Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0)
    }, 0) / evidence.length
  )
}

function normalized(value: unknown): string {
  return typeof value === 'string'
    ? value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9+]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : ''
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]
}

function observedValues(identity: Record<string, unknown>, fields: string[]): string[] {
  const values: string[] = []
  for (const field of fields) {
    const value = identity[field]
    if (typeof value === 'string' && value.trim()) values.push(value.trim())
    else if (typeof value === 'number' && Number.isFinite(value)) values.push(String(value))
    else if (Array.isArray(value)) {
      values.push(...value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())))
    }
  }
  return [...new Set(values)]
}

/*
 * Curated equivalences applied to BOTH sides before matching. Only exact,
 * unambiguous synonyms belong here: an over-broad entry turns a real mismatch
 * into a false accept, which is the failure mode this scorer exists to avoid.
 * The first entry of each group is the canonical form.
 */
const ALIAS_GROUPS: string[][] = [
  ['vice president', 'vp'],
  ['senior vice president', 'svp'],
  ['executive vice president', 'evp'],
  ['chief executive officer', 'ceo'],
  ['chief technology officer', 'chief technical officer', 'cto'],
  ['chief financial officer', 'cfo'],
  ['chief operating officer', 'coo'],
  ['chief marketing officer', 'cmo'],
  ['chief information officer', 'cio'],
  ['chief information security officer', 'ciso'],
  ['chief revenue officer', 'cro'],
  ['chief product officer', 'cpo'],
  ['human resources', 'hr'],
  ['information technology', 'it'],
  ['operations', 'ops'],
  ['business development', 'bizdev', 'biz dev'],
  ['sales development representative', 'sdr'],
  ['business development representative', 'bdr'],
  // Provider taxonomies describe the same local-business vertical at
  // different levels (industry versus Maps category). These are deliberately
  // narrow: veterinary and hospital categories are not included.
  ['dentistry', 'dentist', 'dental clinic', 'cosmetic dentist', 'emergency dental service', 'dental implants provider'],
  ['medical practices', 'medical practice', 'medical clinic', 'doctor'],
  ['optometry', 'optometrist', 'optometry office', 'eye care center'],
  ['senior', 'sr'],
  ['junior', 'jr'],
  ['manager', 'mgr'],
  ['director', 'dir'],
  // US state code / name pairs. Providers return the code (LeadMagic sends
  // contact_state_code) while a play names the state, so without these every
  // location criterion hard-fails on "Austin, TX" versus "Austin, Texas".
  ['alabama', 'al'],
  ['alaska', 'ak'],
  ['arizona', 'az'],
  ['arkansas', 'ar'],
  ['california', 'ca'],
  ['colorado', 'co'],
  ['connecticut', 'ct'],
  ['delaware', 'de'],
  ['florida', 'fl'],
  ['georgia', 'ga'],
  ['hawaii', 'hi'],
  ['idaho', 'id'],
  ['illinois', 'il'],
  ['indiana', 'in'],
  ['iowa', 'ia'],
  ['kansas', 'ks'],
  ['kentucky', 'ky'],
  ['louisiana', 'la'],
  ['maine', 'me'],
  ['maryland', 'md'],
  ['massachusetts', 'ma'],
  ['michigan', 'mi'],
  ['minnesota', 'mn'],
  ['mississippi', 'ms'],
  ['missouri', 'mo'],
  ['montana', 'mt'],
  ['nebraska', 'ne'],
  ['nevada', 'nv'],
  ['new hampshire', 'nh'],
  ['new jersey', 'nj'],
  ['new mexico', 'nm'],
  ['new york', 'ny'],
  ['north carolina', 'nc'],
  ['north dakota', 'nd'],
  ['ohio', 'oh'],
  ['oklahoma', 'ok'],
  ['oregon', 'or'],
  ['pennsylvania', 'pa'],
  ['rhode island', 'ri'],
  ['south carolina', 'sc'],
  ['south dakota', 'sd'],
  ['tennessee', 'tn'],
  ['texas', 'tx'],
  ['utah', 'ut'],
  ['vermont', 'vt'],
  ['virginia', 'va'],
  ['washington', 'wa'],
  ['west virginia', 'wv'],
  ['wisconsin', 'wi'],
  ['wyoming', 'wy'],
  ['district of columbia', 'dc'],
  ['united states', 'usa', 'us'],
]

const ALIAS_CANONICAL = new Map<string, string>()
let ALIAS_MAX_WORDS = 1
for (const group of ALIAS_GROUPS) {
  const canonical = `~${normalized(group[0]).replace(/\s+/g, '_')}`
  for (const form of group) {
    const phrase = normalized(form)
    if (!phrase) continue
    ALIAS_CANONICAL.set(phrase, canonical)
    ALIAS_MAX_WORDS = Math.max(ALIAS_MAX_WORDS, phrase.split(' ').length)
  }
}

/* Normalizes, then greedily rewrites the longest recognised alias phrase at
 * each position into its canonical token. */
function canonicalTokens(text: string): string[] {
  const tokens = normalized(text).split(' ').filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < tokens.length; ) {
    let matched = false
    for (let length = Math.min(ALIAS_MAX_WORDS, tokens.length - i); length >= 1; length -= 1) {
      const canonical = ALIAS_CANONICAL.get(tokens.slice(i, i + length).join(' '))
      if (canonical) {
        out.push(canonical)
        i += length
        matched = true
        break
      }
    }
    if (!matched) {
      out.push(tokens[i])
      i += 1
    }
  }
  return out
}

function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) return true
  }
  return false
}

/*
 * Matching is TOKEN-based, never raw substring. Substring containment made
 * short expected values match unrelated text outright: expected "IT" passed
 * against an observed "Digital Marketing", and "AI" passed against "Retail",
 * because the letters happen to appear inside the word.
 *
 * Direction matters. The observed value must contain what the play asked for,
 * not the reverse: an observed "Engineering" does not prove "Head of
 * Engineering". Only the observed side may be broader.
 */
function wordsMatch(observed: string, expected: string): boolean {
  const haystack = canonicalTokens(observed)
  const needle = canonicalTokens(expected)
  if (!haystack.length || !needle.length) return false
  if (containsSequence(haystack, needle)) return true
  // Multi-word expectations may appear out of order or split by extra words,
  // so "VP Sales" still matches "Vice President, Global Sales".
  return needle.length > 1 && needle.every((token) => haystack.includes(token))
}

function parseRange(value: string): { min: number; max: number } | null {
  const clean = value
    .toLowerCase()
    .replace(/,/g, '')
    .replace(/\b(to|employees?|people|staff)\b/g, '-')
  const numbers = clean.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? []
  if (numbers.length >= 2)
    return {
      min: Math.min(numbers[0], numbers[1]),
      max: Math.max(numbers[0], numbers[1]),
    }
  if (numbers.length === 1 && /\+|over|more than/.test(clean)) return { min: numbers[0], max: Number.POSITIVE_INFINITY }
  if (numbers.length === 1 && /under|less than|up to/.test(clean)) return { min: 0, max: numbers[0] }
  return null
}

type EmployeeRangeMatch = 'pass' | 'fail' | 'unknown'

function employeeRangeMatch(observed: string, expected: string): EmployeeRangeMatch {
  if (wordsMatch(observed, expected)) return 'pass'
  const desired = parseRange(expected)
  if (!desired) return 'fail'
  const count = Number(observed.replace(/,/g, ''))
  if (Number.isFinite(count)) return count >= desired.min && count <= desired.max ? 'pass' : 'fail'
  const actual = parseRange(observed)
  if (!actual) return 'fail'
  if (actual.min >= desired.min && actual.max <= desired.max) return 'pass'
  if (actual.max < desired.min || actual.min > desired.max) return 'fail'
  // Provider buckets that only partially overlap the requested ICP do not
  // prove either membership or contradiction for this specific company.
  return 'unknown'
}

function employeeRangeStatus(observed: string[], expected: string[]): EmployeeRangeMatch {
  let sawUnknown = false
  for (const desired of expected) {
    for (const actual of observed) {
      const status = employeeRangeMatch(actual, desired)
      if (status === 'pass') return 'pass'
      if (status === 'unknown') sawUnknown = true
    }
  }
  return sawUnknown ? 'unknown' : 'fail'
}

/*
 * Provider company records can contain both an exact employee count and a
 * coarse LinkedIn bucket. The exact count is stronger evidence. Evaluating
 * the two observations as an unordered set lets a stale/conflicting bucket
 * override a definitive count (for example count 53 + bucket 11-50). Only a
 * scalar numeric field is treated as exact; range-looking strings continue
 * through the conservative overlap logic above.
 */
function exactEmployeeCount(identity: Record<string, unknown>): number | null {
  for (const key of ['employee_count', 'employees']) {
    const value = identity[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    if (typeof value === 'string' && /^\s*\d[\d,]*(?:\.\d+)?\s*$/.test(value)) {
      const parsed = Number(value.replace(/,/g, '').trim())
      if (Number.isFinite(parsed) && parsed >= 0) return parsed
    }
  }
  return null
}

function recencyDays(value: string | null | undefined): number | null {
  const text = (value ?? '').trim().toLowerCase()
  const amount = Number(text.match(/\d+(?:\.\d+)?/)?.[0])
  if (!Number.isFinite(amount) || amount <= 0) return null
  if (/day/.test(text)) return Math.ceil(amount)
  if (/week/.test(text)) return Math.ceil(amount * 7)
  if (/month/.test(text)) return Math.ceil(amount * 30)
  if (/year/.test(text)) return Math.ceil(amount * 365)
  return null
}

function addCriterion(
  output: CriterionDefinition[],
  query: Record<string, unknown>,
  key: string,
  definition: Omit<CriterionDefinition, 'expected'>,
) {
  const expected = strings(query[key])
  if (expected.length) output.push({ ...definition, expected })
}

function compileDefinitions(play: FitPlayInput, candidateKind: Candidate['entity_kind']): CriterionDefinition[] {
  const query = play.providerQuery ?? {}
  const definitions: CriterionDefinition[] = []
  addCriterion(definitions, query, 'industries', {
    id: 'account.industry',
    dimension: 'account',
    label: 'Industry',
    hard: true,
    fields: ['industry', 'company_industry', 'company_industry_linkedin'],
  })
  addCriterion(definitions, query, 'company_keywords', {
    id: 'account.keywords',
    dimension: 'account',
    label: 'Company keywords',
    hard: true,
    fields: ['description', 'company_description', 'company_headline', 'specialties', 'industry'],
    useEvidence: true,
  })
  addCriterion(definitions, query, 'employee_ranges', {
    id: 'account.employee_range',
    dimension: 'account',
    label: 'Company size',
    hard: true,
    fields: ['employee_range', 'employee_count', 'employees', 'company_size'],
    employeeRange: true,
  })
  addCriterion(definitions, query, 'technologies', {
    id: 'account.technologies',
    dimension: 'account',
    label: 'Technology',
    hard: true,
    fields: ['technologies', 'tech_stack'],
    useEvidence: true,
  })
  if (candidateKind === 'person') {
    addCriterion(definitions, query, 'titles', {
      id: 'persona.title',
      dimension: 'persona',
      label: 'Title',
      hard: true,
      fields: ['title', 'job_title'],
    })
    addCriterion(definitions, query, 'roles', {
      id: 'persona.role',
      dimension: 'persona',
      label: 'Role',
      hard: true,
      fields: ['role', 'title', 'job_title', 'persona'],
    })
    addCriterion(definitions, query, 'seniorities', {
      id: 'persona.seniority',
      dimension: 'persona',
      label: 'Seniority',
      hard: true,
      fields: ['seniority', 'job_level'],
    })
    addCriterion(definitions, query, 'departments', {
      id: 'persona.department',
      dimension: 'persona',
      label: 'Department',
      hard: true,
      fields: ['department', 'job_function'],
    })
  }
  addCriterion(definitions, query, 'locations', {
    id: 'geography.location',
    dimension: 'geography',
    label: 'Location',
    hard: true,
    fields: ['location', 'city', 'geography', 'region'],
    targetingFields: ['provider_location'],
  })

  const exclusionSpecs = [
    ['exclude_industries', 'exclusion.industry', 'Excluded industry', ['industry', 'company_industry']],
    [
      'exclude_company_keywords',
      'exclusion.keyword',
      'Excluded company keyword',
      ['name', 'company', 'company_name', 'description', 'industry', 'domain'],
    ],
    ['exclude_technologies', 'exclusion.technology', 'Excluded technology', ['technologies', 'tech_stack']],
    ['exclude_titles', 'exclusion.title', 'Excluded title', ['title', 'job_title']],
    ['exclude_roles', 'exclusion.role', 'Excluded role', ['role', 'title', 'job_title', 'persona']],
  ] as const
  for (const [key, id, label, fields] of exclusionSpecs) {
    if (candidateKind === 'company' && (key === 'exclude_titles' || key === 'exclude_roles')) continue
    addCriterion(definitions, query, key, {
      id,
      dimension: 'exclusion',
      label,
      hard: true,
      fields: [...fields],
      exclusion: true,
    })
  }
  const maxAge = recencyDays(play.recencyWindow)
  if (maxAge != null) {
    definitions.push({
      id: 'signal.recency',
      dimension: 'signal',
      label: 'Signal recency',
      hard: true,
      expected: [`within ${maxAge} days`],
      fields: [],
      recencyDays: maxAge,
    })
  }
  return definitions
}

export function compileQualificationProfile(
  play: FitPlayInput,
  candidateKind: Candidate['entity_kind'],
): QualificationProfile {
  if (candidateKind === 'opportunity') {
    const rows: QualificationProfile['criteria'] = [
      {
        id: 'opportunity.destination',
        dimension: 'account',
        label: 'Public destination',
        expected: ['live public HTTPS destination'],
        hard: true,
      },
      {
        id: 'opportunity.audience',
        dimension: 'account',
        label: 'Play audience relevance',
        expected: expectedAudience(play),
        hard: true,
      },
      {
        id: 'opportunity.intent',
        dimension: 'persona',
        label: 'Demand intent lane',
        expected: expectedOpportunityIntent(play),
        hard: true,
      },
      {
        id: 'geography.location',
        dimension: 'geography',
        label: 'Location',
        expected: expectedGeographies(play),
        hard: true,
      },
      {
        id: 'signal.freshness',
        dimension: 'signal',
        label: 'Destination freshness',
        expected: play.recencyWindow ? [play.recencyWindow] : ['current'],
        hard: true,
      },
      {
        id: 'opportunity.actionability',
        dimension: 'signal',
        label: 'Manual next action',
        expected: ['source-observed participation rules and a compatible venue-appropriate manual action'],
        hard: false,
      },
      {
        id: 'exclusion.realtor_noise',
        dimension: 'exclusion',
        label: 'Realtor false positives',
        expected: ['no provider-origin promotion, listing inventory, recruiting, lead sales, jobs, or generic news'],
        hard: true,
      },
    ]
    return { version: 'qualification-profile-v4', criteria: rows }
  }
  return {
    version: 'qualification-profile-v4',
    criteria: compileDefinitions(play, candidateKind).map(({ id, dimension, label, expected, hard }) => ({
      id,
      dimension,
      label,
      expected,
      hard,
    })),
  }
}

function evaluateCriterion(
  definition: CriterionDefinition,
  identity: Record<string, unknown>,
  evidence: CandidateEvidence[],
  referenceTime: Date | null,
): CriterionResult {
  if (definition.recencyDays != null) {
    const observed = evidence.map((row) => row.observed_at).filter(Boolean)
    const newest = observed
      .map((value) => new Date(value).getTime())
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0]
    // Without a trustworthy reference time, age is unknowable. It must NOT
    // default to the evidence's own timestamp, which makes every signal look
    // zero days old and silently passes a hard recency gate.
    const ageDays =
      newest == null || referenceTime == null ? null : Math.max(0, (referenceTime.getTime() - newest) / 86_400_000)
    return {
      id: definition.id,
      dimension: definition.dimension,
      label: definition.label,
      expected: definition.expected,
      observed: ageDays == null ? [] : [`${Math.floor(ageDays)} days old`],
      status: ageDays == null ? 'unknown' : ageDays <= definition.recencyDays ? 'pass' : 'fail',
      hard: true,
    }
  }
  const identityValues = observedValues(identity, definition.fields)
  const targetingValues = observedValues(identity, definition.targetingFields ?? [])
  const evidenceValues = definition.useEvidence
    ? evidence.flatMap((row) => [
        row.claim,
        ...Object.values(row.detail ?? {}).filter((value): value is string => typeof value === 'string'),
      ])
    : []
  const observed = [...new Set([...identityValues, ...evidenceValues])]
  if (observed.length === 0) {
    return {
      id: definition.id,
      dimension: definition.dimension,
      label: definition.label,
      expected: definition.expected,
      observed: [],
      status: 'unknown',
      hard: definition.hard,
    }
  }
  const rangeStatus = definition.employeeRange
    ? (() => {
        const exactCount = exactEmployeeCount(identity)
        return employeeRangeStatus(exactCount == null ? observed : [String(exactCount)], definition.expected)
      })()
    : null
  const matches =
    rangeStatus === 'pass' ||
    (rangeStatus === null &&
      definition.expected.some((expected) => observed.some((actual) => wordsMatch(actual, expected))))
  const targetingMatches = definition.expected.some((expected) =>
    targetingValues.some((actual) => wordsMatch(actual, expected)),
  )
  if (rangeStatus === 'unknown') {
    return {
      id: definition.id,
      dimension: definition.dimension,
      label: definition.label,
      expected: definition.expected,
      observed,
      status: 'unknown',
      hard: definition.hard,
    }
  }
  // Generic provider evidence proves the row was sourced, but a claim that
  // omits the criterion cannot prove a contradiction. Only exposed identity
  // fields can turn a non-match into a hard fail.
  if (!matches && identityValues.length === 0 && evidenceValues.length > 0) {
    return {
      id: definition.id,
      dimension: definition.dimension,
      label: definition.label,
      expected: definition.expected,
      observed: evidenceValues,
      status: 'unknown',
      hard: definition.hard,
    }
  }
  // A Maps task targeted at a county can legitimately return an address that
  // names only a city inside that county. The target therefore prevents a
  // false hard rejection, but it cannot establish boundary membership: Maps
  // may also return nearby entities outside that county. Keep the criterion
  // unknown until result-level geography proves it.
  if (!matches && targetingMatches) {
    return {
      id: definition.id,
      dimension: definition.dimension,
      label: definition.label,
      expected: definition.expected,
      observed: [...observed, ...targetingValues],
      status: 'unknown',
      hard: definition.hard,
    }
  }
  return {
    id: definition.id,
    dimension: definition.dimension,
    label: definition.label,
    expected: definition.expected,
    observed,
    status: definition.exclusion ? (matches ? 'fail' : 'pass') : matches ? 'pass' : 'fail',
    hard: definition.hard,
  }
}

function criterionScore(
  criteria: CriterionResult[],
  dimension: CriterionResult['dimension'],
  fallback: number,
  max: number,
): number {
  const relevant = criteria.filter((row) => row.dimension === dimension)
  if (relevant.length === 0) return fallback
  const earned = relevant.reduce(
    (sum, row) => sum + (row.status === 'pass' ? 1 : row.status === 'unknown' ? 0.35 : 0),
    0,
  )
  return (earned / relevant.length) * max
}

export const ruleBasedFitScorer: FitScorer = {
  score(candidate, play, evidence): FitResult {
    const identity = (candidate.identity ?? {}) as Record<string, unknown>
    const name = stringValue(identity, ['name'])
    if (!name) {
      return result(0, 'rejected', FIT_REASONS.missingName, EMPTY_BREAKDOWN, [], ['missing_identity_name'])
    }

    const entityUnit = (play.entityUnit ?? '').trim()
    const mismatch =
      entityUnit &&
      ((unitWantsCompany(entityUnit) && candidate.entity_kind !== 'company') ||
        (unitWantsPerson(entityUnit) && candidate.entity_kind !== 'person') ||
        (unitWantsOpportunity(entityUnit) && candidate.entity_kind !== 'opportunity'))
    if (mismatch) {
      return result(0, 'rejected', FIT_REASONS.entityKindMismatch, EMPTY_BREAKDOWN, [], ['entity_kind_mismatch'])
    }

    const location = stringValue(identity, ['location', 'city', 'geography', 'region'])
    const countryCode = stringValue(identity, ['country_code', 'countryCode'])?.toUpperCase() ?? null
    const playGeography = (play.geography ?? '').trim()
    if (
      playGeography &&
      isUsGeography(playGeography) &&
      ((countryCode && countryCode !== 'US' && countryCode !== 'USA') || (location && !isUsGeography(location)))
    ) {
      return result(0, 'rejected', FIT_REASONS.outsideGeography, EMPTY_BREAKDOWN, [], ['outside_play_geography'])
    }
    if (evidence.length === 0) {
      return result(0, 'rejected', FIT_REASONS.noEvidence, EMPTY_BREAKDOWN, [], ['no_supporting_evidence'])
    }

    const parsedReference =
      play.referenceTime instanceof Date
        ? play.referenceTime
        : play.referenceTime != null
          ? new Date(play.referenceTime)
          : null
    const referenceTime = parsedReference && Number.isFinite(parsedReference.getTime()) ? parsedReference : null
    if (candidate.entity_kind === 'opportunity') {
      return scoreOpportunity(identity, play, evidence, referenceTime)
    }

    const definitions = compileDefinitions(play, candidate.entity_kind)
    const profile = compileQualificationProfile(play, candidate.entity_kind)
    const criteria = definitions.map((definition) => evaluateCriterion(definition, identity, evidence, referenceTime))
    const domain = stringValue(identity, ['domain'])
    const company = stringValue(identity, ['company', 'company_name'])
    const title = stringValue(identity, ['title', 'job_title'])
    const industry = stringValue(identity, ['industry'])
    const avgConfidence = averageConfidence(evidence)
    const unknowns: string[] = []
    if (!domain) unknowns.push('domain')
    if (!location) unknowns.push('geography')
    if (candidate.entity_kind === 'person' && !title) unknowns.push('title')
    if (candidate.entity_kind === 'company' && !industry) unknowns.push('industry')
    unknowns.push(...criteria.filter((row) => row.status === 'unknown').map((row) => row.id))

    const contradictions = criteria.filter((row) => row.status === 'fail').map((row) => row.id)
    const breakdown: FitBreakdown = {
      identity: 15,
      account: criterionScore(criteria, 'account', domain || company ? 25 : 8, 25),
      persona: criterionScore(
        criteria,
        'persona',
        candidate.entity_kind === 'person' ? (title ? 20 : 8) : industry ? 20 : 10,
        20,
      ),
      geography: criterionScore(criteria, 'geography', location ? 15 : 7, 15),
      evidence: avgConfidence * 25,
    }
    const fitScore = Object.values(breakdown).reduce((sum, value) => sum + value, 0)
    const exclusionFailure = criteria.find((row) => row.dimension === 'exclusion' && row.status === 'fail')
    if (exclusionFailure) {
      return result(fitScore, 'rejected', FIT_REASONS.excluded, breakdown, unknowns, contradictions, profile, criteria)
    }
    const hardFailure = criteria.find((row) => row.hard && row.status === 'fail')
    if (hardFailure) {
      const reason = hardFailure.id === 'signal.recency' ? FIT_REASONS.staleSignal : FIT_REASONS.criterionMismatch
      return result(fitScore, 'rejected', reason, breakdown, unknowns, contradictions, profile, criteria)
    }
    if (criteria.some((row) => row.hard && row.status === 'unknown')) {
      return result(
        fitScore,
        'review',
        FIT_REASONS.criterionUnknown,
        breakdown,
        unknowns,
        contradictions,
        profile,
        criteria,
      )
    }
    if (fitScore >= FIT_ACCEPT_THRESHOLD && avgConfidence >= 0.5) {
      return result(fitScore, 'accepted', FIT_REASONS.accepted, breakdown, unknowns, contradictions, profile, criteria)
    }
    if (fitScore >= FIT_REVIEW_THRESHOLD) {
      return result(
        fitScore,
        'review',
        avgConfidence < 0.5 ? FIT_REASONS.weakEvidence : FIT_REASONS.review,
        breakdown,
        unknowns,
        contradictions,
        profile,
        criteria,
      )
    }
    return result(
      fitScore,
      'rejected',
      FIT_REASONS.belowThreshold,
      breakdown,
      unknowns,
      contradictions,
      profile,
      criteria,
    )
  },
}

export type FitDistribution = {
  accepted: number
  review: number
  rejected: number
  byReason: Record<string, number>
}

export function summarizeFitResults(results: FitResult[]): FitDistribution {
  const summary: FitDistribution = {
    accepted: 0,
    review: 0,
    rejected: 0,
    byReason: {},
  }
  for (const row of results) {
    summary[row.verdict] += 1
    summary.byReason[row.reason] = (summary.byReason[row.reason] ?? 0) + 1
  }
  return summary
}
