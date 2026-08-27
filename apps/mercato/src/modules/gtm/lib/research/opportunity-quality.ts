import type { Candidate, CandidateEvidence, CandidateIdentity } from '../adapters/types'

export type DemonstratedOpportunityIntent = NonNullable<CandidateIdentity['intent_kind']> | null

export type OpportunityIntentClassification = {
  kind: DemonstratedOpportunityIntent
  buyerSignals: string[]
  sellerSignals: string[]
  localAudienceSignals: string[]
  confidence: number
}

export type OpportunityDestinationAssessment = {
  canonicalUrl: string | null
  status: 'pass' | 'fail' | 'unknown'
  issues: string[]
  newestObservation: string | null
  ageDays: number | null
}

const BUYER_SIGNALS: Array<[string, RegExp]> = [
  ['buy', /\b(?:buy|buying|buyer|buyers)\b/i],
  ['first-time buyer', /\bfirst[- ]time (?:home ?buyer|buyer|home)\b/i],
  ['home search', /\b(?:house hunt|house hunting|home search|searching for (?:a )?home)\b/i],
  ['financing education', /\b(?:mortgage|pre[- ]?approval|down payment|closing costs?)\b/i],
  ['relocation', /\b(?:relocat(?:e|ing|ion)|moving to|move to)\b/i],
  ['looking for a home', /\blooking for (?:a )?(?:home|house|condo|townhome)\b/i],
]

const SELLER_SIGNALS: Array<[string, RegExp]> = [
  ['sell', /\b(?:sell|selling|seller|sellers)\b/i],
  ['listing a home', /\blist(?:ing)? (?:a|my|our|the)? ?(?:home|house|property)\b/i],
  ['home value', /\b(?:home value|home valuation|house worth|home worth|pricing my home)\b/i],
  ['pricing a home', /\bpric(?:e|ing) (?:a|my|our|the)? ?(?:home|house|property)\b/i],
  ['prepare to sell', /\b(?:prepare|preparing|stage|staging|renovat(?:e|ing)) (?:a|my|our|the)? ?(?:home|house|property)? ?(?:to|for)? ?(?:sell|sale|listing)\b/i],
  ['downsizing', /\bdownsiz(?:e|ing)\b/i],
]

const LOCAL_AUDIENCE_SIGNALS: Array<[string, RegExp]> = [
  ['neighborhood community', /\b(?:neighbou?rhood|community|local residents?|homeowners?)\b/i],
  ['housing discussion', /\b(?:housing|homes?|real estate) (?:discussion|forum|group|community|questions?|workshop|seminar|event)\b/i],
  ['local event', /\b(?:local|community) (?:event|workshop|seminar|meetup|open house)\b/i],
  ['area guide', /\b(?:relocation|neighbou?rhood|city|area) (?:guide|questions?|discussion|group)\b/i],
]

const REALTOR_NOISE: Array<[string, RegExp]> = [
  [
    'property_listing_inventory',
    /\b(?:mls\s*#?|listed at|for sale at|new listing|just listed|price reduced|open house today)\b|\b\d+\s*(?:bed|beds|br)\b.*\b\d+(?:\.\d+)?\s*(?:bath|baths|ba)\b/i,
  ],
  [
    'agent_recruiting',
    /\b(?:join our brokerage|recruiting (?:real estate )?agents?|real estate agent jobs?|hiring realtors?|grow your real estate career)\b/i,
  ],
  [
    'agent_lead_sales',
    /\b(?:buy real estate leads?|realtor leads? for sale|lead generation for (?:agents?|realtors?)|exclusive seller leads?)\b/i,
  ],
  [
    'generic_real_estate_news',
    /\b(?:real estate news|housing market news|weekly market update|mortgage rates? (?:rose|fell|today)|market report)\b/i,
  ],
  ['real_estate_job', /\b(?:real estate|property) (?:job|career|vacancy|position|employment)\b/i],
]

const TRACKING_PARAMETER = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_[ce]id|trk|trackingId|ref_src)$/i

function matchedSignals(content: string, definitions: Array<[string, RegExp]>): string[] {
  return definitions.filter(([, pattern]) => pattern.test(content)).map(([label]) => label)
}

/**
 * Classifies only returned content. Search terms, provider targeting, and a
 * caller-supplied label are deliberately absent from this signature so they
 * cannot become evidence by accident.
 */
export function classifyOpportunityIntent(content: string): OpportunityIntentClassification {
  const buyerSignals = matchedSignals(content, BUYER_SIGNALS)
  const sellerSignals = matchedSignals(content, SELLER_SIGNALS)
  const localAudienceSignals = matchedSignals(content, LOCAL_AUDIENCE_SIGNALS)
  const kind: DemonstratedOpportunityIntent =
    buyerSignals.length > 0 && sellerSignals.length > 0
      ? 'mixed_intent'
      : buyerSignals.length > 0
        ? 'buyer_intent'
        : sellerSignals.length > 0
          ? 'seller_intent'
          : localAudienceSignals.length > 0
            ? 'local_audience'
            : null
  const strongest = Math.max(buyerSignals.length, sellerSignals.length, localAudienceSignals.length)
  const confidence = kind == null ? 0 : Math.min(0.95, 0.56 + Math.max(0, strongest - 1) * 0.1)
  return { kind, buyerSignals, sellerSignals, localAudienceSignals, confidence }
}

