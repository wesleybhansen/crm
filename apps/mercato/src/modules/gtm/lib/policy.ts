import { computeExecutionEligibility, isUsGeography } from './eligibility'

export type LeadMode = 'business' | 'consumer' | 'mixed' | 'unknown'
export type ResearchEligibility = 'provider_runnable' | 'import_only' | 'blocked'
export type OutreachMode = 'automated_email' | 'manual_only' | 'blocked'

export type GtmPolicyInput = {
  market_type?: string | null
  geography?: string | null
  audience?: string | null
  likely_buyer?: string | null
  signal?: string | null
  source_hint?: string | null
  why_now?: string | null
  recommended_angle?: string | null
  provider_query?: Record<string, unknown> | null
}

export type GtmPolicyResult = {
  lead_mode: LeadMode
  research_eligibility: ResearchEligibility
  research_eligibility_reason: string
  outreach_mode: OutreachMode
  outreach_policy_reason: string
  policy_flags: string[]
  execution_eligibility: ReturnType<typeof computeExecutionEligibility>['execution_eligibility']
  eligibility_reason: string
}

type PolicyRule = { code: string; pattern: RegExp }

const CONSUMER_POLICY_RULES: PolicyRule[] = [
  {
    code: 'minor_or_youth',
    pattern: /(?:\b(?:minors?|underage|child(?:ren)?|kids?|teen(?:ager)?s?|youth|high[-\s]?school(?:er|ers| student| students)?)\b|\bunder\s+(?:the\s+age\s+of\s+)?18\b|\b(?:age[sd]?\s*)?(?:[0-9]|1[0-7])\s*(?:year[-\s]?olds?|years?\s+old)\b)/i,
  },
  {
    code: 'health_or_disability',
    pattern: /\b(?:health condition|diagnos(?:is|ed)|cancer|diabet(?:es|ic)|hiv|aids|disab(?:ility|led)|pregnan(?:cy|t)|fertility|infertility|mental health|depress(?:ion|ed)|anxiety|medical condition|chronic illness|illness)\b/i,
  },
  {
    code: 'protected_characteristic',
    pattern: /\b(?:race|racial|ethnic(?:ity)?|black|african[-\s]?american|hispanic|latin[oaex]|asian|native[-\s]?american|indigenous|religion|religious|christian|muslim|jewish|hindu|sexual orientation|gay|lesbian|bisexual|gender identity|transgender|non[-\s]?binary|citizenship|immigration status|undocumented|refugee|asylum seeker)\b/i,
  },
  {
    code: 'sensitive_legal_or_financial_event',
    pattern: /\b(?:bereave(?:ment|d)|probate|decedent|executor|personal representative|divorc(?:e|ed|ing)|marital dissolution|foreclos(?:ure|ed|ing)|trustee sale|evict(?:ion|ed)|repossession|bankrupt(?:cy)?|tax delinquen(?:cy|t)|tax lien|debt distress|debt collection|loan default|mortgage (?:default|delinquen(?:cy|t)|payoff|satisfaction)|deed of reconveyance)\b/i,
  },
  {
    code: 'sensitive_life_stage',
    pattern: /(?:\b(?:retiree|retirement|senior citizen|elderly|empty nester|family status|married|unmarried|single parents?|new parents?|expectant parents?|widow(?:ed|er)?)\b|\b(?:age[sd]?\s*\d{1,3}|\d{1,3}\s*(?:-|to)\s*\d{1,3}\s*(?:year[-\s]?olds?|years?\s+old)?|(?:over|under|older than|younger than)\s+\d{1,3})\b)/i,
  },
]

export type MarketType = 'b2b' | 'b2c' | 'mixed'

/*
 * The ONLY market types the policy trusts. Any other caller string (a hub
 * label such as 'consumer', a casing variant, free text) is not a market
 * type at all: it maps to null, the play is stored without one, and policy
 * treats it as unknown rather than guessing which side it meant.
 */
export function normalizeMarketType(value: unknown): MarketType | null {
  return value === 'b2b' || value === 'b2c' || value === 'mixed' ? value : null
}

