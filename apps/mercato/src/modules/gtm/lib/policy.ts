import { computeExecutionEligibility, isUsGeography } from './eligibility'

export type LeadMode = 'business' | 'consumer' | 'mixed' | 'unknown'
export type ResearchEligibility = 'provider_runnable' | 'import_only' | 'blocked'
export type OutreachMode = 'automated_email' | 'manual_only' | 'blocked'

export type GtmPolicyInput = {
  market_type?: string | null
  geography?: string | null
  audience?: string | null
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

function leadMode(value: string | null | undefined): LeadMode {
  if (value === 'b2b') return 'business'
  if (value === 'b2c') return 'consumer'
  if (value === 'mixed') return 'mixed'
  return 'unknown'
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
  const mode = leadMode(input.market_type)
  const execution = computeExecutionEligibility(input)
  const flags = mode === 'consumer' || mode === 'mixed'
    ? consumerPolicyFlags(input)
    : []

  if (mode === 'unknown') {
    return {
      lead_mode: mode,
      research_eligibility: 'blocked',
      research_eligibility_reason: 'Choose whether this audience is business or consumer before sourcing leads.',
      outreach_mode: 'blocked',
      outreach_policy_reason: 'Outreach is blocked until the audience type is known.',
      policy_flags: ['market_type_unknown'],
      ...execution,
    }
  }

  if (flags.length > 0) {
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
    signal: play.signal,
    source_hint: play.sourceHint,
    why_now: play.whyNow,
    recommended_angle: play.recommendedAngle,
    provider_query: play.providerQuery,
  }
}