export function realtorOpportunityNoiseReasons(content: string, sourceUrl: string | null = null): string[] {
  const material = `${content}\n${sourceUrl ?? ''}`
  return REALTOR_NOISE.filter(([, pattern]) => pattern.test(material)).map(([reason]) => reason)
}

export function canonicalOpportunityUrl(values: unknown): string | null {
  if (!Array.isArray(values)) return null
  for (const entry of values) {
    if (typeof entry !== 'string') continue
    try {
      const url = new URL(entry)
      if (url.protocol !== 'https:') continue
      let host = url.hostname.toLowerCase().replace(/^www\./, '')
      if (host === 'twitter.com' || host === 'mobile.twitter.com') host = 'x.com'
      if (host === 'old.reddit.com' || host === 'new.reddit.com') host = 'reddit.com'
      url.hostname = host
      url.port = ''
      url.hash = ''
      url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'
      for (const key of [...url.searchParams.keys()]) {
        if (TRACKING_PARAMETER.test(key)) url.searchParams.delete(key)
      }
      const sorted = [...url.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) =>
        aKey.localeCompare(bKey) || aValue.localeCompare(bValue),
      )
      url.search = ''
      for (const [key, value] of sorted) url.searchParams.append(key, value)
      return url.toString().replace(/\/$/, '')
    } catch {
      continue
    }
  }
  return null
}

function newestObservedAt(evidence: CandidateEvidence[]): Date | null {
  const values = evidence
    .map((row) => new Date(row.observed_at))
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((left, right) => right.getTime() - left.getTime())
  return values[0] ?? null
}

export function assessOpportunityDestination(args: {
  identity: CandidateIdentity | Record<string, unknown>
  evidence: CandidateEvidence[]
  referenceTime: Date | null
  maxAgeDays: number | null
}): OpportunityDestinationAssessment {
  const identity = args.identity as Record<string, unknown>
  const canonicalUrl = canonicalOpportunityUrl([
    identity.url,
    identity.source_url,
    identity.destination_url,
    ...(Array.isArray(identity.urls) ? identity.urls : []),
  ])
  const issues: string[] = []
  if (!canonicalUrl) issues.push('missing_or_invalid_public_destination')

  const access = typeof identity.access_type === 'string' ? identity.access_type : null
  if (access === 'approval_required') issues.push('destination_requires_approval')
  else if (access === 'unknown' || access == null) issues.push('destination_access_unknown')
  else if (access !== 'public' && access !== 'ticketed') issues.push('destination_not_public')

  const newest = newestObservedAt(args.evidence)
  const ageDays =
    newest && args.referenceTime
      ? Math.max(0, (args.referenceTime.getTime() - newest.getTime()) / 86_400_000)
      : null
  if (args.maxAgeDays != null && ageDays != null && ageDays > args.maxAgeDays) issues.push('stale_destination')
  if (args.maxAgeDays != null && ageDays == null) issues.push('destination_freshness_unknown')

  const kind = typeof identity.opportunity_kind === 'string' ? identity.opportunity_kind : null
  const eventStart = typeof identity.event_start_at === 'string' ? new Date(identity.event_start_at) : null
  if (kind === 'event') {
    if (!eventStart || !Number.isFinite(eventStart.getTime())) issues.push('event_time_unknown')
    else if (args.referenceTime && eventStart.getTime() < args.referenceTime.getTime()) issues.push('event_expired')
  }

  const hardFailure = issues.some((issue) =>
    [
      'missing_or_invalid_public_destination',
      'destination_requires_approval',
      'destination_not_public',
      'stale_destination',
      'event_expired',
    ].includes(issue),
  )
  return {
    canonicalUrl,
    status: hardFailure ? 'fail' : issues.length > 0 ? 'unknown' : 'pass',
    issues,
    newestObservation: newest?.toISOString() ?? null,
    ageDays,
  }
}

