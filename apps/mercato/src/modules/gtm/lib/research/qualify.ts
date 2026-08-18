import type { Candidate, CandidateEvidence } from '../adapters/types'
import { isUsGeography } from '../eligibility'

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
  version: 'qualification-profile-v1'
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
  version: 'fit-v2' | 'fit-v3'
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

export const FIT_REASONS = {
  accepted: 'meets_fit_rules',
  review: 'insufficient_decisive_fit_data',
  entityKindMismatch: 'entity_kind_mismatch',
  missingName: 'missing_identity_name',
  outsideGeography: 'outside_play_geography',
  noEvidence: 'no_supporting_evidence',
  weakEvidence: 'weak_evidence_confidence',
  noDomain: 'no_domain',
  belowThreshold: 'below_fit_threshold',
  criterionMismatch: 'required_criterion_mismatch',
  criterionUnknown: 'required_criterion_unknown',
  excluded: 'matches_exclusion_criterion',
  staleSignal: 'outside_signal_recency_window',
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
    version: 'fit-v3',
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
    ? value.trim().toLowerCase().replace(/[^a-z0-9+]+/g, ' ').replace(/\s+/g, ' ').trim()
    : ''
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim()).filter(Boolean))]
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
  ['senior', 'sr'],
  ['junior', 'jr'],
  ['manager', 'mgr'],
  ['director', 'dir'],
  // US state code / name pairs. Providers return the code (LeadMagic sends
  // contact_state_code) while a play names the state, so without these every
  // location criterion hard-fails on "Austin, TX" versus "Austin, Texas".
  ['alabama', 'al'], ['alaska', 'ak'], ['arizona', 'az'], ['arkansas', 'ar'],
  ['california', 'ca'], ['colorado', 'co'], ['connecticut', 'ct'], ['delaware', 'de'],
  ['florida', 'fl'], ['georgia', 'ga'], ['hawaii', 'hi'], ['idaho', 'id'],
  ['illinois', 'il'], ['indiana', 'in'], ['iowa', 'ia'], ['kansas', 'ks'],
  ['kentucky', 'ky'], ['louisiana', 'la'], ['maine', 'me'], ['maryland', 'md'],
  ['massachusetts', 'ma'], ['michigan', 'mi'], ['minnesota', 'mn'], ['mississippi', 'ms'],
  ['missouri', 'mo'], ['montana', 'mt'], ['nebraska', 'ne'], ['nevada', 'nv'],
  ['new hampshire', 'nh'], ['new jersey', 'nj'], ['new mexico', 'nm'], ['new york', 'ny'],
  ['north carolina', 'nc'], ['north dakota', 'nd'], ['ohio', 'oh'], ['oklahoma', 'ok'],
  ['oregon', 'or'], ['pennsylvania', 'pa'], ['rhode island', 'ri'], ['south carolina', 'sc'],
  ['south dakota', 'sd'], ['tennessee', 'tn'], ['texas', 'tx'], ['utah', 'ut'],
  ['vermont', 'vt'], ['virginia', 'va'], ['washington', 'wa'], ['west virginia', 'wv'],
  ['wisconsin', 'wi'], ['wyoming', 'wy'], ['district of columbia', 'dc'],
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
  const clean = value.toLowerCase().replace(/,/g, '').replace(/\b(to|employees?|people|staff)\b/g, '-')
  const numbers = clean.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? []
  if (numbers.length >= 2) return { min: Math.min(numbers[0], numbers[1]), max: Math.max(numbers[0], numbers[1]) }
  if (numbers.length === 1 && /\+|over|more than/.test(clean)) return { min: numbers[0], max: Number.POSITIVE_INFINITY }
  if (numbers.length === 1 && /under|less than|up to/.test(clean)) return { min: 0, max: numbers[0] }
  return null
}

