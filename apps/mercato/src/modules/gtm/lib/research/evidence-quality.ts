import type { AdapterEvidencePolicy, CandidateEvidence } from '../adapters/types'

export type EvidenceQualityStatus = 'strong' | 'usable' | 'weak' | 'invalid'

export type AssessedEvidence = {
  evidence: CandidateEvidence
  status: EvidenceQualityStatus
  score: number
  issues: string[]
}

export type EvidenceAssessment = {
  status: EvidenceQualityStatus
  score: number
  issues: string[]
  rows: AssessedEvidence[]
  validEvidence: CandidateEvidence[]
}

function httpUrl(value: string | null): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Platform publication time for one evidence row. observed_at is when Noli
 * retrieved the row, which every live adapter stamps with "now"; only the
 * source's own timestamp can prove that content is recent.
 */
export function evidencePublishedAt(row: Pick<CandidateEvidence, 'detail'>): Date | null {
  const detail = row.detail ?? {}
  if (detail.published_at_unknown === true) return null
  const raw = detail.published_at ?? detail.source_published_at
  if (typeof raw !== 'string' && !(raw instanceof Date)) return null
  const parsed = new Date(raw)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

function rowStatus(score: number, invalid: boolean): EvidenceQualityStatus {
  if (invalid) return 'invalid'
  if (score >= 85) return 'strong'
  if (score >= 65) return 'usable'
  return 'weak'
}

export function assessEvidence(
  evidence: CandidateEvidence[],
  policy: AdapterEvidencePolicy,
  now: Date = new Date(),
): EvidenceAssessment {
  const rows = evidence.map((row): AssessedEvidence => {
    const issues: string[] = []
    let score = 100
    let invalid = false
    const claim = row.claim?.trim() ?? ''
    if (!claim) {
      issues.push('missing_claim')
      score -= 50
      invalid = true
    }

    const hasSourceUrl = httpUrl(row.source_url)
    if (policy.source_url === 'required' && !hasSourceUrl) {
      issues.push(row.source_url ? 'invalid_source_url' : 'missing_source_url')
      score -= 45
      invalid = true
    } else if (policy.source_url === 'preferred' && !hasSourceUrl) {
      issues.push(row.source_url ? 'invalid_source_url' : 'missing_source_url')
      score -= 20
    }

    const observed = new Date(row.observed_at)
    const validObserved = Number.isFinite(observed.getTime())
    if (policy.observed_at === 'required' && !validObserved) {
      issues.push('missing_or_invalid_observed_at')
      score -= 35
      invalid = true
    } else if (policy.observed_at === 'preferred' && !validObserved) {
      issues.push('missing_or_invalid_observed_at')
      score -= 15
    }
    if (validObserved) {
      if (observed.getTime() > now.getTime() + 5 * 60 * 1000) {
        issues.push('observed_at_in_future')
        score -= 30
        invalid = true
      }
      if (policy.max_age_days != null) {
        // Age the content by its platform publication time when the adapter
        // reported one. Retrieval time can only prove staleness (content
        // cannot be newer than the moment it was fetched); it can never prove
        // freshness, so a row without a publication time is flagged instead
        // of being presented as current.
        const published = evidencePublishedAt(row)
        const ageDays = ((published ?? observed).getTime() > now.getTime()
          ? 0
          : (now.getTime() - (published ?? observed).getTime()) / 86_400_000)
        if (ageDays > policy.max_age_days) {
          issues.push('stale_evidence')
          score -= 35
        } else if (!published) {
          issues.push('publication_time_unknown')
          score -= 10
        }
      }
    }

    const confidence = Number(row.confidence)
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      issues.push('invalid_confidence')
      score -= 35
      invalid = true
    } else if (confidence < policy.min_confidence) {
      issues.push('below_minimum_confidence')
      score -= 30
    } else {
      score -= Math.round((1 - confidence) * 20)
    }

    score = Math.max(0, Math.min(100, score))
    return { evidence: row, status: rowStatus(score, invalid), score, issues }
  })

  const nonInvalid = rows.filter((row) => row.status !== 'invalid')
  const validEvidence = nonInvalid.map((row) => row.evidence)
  const score = nonInvalid.length
    ? Math.round(nonInvalid.reduce((sum, row) => sum + row.score, 0) / nonInvalid.length)
    : 0
  const status: EvidenceQualityStatus =
    rows.length === 0 || nonInvalid.length === 0
      ? 'invalid'
      : nonInvalid.some((row) => row.status === 'strong')
        ? 'strong'
        : nonInvalid.some((row) => row.status === 'usable')
          ? 'usable'
          : 'weak'

  return {
    status,
    score,
    issues: [...new Set(rows.flatMap((row) => row.issues))],
    rows,
    validEvidence,
  }
}