export function calibratedOpportunityConfidence(args: {
  content: string
  sourceUrl: string | null
  observedAt: string
  attemptedAt: string
  engagement: number
  location: string | null
}): number {
  const intent = classifyOpportunityIntent(args.content)
  let score = 0.38
  if (args.sourceUrl?.startsWith('https://')) score += 0.12
  if (args.content.trim().length >= 40) score += 0.1
  if (args.content.trim().length >= 120) score += 0.04
  score += intent.confidence * 0.16
  if (args.engagement > 0) score += 0.05
  if (args.engagement >= 5) score += 0.04
  if (args.engagement >= 25) score += 0.03
  if (args.location?.trim()) score += 0.04
  const observed = new Date(args.observedAt)
  const attempted = new Date(args.attemptedAt)
  if (Number.isFinite(observed.getTime()) && Number.isFinite(attempted.getTime())) {
    const ageDays = Math.max(0, (attempted.getTime() - observed.getTime()) / 86_400_000)
    if (ageDays <= 30) score += 0.04
    if (observed.getTime() > attempted.getTime() + 5 * 60_000) score -= 0.25
  }
  return Math.round(Math.max(0.2, Math.min(0.95, score)) * 100) / 100
}

export function opportunityEvidenceText(
  identity: CandidateIdentity | Record<string, unknown>,
  _evidence: CandidateEvidence[],
): string {
  const row = identity as Record<string, unknown>
  // Only provider-returned content belongs in semantic qualification. Several
  // adapters retain the submitted search query in the evidence claim for
  // provenance. Including that claim here lets a targeting term prove its own
  // relevance (and lets negative search operators trigger exclusion rules),
  // recreating the query-leakage defect that content-only intent classification
  // is designed to prevent.
  const identityValues = [
    row.name,
    row.audience_description,
  ].filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
  return identityValues.join('\n')
}

const RANK_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'us', 'who', 'with',
])

function rankTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !RANK_STOP_WORDS.has(token))
}

function overlapScore(expected: string, observed: string): number {
  const wanted = [...new Set(rankTokens(expected))]
  if (wanted.length === 0) return 0
  const actual = new Set(rankTokens(observed))
  return wanted.filter((token) => actual.has(token)).length / wanted.length
}

function requestedIntent(play: {
  audience?: string | null
  signal?: string | null
  providerQuery?: Record<string, unknown> | null
}): DemonstratedOpportunityIntent {
  const explicit = play.providerQuery?.opportunity_intent_lane
  if (
    explicit === 'buyer_intent'
    || explicit === 'seller_intent'
    || explicit === 'local_audience'
    || explicit === 'mixed_intent'
  ) {
    return explicit
  }
  return classifyOpportunityIntent(`${play.audience ?? ''} ${play.signal ?? ''}`).kind
}

/**
 * Evidence-aware deterministic rerank score. This runs only over the provider's
 * already bounded result set and has no model/provider side effect.
 */
export function opportunityRelevanceScore(
  candidate: Pick<Candidate, 'entity_kind' | 'identity' | 'evidence'>,
  play: {
    audience?: string | null
    signal?: string | null
    geography?: string | null
    providerQuery?: Record<string, unknown> | null
    recencyWindow?: string | null
  },
  referenceTime: Date,
): number {
  if (candidate.entity_kind !== 'opportunity') return 0
  const identity = candidate.identity as CandidateIdentity
  const text = opportunityEvidenceText(identity, candidate.evidence)
  const destination = assessOpportunityDestination({
    identity,
    evidence: candidate.evidence,
    referenceTime,
    maxAgeDays: 30,
  })
  const observedIntent = classifyOpportunityIntent(text).kind
  const intent = requestedIntent(play)
  const audience = `${play.audience ?? ''} ${play.signal ?? ''}`.trim()
  const location = [identity.location, identity.city, identity.region].filter(Boolean).join(' ')
  const geography = play.geography ?? ''
  const engagement = Math.max(0, Number(identity.engagement_count ?? identity.member_count ?? 0))
  const noise = realtorOpportunityNoiseReasons(text, destination.canonicalUrl)

  let score = 0
  score += destination.status === 'pass' ? 18 : destination.status === 'unknown' ? 6 : 0
  score += Math.min(30, overlapScore(audience, text) * 45)
  score += intent && observedIntent === intent ? 24 : observedIntent == null ? 0 : 6
  score += geography && location ? Math.min(14, overlapScore(geography, location) * 28) : 0
  score += destination.ageDays == null ? 2 : destination.ageDays <= 7 ? 9 : destination.ageDays <= 30 ? 5 : 0
  score += Math.min(5, Math.log10(engagement + 1) * 2.5)
  score -= noise.length * 35
  return Math.round(Math.max(0, Math.min(100, score)) * 100) / 100
}

export function rankOpportunityCandidates<T extends Pick<Candidate, 'entity_kind' | 'identity' | 'evidence'>>(
  candidates: T[],
  play: {
    audience?: string | null
    signal?: string | null
    geography?: string | null
    providerQuery?: Record<string, unknown> | null
    recencyWindow?: string | null
  },
  referenceTime: Date,
): T[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: opportunityRelevanceScore(candidate, play, referenceTime),
      destination: canonicalOpportunityUrl(candidate.identity.urls ?? []),
    }))
    .sort((left, right) =>
      right.score - left.score
      || (left.destination ?? '').localeCompare(right.destination ?? '')
      || left.index - right.index,
    )
    .map((row) => row.candidate)
}