function employeeRangeMatches(observed: string, expected: string): boolean {
  if (wordsMatch(observed, expected)) return true
  const desired = parseRange(expected)
  if (!desired) return false
  const count = Number(observed.replace(/,/g, ''))
  if (Number.isFinite(count)) return count >= desired.min && count <= desired.max
  const actual = parseRange(observed)
  return Boolean(actual && actual.min <= desired.max && actual.max >= desired.min)
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
    id: 'account.industry', dimension: 'account', label: 'Industry', hard: true,
    fields: ['industry', 'company_industry', 'company_industry_linkedin'],
  })
  addCriterion(definitions, query, 'company_keywords', {
    id: 'account.keywords', dimension: 'account', label: 'Company keywords', hard: true,
    fields: ['description', 'company_description', 'company_headline', 'specialties', 'industry'],
    useEvidence: true,
  })
  addCriterion(definitions, query, 'employee_ranges', {
    id: 'account.employee_range', dimension: 'account', label: 'Company size', hard: true,
    fields: ['employee_range', 'employee_count', 'employees', 'company_size'], employeeRange: true,
  })
  addCriterion(definitions, query, 'technologies', {
    id: 'account.technologies', dimension: 'account', label: 'Technology', hard: true,
    fields: ['technologies', 'tech_stack'], useEvidence: true,
  })
  if (candidateKind === 'person') {
    addCriterion(definitions, query, 'titles', {
      id: 'persona.title', dimension: 'persona', label: 'Title', hard: true,
      fields: ['title', 'job_title'],
    })
    addCriterion(definitions, query, 'roles', {
      id: 'persona.role', dimension: 'persona', label: 'Role', hard: true,
      fields: ['role', 'title', 'job_title', 'persona'],
    })
    addCriterion(definitions, query, 'seniorities', {
      id: 'persona.seniority', dimension: 'persona', label: 'Seniority', hard: true,
      fields: ['seniority', 'job_level'],
    })
    addCriterion(definitions, query, 'departments', {
      id: 'persona.department', dimension: 'persona', label: 'Department', hard: true,
      fields: ['department', 'job_function'],
    })
  }
  addCriterion(definitions, query, 'locations', {
    id: 'geography.location', dimension: 'geography', label: 'Location', hard: true,
    fields: ['location', 'city', 'geography', 'region'],
  })

  const exclusionSpecs = [
    ['exclude_industries', 'exclusion.industry', 'Excluded industry', ['industry', 'company_industry']],
    ['exclude_company_keywords', 'exclusion.keyword', 'Excluded company keyword', ['name', 'company', 'company_name', 'description', 'industry', 'domain']],
    ['exclude_technologies', 'exclusion.technology', 'Excluded technology', ['technologies', 'tech_stack']],
    ['exclude_titles', 'exclusion.title', 'Excluded title', ['title', 'job_title']],
    ['exclude_roles', 'exclusion.role', 'Excluded role', ['role', 'title', 'job_title', 'persona']],
  ] as const
  for (const [key, id, label, fields] of exclusionSpecs) {
    if (candidateKind === 'company' && (key === 'exclude_titles' || key === 'exclude_roles')) continue
    addCriterion(definitions, query, key, {
      id, dimension: 'exclusion', label, hard: true, fields: [...fields], exclusion: true,
    })
  }
  const maxAge = recencyDays(play.recencyWindow)
  if (maxAge != null) {
    definitions.push({
      id: 'signal.recency', dimension: 'signal', label: 'Signal recency', hard: true,
      expected: [`within ${maxAge} days`], fields: [], recencyDays: maxAge,
    })
  }
  return definitions
}

