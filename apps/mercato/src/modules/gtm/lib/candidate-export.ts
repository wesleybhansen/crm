import crypto from 'crypto'
import type { CampaignEm, GtmCtx } from './campaign/build'
import {
  GtmAuditEvent,
  GtmCandidate,
  GtmCandidateMatch,
  GtmContactPoint,
  GtmEvidence,
  GtmPlay,
} from '../data/entities'
import { computeExclusions } from './campaign/exclusions'

/*
 * R26 reviewed-lead export. This is intentionally narrower than a raw table
 * dump: a row must be the latest accepted person for one frozen play, carry an
 * unsuppressed verified email, and have explicit evidence-export permission.
 * The route returns structured rows; the Hub performs the final CSV escaping
 * and spreadsheet-formula neutralization immediately before download.
 */

export const REVIEWED_LEAD_EXPORT_SCHEMA_VERSION = '1'
export const REVIEWED_LEAD_EXPORT_CAP = 1000
const MATCH_SCAN_CAP = 5000

export type QualificationDiagnostics = {
  scored: number
  accepted: number
  review: number
  rejected: number
  unscored: number
  qualification_rate: number
  by_reason: Record<string, number>
}

export function qualificationDiagnostics(
  matches: Array<Pick<GtmCandidateMatch, 'fitStatus' | 'rejectReason'>>,
): QualificationDiagnostics {
  const result: QualificationDiagnostics = {
    scored: 0,
    accepted: 0,
    review: 0,
    rejected: 0,
    unscored: 0,
    qualification_rate: 0,
    by_reason: {},
  }
  for (const match of matches) {
    if (match.fitStatus === 'accepted') result.accepted += 1
    else if (match.fitStatus === 'review') result.review += 1
    else if (match.fitStatus === 'rejected') {
      result.rejected += 1
      const stored = match.rejectReason?.trim() ?? ''
      // Only deterministic reason codes belong in the grouped diagnostic.
      // A user's free-text rejection note can contain personal data and must
      // not be promoted into a workspace-wide rollup.
      const reason = /^[a-z0-9_:-]{1,80}$/.test(stored) ? stored : stored ? 'manual_review' : 'unspecified'
      result.by_reason[reason] = (result.by_reason[reason] ?? 0) + 1
    } else result.unscored += 1
  }
  result.scored = result.accepted + result.review + result.rejected
  result.qualification_rate = result.scored > 0 ? result.accepted / result.scored : 0
  return result
}

export type ReviewedLeadExportRow = {
  name: string
  title: string
  company: string
  profile_url: string
  verified_email: string
  fit_score: number | null
  fit_status: 'accepted'
  why_them: string
  evidence_source_urls: string[]
  latest_observed_at: string | null
  verification_state: 'verified'
}

export type ReviewedLeadExportResult = {
  schema_version: typeof REVIEWED_LEAD_EXPORT_SCHEMA_VERSION
  considered: number
  exported: number
  skipped_by_reason: Record<string, number>
  truncated: boolean
  rows: ReviewedLeadExportRow[]
  exportedCandidateIds: string[]
}

export class ReviewedLeadExportError extends Error {
  constructor(
    public code: 'scope_not_found' | 'scope_too_large' | 'idempotency_conflict',
    message: string,
  ) {
    super(message)
    this.name = 'ReviewedLeadExportError'
  }
}

type Identity = Record<string, unknown>

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function firstText(identity: Identity, keys: string[]): string {
  for (const key of keys) {
    const value = text(identity[key])
    if (value) return value
  }
  return ''
}

function httpsUrl(value: string): string {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed.toString() : ''
  } catch {
    return ''
  }
}

function qualificationReason(match: GtmCandidateMatch): string {
  const qualification = match.qualification
  if (qualification && typeof qualification === 'object') {
    const reason = text((qualification as Record<string, unknown>).reason)
    if (reason) return reason
  }
  return text(match.rejectReason)
}

