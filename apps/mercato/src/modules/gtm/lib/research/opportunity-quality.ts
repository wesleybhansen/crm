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
  [
    'buy a home',
    /\b(?:buy(?:ing)?|purchase|purchasing) (?:a|my|our|the)? ?(?:first|current|next|new|smaller|larger)? ?(?:home|house|condo|townhome|property)\b|\b(?:home|house|condo|townhome|property) (?:purchase|buyer)\b/i,
  ],
  ['home buyer', /\b(?:home|property) ?buyers?\b|\bbuyers? (?:and|or) sellers?\b/i],
  [
    'buy before or after selling',
    /\bbuy(?:ing)? (?:or|before|after) sell(?:ing)? (?:a|my|our|the)? ?(?:home|house|property)\b|\bbuying (?:the )?(?:next|another) one\b/i,
  ],
  ['first-time buyer', /\bfirst[- ]time (?:home ?buyer|buyer|home)\b/i],
  ['home search', /\b(?:house hunt|house hunting|home search|searching for (?:a )?home)\b/i],
  ['financing education', /\b(?:mortgage|pre[- ]?approval|down payment|closing costs?)\b/i],
  ['relocation', /\b(?:relocat(?:e|ing|ion)|moving to|move to)\b/i],
  ['looking for a home', /\blooking for (?:a )?(?:home|house|condo|townhome)\b/i],
]