export function compileQualificationProfile(
  play: FitPlayInput,
  candidateKind: Candidate['entity_kind'],
): QualificationProfile {
  return {
    version: 'qualification-profile-v1',
    criteria: compileDefinitions(play, candidateKind).map(({ id, dimension, label, expected, hard }) => ({
      id, dimension, label, expected, hard,
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
    const newest = observed.map((value) => new Date(value).getTime()).filter(Number.isFinite).sort((a, b) => b - a)[0]
    // Without a trustworthy reference time, age is unknowable. It must NOT
    // default to the evidence's own timestamp, which makes every signal look
    // zero days old and silently passes a hard recency gate.
    const ageDays = newest == null || referenceTime == null
      ? null
      : Math.max(0, (referenceTime.getTime() - newest) / 86_400_000)
    return {
      id: definition.id, dimension: definition.dimension, label: definition.label,
      expected: definition.expected, observed: ageDays == null ? [] : [`${Math.floor(ageDays)} days old`],
      status: ageDays == null ? 'unknown' : ageDays <= definition.recencyDays ? 'pass' : 'fail', hard: true,
    }
  }
  const identityValues = observedValues(identity, definition.fields)
  const evidenceValues = definition.useEvidence
    ? evidence.flatMap((row) => [row.claim, ...Object.values(row.detail ?? {}).filter((value): value is string => typeof value === 'string')])
    : []
  const observed = [...new Set([...identityValues, ...evidenceValues])]
  if (observed.length === 0) {
    return {
      id: definition.id, dimension: definition.dimension, label: definition.label,
      expected: definition.expected, observed: [], status: 'unknown', hard: definition.hard,
    }
  }
  const matches = definition.expected.some((expected) =>
    observed.some((actual) => definition.employeeRange
      ? employeeRangeMatches(actual, expected)
      : wordsMatch(actual, expected)),
  )
  // Generic provider evidence proves the row was sourced, but a claim that
  // omits the criterion cannot prove a contradiction. Only exposed identity
  // fields can turn a non-match into a hard fail.
  if (!matches && identityValues.length === 0 && evidenceValues.length > 0) {
    return {
      id: definition.id, dimension: definition.dimension, label: definition.label,
      expected: definition.expected, observed: evidenceValues,
      status: 'unknown', hard: definition.hard,
    }
  }
  return {
    id: definition.id, dimension: definition.dimension, label: definition.label,
    expected: definition.expected, observed,
    status: definition.exclusion ? (matches ? 'fail' : 'pass') : (matches ? 'pass' : 'fail'),
    hard: definition.hard,
  }
}

function criterionScore(criteria: CriterionResult[], dimension: CriterionResult['dimension'], fallback: number, max: number): number {
  const relevant = criteria.filter((row) => row.dimension === dimension)
  if (relevant.length === 0) return fallback
  const earned = relevant.reduce((sum, row) => sum + (row.status === 'pass' ? 1 : row.status === 'unknown' ? 0.35 : 0), 0)
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
    const mismatch = entityUnit &&
      ((unitWantsCompany(entityUnit) && candidate.entity_kind !== 'company') ||
        (unitWantsPerson(entityUnit) && candidate.entity_kind !== 'person'))
    if (mismatch) {
      return result(0, 'rejected', FIT_REASONS.entityKindMismatch, EMPTY_BREAKDOWN, [], ['entity_kind_mismatch'])
    }

    const location = stringValue(identity, ['location', 'city', 'geography', 'region'])
    const playGeography = (play.geography ?? '').trim()
    if (playGeography && location && isUsGeography(playGeography) && !isUsGeography(location)) {
      return result(0, 'rejected', FIT_REASONS.outsideGeography, EMPTY_BREAKDOWN, [], ['outside_play_geography'])
    }
    if (evidence.length === 0) {
      return result(0, 'rejected', FIT_REASONS.noEvidence, EMPTY_BREAKDOWN, [], ['no_supporting_evidence'])
    }

    const definitions = compileDefinitions(play, candidate.entity_kind)
    const profile = compileQualificationProfile(play, candidate.entity_kind)
    const parsedReference = play.referenceTime instanceof Date
      ? play.referenceTime
      : play.referenceTime != null
        ? new Date(play.referenceTime)
        : null
    const referenceTime =
      parsedReference && Number.isFinite(parsedReference.getTime()) ? parsedReference : null
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
      persona: criterionScore(criteria, 'persona', candidate.entity_kind === 'person' ? (title ? 20 : 8) : (industry ? 20 : 10), 20),
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
      return result(fitScore, 'review', FIT_REASONS.criterionUnknown, breakdown, unknowns, contradictions, profile, criteria)
    }
    if (fitScore >= FIT_ACCEPT_THRESHOLD && avgConfidence >= 0.5) {
      return result(fitScore, 'accepted', FIT_REASONS.accepted, breakdown, unknowns, contradictions, profile, criteria)
    }
    if (fitScore >= FIT_REVIEW_THRESHOLD) {
      return result(fitScore, 'review', avgConfidence < 0.5 ? FIT_REASONS.weakEvidence : FIT_REASONS.review, breakdown, unknowns, contradictions, profile, criteria)
    }
    return result(fitScore, 'rejected', FIT_REASONS.belowThreshold, breakdown, unknowns, contradictions, profile, criteria)
  },
}

export type FitDistribution = {
  accepted: number
  review: number
  rejected: number
  byReason: Record<string, number>
}

export function summarizeFitResults(results: FitResult[]): FitDistribution {
  const summary: FitDistribution = { accepted: 0, review: 0, rejected: 0, byReason: {} }
  for (const row of results) {
    summary[row.verdict] += 1
    summary.byReason[row.reason] = (summary.byReason[row.reason] ?? 0) + 1
  }
  return summary
}
