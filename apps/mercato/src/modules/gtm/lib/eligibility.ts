/*
 * Server-side US-B2B execution-eligibility rule (SPEC-066 section 7).
 *
 * Pure helper mirroring the hub's canonical implementation
 * (noli-platform apps/hub/src/lib/audience-plays/engine.ts): a play is
 * `executable` ONLY when market_type === 'b2b' AND the geography names the
 * US or a US subdivision; everything else is `strategy_only` with an
 * explicit reason. Caller-supplied eligibility is never trusted; this is
 * recomputed at every money- or contact-adjacent boundary.
 */

export type ExecutionEligibility = 'executable' | 'strategy_only' | 'unsupported'

export type EligibilityInput = {
  market_type?: string | null
  geography?: string | null
}

export type EligibilityResult = {
  execution_eligibility: ExecutionEligibility
  eligibility_reason: string
}

const US_STATE_NAMES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine',
  'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
  'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
  'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington', 'west virginia', 'wisconsin', 'wyoming',
  'district of columbia',
]

const US_STATE_ABBREVS = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS',
  'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK',
  'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
  'WI', 'WY', 'DC',
])

const US_PATTERN = /\b(us|usa|u\.s\.a?\.?|united states|american?)\b/i

// True only when the geography string names the US or a US subdivision.
// 'not_applicable', empty, and non-US geographies are all false.
export function isUsGeography(geography: string): boolean {
  const raw = (geography ?? '').trim()
  if (!raw || raw.toLowerCase() === 'not_applicable') return false
  if (US_PATTERN.test(raw)) return true
  const lowered = ` ${raw.toLowerCase().replace(/[^a-z]+/g, ' ')} `
  for (const name of US_STATE_NAMES) {
    if (lowered.includes(` ${name} `)) return true
  }
  // Two-letter state abbreviations: uppercase tokens only, so ordinary
  // lowercase English words like "in" or "or" never count as states.
  const upperTokens = raw.split(/[^A-Za-z]+/).filter((token) => /^[A-Z]{2}$/.test(token))
  return upperTokens.some((token) => US_STATE_ABBREVS.has(token))
}

export function computeExecutionEligibility(play: EligibilityInput): EligibilityResult {
  if (play.market_type !== 'b2b') {
    return {
      execution_eligibility: 'strategy_only',
      eligibility_reason:
        play.market_type === 'b2c'
          ? 'Consumer audiences are strategy guidance only. Automated execution supports US B2B audiences.'
          : 'Mixed audiences are strategy guidance only. Automated execution supports US B2B audiences.',
    }
  }
  const geo = (play.geography ?? '').trim()
  if (!geo || geo.toLowerCase() === 'not_applicable') {
    return {
      execution_eligibility: 'strategy_only',
      eligibility_reason:
        'No US geography is specified for this audience. Automated execution supports US B2B audiences.',
    }
  }
  if (!isUsGeography(geo)) {
    return {
      execution_eligibility: 'strategy_only',
      eligibility_reason:
        'This audience is outside the US. Automated execution supports US B2B audiences.',
    }
  }
  return {
    execution_eligibility: 'executable',
    eligibility_reason: 'US B2B audience with a findable source. Eligible for automated execution.',
  }
}