function leadMode(value: string | null | undefined): LeadMode {
  const marketType = normalizeMarketType(value)
  if (marketType === 'b2b') return 'business'
  if (marketType === 'b2c') return 'consumer'
  if (marketType === 'mixed') return 'mixed'
  return 'unknown'
}

/*
 * A "business" audience whose text describes people rather than companies
 * or professionals (homeowners, patients, renters, "people who ...") is a
 * consumer audience wearing a b2b label: it must never receive automated
 * email or business-licensed person sourcing on the strength of that label.
 */
const INDIVIDUAL_AUDIENCE_PATTERN = /\b(?:home[-\s]?owners?|home[-\s]?buyers?|home[-\s]?sellers?|first[-\s]?time buyers?|parents?|patients?|students?|renters?|tenants?|consumers?|individuals?|people who|persons? who|residents?|households?|families|retirees?|veterans?|immigrants?|job[-\s]?seekers?|newlyweds|couples|pet owners?|car owners?)\b/i

export function describesIndividualAudience(input: Pick<GtmPolicyInput, 'audience' | 'likely_buyer'>): boolean {
  const text = [input.audience ?? '', input.likely_buyer ?? ''].join(' ')
  return INDIVIDUAL_AUDIENCE_PATTERN.test(text)
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed) out.push(trimmed)
    return
  }
  if (Array.isArray(value)) {
    for (const child of value.slice(0, 100)) collectStrings(child, out)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const child of Object.values(value as Record<string, unknown>).slice(0, 100)) {
    collectStrings(child, out)
  }
}

export function consumerPolicyFlags(input: GtmPolicyInput): string[] {
  const values: string[] = []
  collectStrings([
    input.audience,
    input.signal,
    input.source_hint,
    input.why_now,
    input.recommended_angle,
    input.provider_query,
  ], values)
  const text = values.join(' ')
  return CONSUMER_POLICY_RULES
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => rule.code)
}

/**
 * Additive GTM policy split from SPEC-069. The legacy execution result keeps
 * its exact US-B2B automated-email meaning. Research and outreach are decided
 * independently so a safe consumer play can source approved public leads
 * without ever becoming executable by the campaign/send machinery.
 */
