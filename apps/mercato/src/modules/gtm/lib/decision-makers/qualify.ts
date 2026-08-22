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

function tokens(value: string): string[] {
  return value.toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function containsPhrase(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((token, offset) => haystack[index + offset] === token)) return true
  }
  return false
}

export type DecisionMakerQualification = {
  verdict: 'accepted' | 'review' | 'rejected'
  score: number
  reason: string
  matched_title: string | null
  observed_title: string
  version: 'decision-maker-v1'
}

export function qualifyDecisionMaker(
  observedTitle: string,
  approvedTitles: string[],
): DecisionMakerQualification {
  const observed = tokens(observedTitle)
  const disqualifier = NON_DECISION_MAKER_TERMS.find((term) => observed.includes(term))
  if (disqualifier) {
    return {
      verdict: 'rejected',
      score: 0.1,
      reason: `Observed title contains non-decision-maker term: ${disqualifier}`,
      matched_title: null,
      observed_title: observedTitle,
      version: 'decision-maker-v1',
    }
  }
  const match = approvedTitles.find((title) => containsPhrase(observed, tokens(title))) ?? null
  if (match) {
    return {
      verdict: 'accepted',
      score: 0.95,
      reason: `Current title matches the approved decision-maker role: ${match}`,
      matched_title: match,
      observed_title: observedTitle,
      version: 'decision-maker-v1',
    }
  }
  return {
    verdict: 'review',
    score: 0.5,
    reason: 'Current-company relationship is evidenced, but the title needs human review.',
    matched_title: null,
    observed_title: observedTitle,
    version: 'decision-maker-v1',
  }
}