function exportAllowed(evidence: GtmEvidence): boolean {
  const license = evidence.license
  return Boolean(license && typeof license === 'object' && license.export === true)
}

function iso(date: Date | null | undefined): string | null {
  return date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function increment(target: Record<string, number>, reason: string, amount = 1): void {
  target[reason] = (target[reason] ?? 0) + amount
}

function finiteScore(value: unknown): number | null {
  if (value == null) return null
  const score = Number(value)
  return Number.isFinite(score) ? score : null
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function deterministicAuditId(
  ctx: GtmCtx,
  input: { workspaceId: string; playId: string; idempotencyKey: string },
): string {
  const hex = sha256([
    'gtm-reviewed-lead-export-v1',
    ctx.organizationId,
    ctx.tenantId,
    input.workspaceId,
    input.playId,
    input.idempotencyKey,
  ].join('\n'))
  // RFC-4122-shaped deterministic UUID (version 5 + RFC variant) so the
  // existing audit primary key is also the idempotency fence.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function exportAuditMetadata(input: {
  workspaceId: string
  playId: string
  idempotencyKey: string
  result: ReviewedLeadExportResult
}): Record<string, unknown> {
  return {
    schema_version: input.result.schema_version,
    workspace_id: input.workspaceId,
    play_id: input.playId,
    considered: input.result.considered,
    exported: input.result.exported,
    skipped_by_reason: input.result.skipped_by_reason,
    truncated: input.result.truncated,
    candidate_set_hash: sha256([...input.result.exportedCandidateIds].sort().join('\n')),
    // Bind the idempotency fence to the exact released work product without
    // copying any name, address, URL, or evidence text into the audit row.
    // Rows and their nested URL arrays are already deterministically ordered.
    result_hash: sha256(JSON.stringify({
      schema_version: input.result.schema_version,
      considered: input.result.considered,
      exported: input.result.exported,
      skipped_by_reason: input.result.skipped_by_reason,
      truncated: input.result.truncated,
      rows: input.result.rows,
    })),
    idempotency_key_hash: sha256(input.idempotencyKey),
  }
}

function recordsEqual(left: unknown, right: Record<string, number>): boolean {
  if (!left || typeof left !== 'object' || Array.isArray(left)) return false
  const actual = left as Record<string, unknown>
  const keys = Object.keys(right).sort()
  return Object.keys(actual).sort().join('\n') === keys.join('\n')
    && keys.every((key) => actual[key] === right[key])
}

function auditMatches(audit: GtmAuditEvent, expected: Record<string, unknown>): boolean {
  const actual = audit.metadata
  if (!actual || typeof actual !== 'object') return false
  return (
    actual.schema_version === expected.schema_version
    && actual.workspace_id === expected.workspace_id
    && actual.play_id === expected.play_id
    && actual.considered === expected.considered
    && actual.exported === expected.exported
    && actual.truncated === expected.truncated
    && actual.candidate_set_hash === expected.candidate_set_hash
    && actual.result_hash === expected.result_hash
    && actual.idempotency_key_hash === expected.idempotency_key_hash
    && recordsEqual(actual.skipped_by_reason, expected.skipped_by_reason as Record<string, number>)
  )
}

export async function buildReviewedLeadExport(
  em: CampaignEm,
  ctx: GtmCtx,
  input: { workspaceId: string; playId: string },
): Promise<ReviewedLeadExportResult> {
  const play = await em.findOne(GtmPlay, {
    id: input.playId,
    workspaceId: input.workspaceId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!play) throw new ReviewedLeadExportError('scope_not_found', 'Export scope was not found')

  const matches = await em.find(
    GtmCandidateMatch,
    {
      workspaceId: input.workspaceId,
      playId: input.playId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    },
    { orderBy: { createdAt: 'desc' }, limit: MATCH_SCAN_CAP + 1 },
  )
  if (matches.length > MATCH_SCAN_CAP) {
    throw new ReviewedLeadExportError(
      'scope_too_large',
      `Export scope exceeds the ${MATCH_SCAN_CAP.toLocaleString()}-match reconciliation ceiling`,
    )
  }

  const latest: GtmCandidateMatch[] = []
  const seen = new Set<string>()
  for (const match of matches) {
    if (seen.has(match.candidateId)) continue
    seen.add(match.candidateId)
    latest.push(match)
  }
  const acceptedMatches = latest.filter((match) => match.fitStatus === 'accepted')
  const candidateIds = acceptedMatches.map((match) => match.candidateId)
  const candidates = candidateIds.length
    ? await em.find(GtmCandidate, {
        id: { $in: candidateIds },
        workspaceId: input.workspaceId,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        deletedAt: null,
      })
    : []
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  const matchByCandidate = new Map(acceptedMatches.map((match) => [match.candidateId, match]))

  const exclusions = await computeExclusions(em, ctx, {
    workspaceId: input.workspaceId,
    candidateIds: candidates.map((candidate) => candidate.id),
    channel: 'email',
    allowDuplicates: true,
  })

  const contactPoints = candidates.length
    ? await em.find(GtmContactPoint, {
        candidateId: { $in: candidates.map((candidate) => candidate.id) },
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        deletedAt: null,
      })
    : []
  const pointsByCandidate = new Map<string, GtmContactPoint[]>()
  for (const point of contactPoints) {
    const rows = pointsByCandidate.get(point.candidateId) ?? []
    rows.push(point)
    pointsByCandidate.set(point.candidateId, rows)
  }

  const evidenceRows = candidates.length
    ? await em.find(GtmEvidence, {
        candidateId: { $in: candidates.map((candidate) => candidate.id) },
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        deletedAt: null,
      })
    : []
  const evidenceByCandidate = new Map<string, GtmEvidence[]>()
  for (const evidence of evidenceRows) {
    const match = matchByCandidate.get(evidence.candidateId)
    if (!match || evidence.researchRunId !== match.researchRunId) continue
    const rows = evidenceByCandidate.get(evidence.candidateId) ?? []
    rows.push(evidence)
    evidenceByCandidate.set(evidence.candidateId, rows)
  }

  const skipped: Record<string, number> = {}
  const eligible: Array<{ candidateId: string; row: ReviewedLeadExportRow }> = []
  for (const match of acceptedMatches) {
    const candidate = candidateById.get(match.candidateId)
    if (!candidate) {
      increment(skipped, 'candidate_unavailable')
      continue
    }
    if (candidate.entityKind !== 'person') {
      increment(skipped, 'not_a_person')
      continue
    }
    const exclusion = exclusions.byCandidate.get(candidate.id)
    if (!exclusion || exclusion.excluded || !exclusion.address) {
      const reason = exclusion?.reason === 'no_verified_contact_point'
        ? 'no_verified_email'
        : exclusion?.reason
          ? `suppressed_${exclusion.reason}`
          : 'no_verified_email'
      increment(skipped, reason)
      continue
    }
    const contextualEvidence = evidenceByCandidate.get(candidate.id) ?? []
    // Candidate identity and its explanation are derived from this evidence
    // set as a whole. One permissive row cannot launder a second missing or
    // denied source into an export.
    if (contextualEvidence.length === 0 || contextualEvidence.some((row) => !exportAllowed(row))) {
      increment(skipped, 'export_rights_unconfirmed')
      continue
    }
    const permittedEvidence = contextualEvidence
    const identity = candidate.identity ?? {}
    const linkedinPoint = (pointsByCandidate.get(candidate.id) ?? []).find(
      (point) => point.channel === 'linkedin' && /^https:\/\//i.test(point.value.trim()),
    )
    const sourceUrls = [...new Set(
      permittedEvidence
        .map((row) => httpsUrl(text(row.sourceUrl)))
        .filter(Boolean),
    )].sort()
    const observed = permittedEvidence
      .map((row) => row.observedAt)
      .filter((value): value is Date => value instanceof Date && Number.isFinite(value.getTime()))
      .sort((left, right) => right.getTime() - left.getTime())[0]
    eligible.push({
      candidateId: candidate.id,
      row: {
        name: firstText(identity, ['name', 'full_name', 'fullName']),
        title: firstText(identity, ['title', 'job_title', 'jobTitle', 'headline']),
        company: firstText(identity, ['company', 'company_name', 'companyName']),
        profile_url:
          httpsUrl(firstText(identity, ['linkedin_url', 'linkedinUrl', 'profile_url', 'profileUrl']))
          || httpsUrl(linkedinPoint?.value.trim() ?? '')
          || '',
        verified_email: exclusion.address,
        fit_score: finiteScore(match.fitScore),
        fit_status: 'accepted',
        why_them: qualificationReason(match),
        evidence_source_urls: sourceUrls,
        latest_observed_at: iso(observed),
        verification_state: 'verified',
      },
    })
  }

  eligible.sort((left, right) => {
    const score = (right.row.fit_score ?? -1) - (left.row.fit_score ?? -1)
    if (score !== 0) return score
    return left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0
  })
  const truncated = eligible.length > REVIEWED_LEAD_EXPORT_CAP
  if (truncated) increment(skipped, 'export_cap', eligible.length - REVIEWED_LEAD_EXPORT_CAP)
  const exported = eligible.slice(0, REVIEWED_LEAD_EXPORT_CAP)
  return {
    schema_version: REVIEWED_LEAD_EXPORT_SCHEMA_VERSION,
    considered: acceptedMatches.length,
    exported: exported.length,
    skipped_by_reason: skipped,
    truncated,
    rows: exported.map((entry) => entry.row),
    exportedCandidateIds: exported.map((entry) => entry.candidateId),
  }
}

export async function auditReviewedLeadExport(
  em: CampaignEm,
  ctx: GtmCtx,
  input: {
    workspaceId: string
    playId: string
    idempotencyKey: string
    result: ReviewedLeadExportResult
  },
): Promise<GtmAuditEvent> {
  const auditId = deterministicAuditId(ctx, input)
  const metadata = exportAuditMetadata(input)
  const existing = await em.findOne(GtmAuditEvent, {
    id: auditId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    action: 'gtm.candidates.exported',
  })
  if (existing) {
    if (auditMatches(existing, metadata)) return existing
    throw new ReviewedLeadExportError('idempotency_conflict', 'Export idempotency key was already used for different rows')
  }
  try {
    return await em.transactional(async (tem) => {
      const raced = await tem.findOne(GtmAuditEvent, {
        id: auditId,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        action: 'gtm.candidates.exported',
      })
      if (raced) {
        if (auditMatches(raced, metadata)) return raced
        throw new ReviewedLeadExportError('idempotency_conflict', 'Export idempotency key was already used for different rows')
      }
      const audit = tem.create(GtmAuditEvent, {
        id: auditId,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        actor: 'user_id',
        actorUserId: ctx.userId,
        action: 'gtm.candidates.exported',
        objectType: 'gtm_play',
        objectId: input.playId,
        requestId: ctx.requestId ?? null,
        metadata,
      })
      tem.persist(audit)
      await tem.flush()
      return audit
    })
  } catch (err) {
    if (err instanceof ReviewedLeadExportError) throw err
    // A concurrent identical request can win the deterministic audit PK. Read
    // it back and accept only an exact redacted fingerprint match.
    const raced = await em.findOne(GtmAuditEvent, {
      id: auditId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      action: 'gtm.candidates.exported',
    })
    if (raced && auditMatches(raced, metadata)) return raced
    throw err
  }
}