export function computeGtmPolicy(input: GtmPolicyInput): GtmPolicyResult {
  const marketType = normalizeMarketType(input.market_type)
  const mode = leadMode(input.market_type)
  // The legacy execution rule only ever recognised the strict 'b2b' string,
  // so it is fed the normalized value and stays exactly as strict.
  const execution = computeExecutionEligibility({ market_type: marketType, geography: input.geography })
  // Sensitive-criteria screening runs for EVERY mode: the market_type label
  // is caller-supplied and must never be the thing that skips the screen.
  const flags = consumerPolicyFlags(input)
  const individuals = describesIndividualAudience(input)

  if (mode === 'unknown') {
    const rawMarketType = typeof input.market_type === 'string' ? input.market_type.trim() : ''
    return {
      lead_mode: mode,
      research_eligibility: 'blocked',
      research_eligibility_reason: rawMarketType
        ? `The audience type "${rawMarketType.slice(0, 40)}" is not one of b2b, b2c, or mixed. Choose one before sourcing leads.`
        : 'Choose whether this audience is business or consumer before sourcing leads.',
      outreach_mode: 'blocked',
      outreach_policy_reason: 'Outreach is blocked until the audience type is known.',
      policy_flags: [rawMarketType ? 'market_type_invalid' : 'market_type_unknown'],
      ...execution,
    }
  }

  // A sensitive criterion combined with an audience of individuals is blocked
  // in every mode. In business mode, a sensitive term that describes the
  // PROFESSION being sold to (bankruptcy attorneys, fertility clinics) is not
  // targeting individuals by that criterion, but automated email is still
  // withheld: the screen hit means a human decides how this list is used.
  if (flags.length > 0 && (mode !== 'business' || individuals)) {
    return {
      lead_mode: mode,
      research_eligibility: 'blocked',
      research_eligibility_reason: 'This audience uses a sensitive or minor-related targeting criterion that Noli does not process.',
      outreach_mode: 'blocked',
      outreach_policy_reason: 'Outreach is blocked for sensitive or minor-related targeting.',
      policy_flags: flags,
      ...execution,
    }
  }

  const geography = (input.geography ?? '').trim()
  if (!geography || geography.toLowerCase() === 'not_applicable') {
    return {
      lead_mode: mode,
      research_eligibility: 'blocked',
      research_eligibility_reason: 'Add an explicit geography before sourcing leads.',
      outreach_mode: 'blocked',
      outreach_policy_reason: 'Outreach is blocked until the governing geography is known.',
      policy_flags: ['geography_unknown'],
      ...execution,
    }
  }

  if (!isUsGeography(geography)) {
    return {
      lead_mode: mode,
      research_eligibility: 'import_only',
      research_eligibility_reason: 'Provider sourcing is not enabled for this geography. Customer-owned records may be reviewed manually.',
      outreach_mode: 'manual_only',
      outreach_policy_reason: 'Noli does not automate outreach for this geography.',
      policy_flags: ['non_us'],
      ...execution,
    }
  }

  if (mode === 'business') {
    if (individuals) {
      return {
        lead_mode: mode,
        research_eligibility: 'import_only',
        research_eligibility_reason: 'This audience is labelled business but describes individual people. Re-label it as a consumer audience, or import customer-owned business records for manual review.',
        outreach_mode: 'manual_only',
        outreach_policy_reason: 'Automated email is refused for a business-labelled audience that describes individuals.',
        policy_flags: ['b2b_individual_audience'],
        ...execution,
      }
    }
    if (flags.length > 0) {
      return {
        lead_mode: mode,
        research_eligibility: 'provider_runnable',
        research_eligibility_reason: 'This United States business audience may use an approved business source.',
        outreach_mode: 'manual_only',
        outreach_policy_reason: 'Automated email is withheld because the audience text contains a sensitive targeting term; outreach to this list is manual.',
        policy_flags: flags,
        ...execution,
      }
    }
    return {
      lead_mode: mode,
      research_eligibility: 'provider_runnable',
      research_eligibility_reason: 'This United States business audience may use an approved business source.',
      outreach_mode: 'automated_email',
      outreach_policy_reason: 'Governed B2B email is available after the existing approval, sender, suppression, and execution checks.',
      policy_flags: [],
      ...execution,
    }
  }

  if (mode === 'consumer') {
    return {
      lead_mode: mode,
      research_eligibility: 'provider_runnable',
      research_eligibility_reason: 'This non-sensitive United States consumer audience may use an explicitly consumer-approved source.',
      outreach_mode: 'manual_only',
      outreach_policy_reason: 'Noli can prepare a grounded message and public profile link, but the customer must perform the outreach manually.',
      policy_flags: [],
      ...execution,
    }
  }

  return {
    lead_mode: mode,
    research_eligibility: 'import_only',
    research_eligibility_reason: 'Split this mixed audience into separate business and consumer plays before provider sourcing.',
    outreach_mode: 'manual_only',
    outreach_policy_reason: 'Mixed audiences are manual only until their business and consumer records are separated.',
    policy_flags: ['mixed_audience'],
    ...execution,
  }
}

export function policyInputFromPlay(play: {
  marketType?: string | null
  geography?: string | null
  audience?: string | null
  likelyBuyer?: string | null
  signal?: string | null
  sourceHint?: string | null
  whyNow?: string | null
  recommendedAngle?: string | null
  providerQuery?: Record<string, unknown> | null
}): GtmPolicyInput {
  return {
    market_type: play.marketType,
    geography: play.geography,
    audience: play.audience,
    likely_buyer: play.likelyBuyer ?? null,
    signal: play.signal,
    source_hint: play.sourceHint,
    why_now: play.whyNow,
    recommended_angle: play.recommendedAngle,
    provider_query: play.providerQuery,
  }
}
