/*
 * Decision-maker title qualification.
 *
 * A strong (0.95, accepted) verdict requires the approved role phrase to sit
 * at the HEAD of the observed title, or at the head of one of its
 * conjunction segments ("Co-Founder & Practice Owner" is two roles, each
 * headed by an approved phrase once the "co" prefix is discounted). A phrase
 * buried later in the title ("Marketing Manager reporting to the CEO") is
 * containment, not a role, and lands in review.
 *
 * Negation and seniority modifiers guard the match: "Former CEO",
 * "Vice President", "Deputy Director", "Interim COO", "Product Owner",
 * "Office of the CEO" all contain an approved phrase without holding the
 * approved role. A modifier is honoured only when it is NOT itself part of
 * the approved title (an approved "Vice President of Sales" keeps "vice").
 */

const NON_DECISION_MAKER_TERMS = [
  'assistant',
  'associate',
  'intern',
  'student',
  'coordinator',
  'specialist',
  'representative',
  'recruiter',
]

// The person no longer holds (or never held) the role: rejected outright.
const FORMER_ROLE_TERMS = ['former', 'ex', 'retired', 'emeritus', 'emerita', 'past', 'previous']

// The person holds an adjacent, junior, or acting version of the role, or a
// role that merely reuses the word: needs a human look before spend.
const ADJACENT_ROLE_PHRASES = [
  'vice',
  'deputy',
  'interim',
  'acting',
  'junior',
  'jr',
  'product owner',
  'business partner',
  'office of',
  'chief of staff to',
  'to the',
]

// Prefix tokens that do not change the role they precede.
const HEAD_PREFIX_TOKENS = new Set(['co', 'cofounder', 'founding', 'managing', 'senior', 'sr', 'the'])

function tokens(value: string): string[] {
  return value.toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

// Conjunction segments of a title: "CEO & Founder", "Owner / Broker",
// "President, CEO", "Partner and Director", "COO | Investor".
function segments(value: string): string[][] {
  return value.toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/\s*(?:&|\/|\||,|;|\band\b|\bplus\b|\s-\s|\u2013|\u2014)\s*/)
    .map((segment) => tokens(segment))
    .filter((segment) => segment.length > 0)
}

function containsPhrase(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((token, offset) => haystack[index + offset] === token)) return true
  }
  return false
}

function startsWithPhrase(haystack: string[], needle: string[], at: number): boolean {
  if (needle.length === 0 || at + needle.length > haystack.length) return false
  return needle.every((token, offset) => haystack[at + offset] === token)
}

// True when the phrase sits at the head of the segment, allowing only
// role-preserving prefix tokens before it ("co founder", "senior partner").
function headMatch(segment: string[], needle: string[]): boolean {
  for (let at = 0; at < segment.length; at += 1) {
    if (startsWithPhrase(segment, needle, at)) return true
    if (!HEAD_PREFIX_TOKENS.has(segment[at])) return false
  }
  return false
}

export type DecisionMakerQualification = {
  verdict: 'accepted' | 'review' | 'rejected'
  score: number
  reason: string
  matched_title: string | null
  observed_title: string
  version: 'decision-maker-v2'
}

const VERSION = 'decision-maker-v2' as const

export function qualifyDecisionMaker(
  observedTitle: string,
  approvedTitles: string[],
): DecisionMakerQualification {
  const observed = tokens(observedTitle)
  const approved = approvedTitles
    .map((title) => ({ title, phrase: tokens(title) }))
    .filter((entry) => entry.phrase.length > 0)
  // A modifier that is part of an approved title is not a modifier for it.
  const approvedText = approved.map((entry) => entry.phrase)
  const modifierInApproved = (modifier: string[]) =>
    approvedText.some((phrase) => containsPhrase(phrase, modifier))

  const disqualifier = NON_DECISION_MAKER_TERMS.find(
    (term) => observed.includes(term) && !modifierInApproved([term]),
  )
  if (disqualifier) {
    return {
      verdict: 'rejected',
      score: 0.1,
      reason: `Observed title contains non-decision-maker term: ${disqualifier}`,
      matched_title: null,
      observed_title: observedTitle,
      version: VERSION,
    }
  }
  const former = FORMER_ROLE_TERMS.find(
    (term) => observed.includes(term) && !modifierInApproved([term]),
  )
  if (former) {
    return {
      verdict: 'rejected',
      score: 0.1,
      reason: `Observed title describes a past role: ${former}`,
      matched_title: null,
      observed_title: observedTitle,
      version: VERSION,
    }
  }
  const adjacent = ADJACENT_ROLE_PHRASES.find((phrase) => {
    const needle = tokens(phrase)
    return containsPhrase(observed, needle) && !modifierInApproved(needle)
  })
  if (adjacent) {
    return {
      verdict: 'review',
      score: 0.4,
      reason: `Observed title modifies the approved role (${adjacent}); needs human review.`,
      matched_title: null,
      observed_title: observedTitle,
      version: VERSION,
    }
  }

  const observedSegments = segments(observedTitle)
  const strong = approved.find((entry) =>
    observedSegments.some((segment) => headMatch(segment, entry.phrase)),
  ) ?? null
  if (strong) {
    return {
      verdict: 'accepted',
      score: 0.95,
      reason: `Current title matches the approved decision-maker role: ${strong.title}`,
      matched_title: strong.title,
      observed_title: observedTitle,
      version: VERSION,
    }
  }
  const weak = approved.find((entry) => containsPhrase(observed, entry.phrase)) ?? null
  if (weak) {
    return {
      verdict: 'review',
      score: 0.6,
      reason: `Approved role phrase appears inside the title but does not lead it: ${weak.title}`,
      matched_title: weak.title,
      observed_title: observedTitle,
      version: VERSION,
    }
  }
  return {
    verdict: 'review',
    score: 0.5,
    reason: 'Current-company relationship is evidenced, but the title needs human review.',
    matched_title: null,
    observed_title: observedTitle,
    version: VERSION,
  }
}