const SELLER_SIGNALS: Array<[string, RegExp]> = [
  [
    'sell a home',
    /\b(?:sell|selling) (?:a|my|our|the)? ?(?:[a-z]+ ){0,2}(?:home|house|condo|townhome|property)\b|\b(?:home|house|property) (?:sale|seller)\b|\bhome ?sellers?\b/i,
  ],
  ['buyer and seller audience', /\bbuyers? (?:and|or) sellers?\b/i],
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
    /\b(?:mls\s*#?|listed at|listed for \$[\d,.]+|for sale at|luxury home for sale|new listing|just listed|price reduced|reduced to \$[\d,.]+|open house today|dream home alert|schedule (?:a )?(?:private )?tour|book (?:a )?showing|view (?:all )?(?:homes|properties|listings) for sale)\b|\b\d+\s*(?:bed|beds|br)\b.*\b\d+(?:\.\d+)?\s*(?:bath|baths|ba)\b/i,
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
  [
    'employment_listing',
    /\b(?:job opening|currently hiring|staffing agency|apply for (?:the|this) (?:job|position)|full[- ]time position|part[- ]time position)\b/i,
  ],
  [
    'rental_or_venue_inventory',
    /\b(?:houses? for rent|entire home in|vacation rental|wedding venue|spa resort|guest house near|book your stay)\b/i,
  ],
  [
    'non_property_home_phrase',
    /\b(?:home[- ]made trailer|home trailer|home contents?|household contents?|sell (?:my|our|the) (?:furniture|collectibles?|trailer))\b/i,
  ],
  [
    'agent_self_promotion',
    /\b(?:i(?:'m| am) (?:a )?(?:realtor|real estate agent|real estate broker|mortgage broker)|contact (?:me|us)|call (?:me|us)|dm (?:me|us)|message (?:me|us)|send (?:me|us) a message|reach out(?: to (?:me|us))?|book (?:a )?(?:call|consultation)|schedule (?:a )?(?:call|consultation)|your local realtor|i help (?:home ?buyers?|home ?sellers?|people buy|people sell)|i work with (?:buyers?|sellers?|investors?|homeowners?)|i hear this question from (?:buyers?|sellers?|homeowners?)|(?:i|we|our team) can help|let (?:me|us) help|follow me)\b|#\w*realtor\b/i,
  ],
  [
    'generic_advice_content',
    /\b(?:\d+|five|six|seven|eight|nine|ten) (?:tips?|things?|steps?|mistakes?|questions?) (?:for|every) (?:home ?buyers?|home ?sellers?)\b|\b(?:buyer|seller) tips?\b|\b(?:thinking about selling your home|how much is your home worth|if i were buying (?:a|my) first home|home ?buyer(?:'s)? guide|buyers? aren(?:'|’)t just looking|questions worth answering before (?:you )?(?:buy|sell))\b/i,
  ],
  [
    'marketing_case_study',
    /\b(?:case stud(?:y|ies)|cost per (?:lead|acquisition)|conversion rate|ad spend|google ads|ppc(?: marketing)?|campaign (?:period|performance|optimization)|qualified (?:buyer|seller) leads?|generate more (?:buyer|seller) leads?|high[- ]intent (?:buyer|seller) leads?|real estate (?:seo|marketing|advertising) (?:agency|specialist|campaign))\b/i,
  ],
  [
    'completed_listing_promotion',
    /\b(?:successfully\s+(?:listed\s*(?:&|and)\s*)?sold|(?:just|recently)\s+sold\s*(?::|!|\bthis\s+(?:beautiful\s+)?(?:home|property|listing)\b)|sold\s+(?:this|another)\s+(?:beautiful\s+)?(?:home|property|listing)|another\s+(?:beautiful\s+)?home\s+(?:successfully\s+)?(?:listed\s*(?:&|and)\s*)?sold)\b/i,
  ],
  [
    'client_success_promotion',
    /\b(?:clear to close|milestone worth celebrating|incredible transactions?|amazing clients?|closing table|client success|seller(?:'|’)s home|buyer(?:'|’)s agent|listing agent|sold for \$?[\d,.]+ (?:over|above) asking)\b/i,
  ],
  [
    'professional_networking',
    /\b(?:let(?:'|’)s connect (?:tampa )?professionals?|real estate professionals? (?:network|meetup)|realtor networking|broker networking)\b/i,
  ],
  [
    'market_lifestyle_promotion',
    /\b(?:wallethub|ranked?|ranking|study|report)\b.{0,240}\b(?:cities?|real estate|housing|relocat(?:e|ing|ion)|rental listings?)\b|\b(?:but there(?:'|’)s a bigger real estate story|when people relocate, they aren(?:'|’)t simply choosing)\b/i,
  ],
  [
    'non_owner_or_solicitation_mismatch',
    /\b(?:i (?:lease|rent) (?:and|so) (?:do not|don(?:'|’)t) own|i(?:'m| am) not (?:the )?homeowner|not (?:the )?(?:owner|homeowner)|tips? to deter solicitors|stop (?:door[- ]to[- ]door )?salespeople)\b/i,
  ],
  [
    'sensitive_personal_crisis',
    /\b(?:passed away|passed last month|bereav(?:ed|ement)|grieving|late (?:sister|brother|mother|father|parent|spouse|partner)|below the poverty line|financial hardship|medical crisis)\b/i,
  ],
]

const SENSITIVE_CONSUMER_OPPORTUNITY: Array<[string, RegExp]> = [
  [
    'sensitive_health_or_disability',
    /\b(?:disab(?:led|ility)|medical (?:condition|crisis|debt)|health condition|mental health|pregnan(?:t|cy)|substance (?:use|abuse)|addiction|opioid|overdose|sober living|recovery (?:home|house|housing))\b/i,
  ],
  [
    'sensitive_housing_instability',
    /\b(?:homeless(?:ness)?|unhoused|housing (?:insecurity|instability)|no place to stay|sleeping (?:in|on) (?:my|a) (?:car|couch)|couch surf(?:ing)?|about to be evicted|being evicted|cannot pay (?:my )?rent|can(?:'|’)t pay (?:my )?rent|predatory landlord|domestic violence|abuse survivor)\b/i,
  ],
  [
    'sensitive_minor_or_protected_trait',
    /\b(?:minor|underage|child(?:ren)?(?:'s)? housing|sex offender|sexual orientation|gender identity|immigration status|citizenship status|racial identity|ethnic identity|religious affiliation)\b/i,
  ],
  [
    'sensitive_bereavement_or_financial_distress',
    /\b(?:passed away|bereav(?:ed|ement)|grieving|late (?:sister|brother|mother|father|parent|spouse|partner)|below the poverty line|bankrupt(?:cy)?|foreclos(?:e|ed|ure)|tax delinquen(?:t|cy)|financial hardship)\b/i,
  ],
]

const REALTOR_HOUSING_CONTEXT =
  /\b(?:home|house|housing|property|condo|townhome|homeowner|home ?buyer|home ?seller|first[- ]time buyer|mortgage|down payment|closing costs?|real estate|neighbou?rhood association|community registry|homebuyer education)\b/i
const CONSUMER_QUESTION =
  /\b(?:(?:does|can|could|would|has|is) anyone|(?:where|what|which|how|should|can|could|would|do|does|has|have|is|are) (?:i|we)|i(?:'m| am) ask(?:ing)?|we(?:'re| are) ask(?:ing)?|need (?:some )?help|looking for (?:advice|help|recommendations?)|recommendations? (?:for|on|about))\b/i
const FIRST_PERSON_HOUSING_NEED =
  /\b(?:i|we)(?:'m|'re| am| are)?\s+(?:actively\s+)?(?:thinking (?:about|of)|considering|planning(?: to)?|preparing(?: to)?|trying(?: to)?|looking(?: to| for)|need(?:ing)?(?: to)?|want(?:ing)?(?: to)?|moving|relocating|wondering|unsure|confused|stressed)\b/i
const DEMONSTRATED_HOUSING_STATUS =
  /\b(?:first[- ]time (?:home )?buyer|homeowner|home buyer|home seller)\s+(?:moving|looking|planning|preparing|trying|considering|thinking|needing|wanting)\b/i
const FIRST_PERSON_HOUSING_IDENTITY =
  /\b(?:i|we)(?:'m|'re| am| are)\s+(?:a\s+)?(?:first[- ]time (?:home )?buyer|homeowner|home buyer|home seller)\b/i
const PARTICIPATION_SURFACE =
  /\b(?:community|forum|group|thread|discussion|question|event|workshop|seminar|webinar|class|meetup|panel|association|club|neighbou?rhood|homeowners?)\b/i
const EDUCATIONAL_EVENT = /\b(?:event|workshop|seminar|webinar|class|meetup|panel|clinic|q\s*&\s*a)\b/i
const VENUE_CONSUMER_DEMAND =
  /\b(?:people|homeowners?|home ?buyers?|home ?sellers?|buyers?|sellers?)\s+(?:ask(?:ing)?|seek(?:ing)?|look(?:ing)?|discuss(?:ing)?|consider(?:ing)?|plan(?:ning)?|prepar(?:ing)?|need(?:ing)?)\b|\b(?:buyer|seller|homeowner|homebuying|home[- ]selling|first[- ]home) questions?\b/i
const PUBLIC_PARTICIPATION_EVIDENCE =
  /\b(?:join(?:ing)?|membership|members?|meeting|calendar|upcoming events?|get involved|volunteer|register|attend|discussion|questions?|forum|community registry|community groups?|community organizations?|resident organizations?|public workshop|public seminar|neighbou?rhood college)\b/i
const INACTIVE_DESTINATION =
  /\b(?:no upcoming events?|event (?:has )?ended|past event|registration (?:is )?closed|event (?:was )?cancelled|event (?:was )?canceled|not currently scheduled|workshop unavailable)\b/i
const MONTHS =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'

const US_STATE_NAMES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
  'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky',
  'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico',
  'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania',
  'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont',
  'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming',
] as const

const US_STATE_ABBREVIATIONS: Record<string, (typeof US_STATE_NAMES)[number] | 'district of columbia'> = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado',
  ct: 'connecticut', de: 'delaware', dc: 'district of columbia', fl: 'florida', ga: 'georgia',
  hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas',
  ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts',
  mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri', mt: 'montana',
  ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico',
  ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma',
  or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina',
  sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont',
  va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
}

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
  return [
    ...REALTOR_NOISE.filter(([, pattern]) => pattern.test(material)).map(([reason]) => reason),
    ...sensitiveConsumerOpportunityReasons(material),
  ].filter((reason, index, reasons) => reasons.indexOf(reason) === index)
}

/**
 * Returns only evidence-grounded safety reasons found in provider-returned
 * content. Search targeting is deliberately not accepted as proof here.
 */
export function sensitiveConsumerOpportunityReasons(content: string): string[] {
  return SENSITIVE_CONSUMER_OPPORTUNITY
    .filter(([, pattern]) => pattern.test(content))
    .map(([reason]) => reason)
}

function normalizedPhrase(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stateNamesIn(value: string, primaryLocation?: string | null): Set<string> {
  const normalized = ` ${normalizedPhrase(value)} `
  const states = new Set<string>(
    US_STATE_NAMES.filter((state) => normalized.includes(` ${state} `)),
  )
  if (normalized.includes(' district of columbia ')) states.add('district of columbia')

  const abbreviationPatterns = [/,\s*([a-z]{2})(?=\b)/gi]
  const primary = primaryLocation?.trim()
  if (primary) {
    abbreviationPatterns.push(
      new RegExp(`\\b${escapeRegExp(primary)}(?:\\s*,\\s*|\\s+)([a-z]{2})(?=\\b)`, 'gi'),
    )
  }
  for (const pattern of abbreviationPatterns) {
    for (const match of value.matchAll(pattern)) {
      const state = US_STATE_ABBREVIATIONS[(match[1] ?? '').toLowerCase()]
      if (state) states.add(state)
    }
  }
  return states
}

/**
 * Returns the requested locality only when the returned provider material
 * independently contains its most-specific place name. The requested search
 * location itself is targeting provenance and cannot prove geography.
 */
export function demonstratedOpportunityLocation(
  returnedMaterial: string,
  requestedLocation: string | null | undefined,
): string | null {
  const requested = requestedLocation?.trim().replace(/\s+/g, ' ')
  if (!requested) return null
  const primary = requested.split(',')[0]?.trim()
  if (!primary) return null
  const material = ` ${normalizedPhrase(returnedMaterial)} `
  const target = normalizedPhrase(primary)
  if (!target || !material.includes(` ${target} `)) return null
  if (opportunityHasContradictoryUsState(returnedMaterial, requested)) return null
  return requested
}

export function opportunityHasContradictoryUsState(
  returnedMaterial: string,
  expectedGeography: string,
): boolean {
  const primary = expectedGeography.split(',')[0]?.trim() ?? null
  const expectedStates = stateNamesIn(expectedGeography, primary)
  if (expectedStates.size === 0) return false
  const observedStates = stateNamesIn(returnedMaterial, primary)
  return observedStates.size > 0 && [...observedStates].every((state) => !expectedStates.has(state))
}

export type RealtorOpportunitySuitability = {
  relevant: boolean
  demonstratedIntent: DemonstratedOpportunityIntent
  reasons: string[]
}

/**
 * A realtor opportunity must demonstrate a housing context and either a real
 * consumer need/question or a participation surface. Generic agent marketing
 * and educational listicles are not demand, even if they contain buyer/seller
 * words and look complete.
 */
export function assessRealtorOpportunitySuitability(
  content: string,
  expectedIntent: DemonstratedOpportunityIntent,
  sourceUrl: string | null = null,
  opportunityKind: string | null = null,
): RealtorOpportunitySuitability {
  const intent = classifyOpportunityIntent(content).kind
  const reasons = realtorOpportunityNoiseReasons(content, sourceUrl)
  const housing = REALTOR_HOUSING_CONTEXT.test(content)
  const consumerNeed =
    CONSUMER_QUESTION.test(content)
    || FIRST_PERSON_HOUSING_NEED.test(content)
    || DEMONSTRATED_HOUSING_STATUS.test(content)
  const directConsumerNeed =
    FIRST_PERSON_HOUSING_NEED.test(content)
    || DEMONSTRATED_HOUSING_STATUS.test(content)
    || FIRST_PERSON_HOUSING_IDENTITY.test(content)
  const surface = PARTICIPATION_SURFACE.test(content)
  const educationalEvent = EDUCATIONAL_EVENT.test(content)
  const participationVenue = ['community', 'forum', 'group', 'thread'].includes(opportunityKind ?? '')
  const scheduledEvent = opportunityKind === 'event' && educationalEvent
  const educationalAudienceChannel =
    ['community', 'forum', 'group', 'event'].includes(opportunityKind ?? '')
    && educationalEvent
  const venueConsumerDemand = participationVenue && VENUE_CONSUMER_DEMAND.test(content)
  const laneMatches =
    expectedIntent == null
    || intent === expectedIntent
    || (intent === 'mixed_intent' && (expectedIntent === 'buyer_intent' || expectedIntent === 'seller_intent'))
    || (expectedIntent === 'mixed_intent'
      && (intent === 'buyer_intent' || intent === 'seller_intent' || intent === 'mixed_intent'))
  const localParticipation =
    (participationVenue && (PUBLIC_PARTICIPATION_EVIDENCE.test(content) || content.includes('?')))
    || scheduledEvent
    || educationalAudienceChannel
    || (opportunityKind === 'post' && surface && directConsumerNeed)
    || (opportunityKind === 'thread' && surface && consumerNeed)
  const directDemand = opportunityKind === 'post' ? directConsumerNeed : consumerNeed
  const relevant = expectedIntent === 'local_audience'
    ? housing && localParticipation && reasons.length === 0
    : housing
      && laneMatches
      && (directDemand || scheduledEvent || educationalAudienceChannel || venueConsumerDemand)
      && reasons.length === 0
  if (!housing) reasons.push('missing_housing_context')
  if (!laneMatches) reasons.push('intent_lane_mismatch')
  if (expectedIntent === 'local_audience' && !localParticipation) reasons.push('missing_consumer_participation')
  if (
    expectedIntent !== 'local_audience'
    && !directDemand
    && !scheduledEvent
    && !educationalAudienceChannel
    && !venueConsumerDemand
  ) {
    reasons.push('missing_consumer_need_or_event')
  }
  return { relevant, demonstratedIntent: intent, reasons: [...new Set(reasons)] }
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

function validDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function parsedDate(value: string): Date | null {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function relativeContentDate(content: string, referenceTime: Date | null): Date | null {
  if (!referenceTime) return null
  const match = content.match(/\b(\d{1,4})\s*(y|yr|yrs|year|years|mo|mos|month|months|w|wk|wks|week|weeks|d|day|days)\s+ago\b/i)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null
  const unit = match[2]?.toLowerCase() ?? ''
  const days = unit.startsWith('y')
    ? amount * 365
    : unit.startsWith('mo')
      ? amount * 30
      : unit.startsWith('w')
        ? amount * 7
        : amount
  return new Date(referenceTime.getTime() - days * 86_400_000)
}

function leadingContentDate(content: string): Date | null {
  const monthDate = content.match(new RegExp(`^\\s*(${MONTHS}\\s+\\d{1,2},\\s+20\\d{2})\\s*[—–-]`, 'i'))
  if (monthDate?.[1]) return parsedDate(`${monthDate[1]} UTC`)
  const numericDate = content.match(/^\s*(\d{1,2}\/\d{1,2}\/20\d{2})\s*[—–-]/)
  return numericDate?.[1] ? parsedDate(`${numericDate[1]} UTC`) : null
}

function datedEventCandidates(content: string): Date[] {
  const patterns = [
    new RegExp(`\\b(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)?,?\\s*(${MONTHS}\\s+\\d{1,2},?\\s+20\\d{2})\\b`, 'gi'),
    new RegExp(`\\b(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)?,?\\s*(\\d{1,2}\\s+${MONTHS},?\\s+20\\d{2})\\b`, 'gi'),
  ]
  const dates: Date[] = []
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const date = match[1] ? parsedDate(`${match[1]} UTC`) : null
      if (date) dates.push(date)
    }
  }
  return dates.sort((left, right) => left.getTime() - right.getTime())
}

export function assessOpportunityDestination(args: {
  identity: CandidateIdentity | Record<string, unknown>
  evidence: CandidateEvidence[]
  referenceTime: Date | null
  maxAgeDays: number | null
  content?: string | null
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
  const content = args.content?.trim() ?? ''
  if (content && INACTIVE_DESTINATION.test(content)) issues.push('destination_inactive')

  const access = typeof identity.access_type === 'string' ? identity.access_type : null
  if (access === 'approval_required') issues.push('destination_requires_approval')
  else if (access === 'unknown' || access == null) issues.push('destination_access_unknown')
  else if (access !== 'public' && access !== 'ticketed') issues.push('destination_not_public')

  const kind = typeof identity.opportunity_kind === 'string' ? identity.opportunity_kind : null
  const published = validDate(identity.source_published_at)
    ?? relativeContentDate(content, args.referenceTime)
    ?? leadingContentDate(content)
  // A post/thread's age must come from the platform's publication timestamp.
  // evidence.observed_at is retrieval time and cannot prove that content is
  // inside a play's recency window. Stable destinations such as communities
  // and forums may use the time Noli actually observed the public page.
  const freshnessObservation = published
    ?? (kind === 'post' || kind === 'thread' ? null : newestObservedAt(args.evidence))
  const ageDays =
    freshnessObservation && args.referenceTime
      ? Math.max(0, (args.referenceTime.getTime() - freshnessObservation.getTime()) / 86_400_000)
      : null
  if (args.maxAgeDays != null && ageDays != null && ageDays > args.maxAgeDays) issues.push('stale_destination')
  if (args.maxAgeDays != null && ageDays == null) issues.push('destination_freshness_unknown')

  const explicitEventStart = validDate(identity.event_start_at)
  const derivedEventDates = content ? datedEventCandidates(content) : []
  const eventStart = explicitEventStart
    ?? derivedEventDates.find((date) => !args.referenceTime || date.getTime() >= args.referenceTime.getTime())
    ?? derivedEventDates.at(-1)
  if (kind === 'event') {
    if (!eventStart || !Number.isFinite(eventStart.getTime())) issues.push('event_time_unknown')
    else if (args.referenceTime && eventStart.getTime() < args.referenceTime.getTime()) issues.push('event_expired')
  }

  const hardFailure = issues.some((issue) =>
    [
      'missing_or_invalid_public_destination',
      'destination_requires_approval',
      'destination_not_public',
      'destination_inactive',
      'stale_destination',
      'event_expired',
    ].includes(issue),
  )
  return {
    canonicalUrl,
    status: hardFailure ? 'fail' : issues.length > 0 ? 'unknown' : 'pass',
    issues,
    newestObservation: freshnessObservation?.toISOString() ?? null,
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
    content: text,
  })
  const observedIntent = classifyOpportunityIntent(text).kind
  const intent = requestedIntent(play)
  const audience = `${play.audience ?? ''} ${play.signal ?? ''}`.trim()
  const location = [identity.location, identity.city, identity.region].filter(Boolean).join(' ')
  const geography = play.geography ?? ''
  const engagement = Math.max(0, Number(identity.engagement_count ?? identity.member_count ?? 0))
  const realtorPlay = REALTOR_HOUSING_CONTEXT.test(audience)
  const suitability = assessRealtorOpportunitySuitability(
    text,
    intent,
    destination.canonicalUrl,
    typeof identity.opportunity_kind === 'string' ? identity.opportunity_kind : null,
  )
  const demonstratedLocation = geography
    ? demonstratedOpportunityLocation(`${text}\n${location}`, geography)
    : null
  const contradictoryState = geography
    ? opportunityHasContradictoryUsState(`${text}\n${location}`, geography)
    : false
  const noise = realtorOpportunityNoiseReasons(text, destination.canonicalUrl)

  let score = 0
  score += destination.status === 'pass' ? 15 : destination.status === 'unknown' ? -4 : -35
  score += realtorPlay
    ? suitability.relevant ? 35 : -35
    : Math.min(30, overlapScore(audience, text) * 45)
  score += intent && observedIntent === intent ? 18 : observedIntent == null ? 0 : 3
  score += demonstratedLocation ? 24 : geography ? -12 : 0
  if (contradictoryState) score -= 45
  score += destination.ageDays == null ? 0 : destination.ageDays <= 7 ? 9 : destination.ageDays <= 30 ? 5 : -12
  score += Math.min(5, Math.log10(engagement + 1) * 2.5)
  score -= noise.length * 45
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
