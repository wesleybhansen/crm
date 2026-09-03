import crypto from 'crypto'
import {
  GtmAuditEvent,
  GtmCandidate,
  GtmCandidateMatch,
  GtmCandidateRelation,
  GtmContactPoint,
  GtmDeletionRequest,
  GtmEnrollment,
  GtmEvidence,
  GtmManualOutreachDraft,
  GtmRenderedMessage,
} from '../../data/entities'
import { GLOBAL_SUPPRESSION_ORG_ID } from '../privacy/constants'

/*
 * Candidate retention sweep (SPEC-066 section 4, Tranche 4).
 *
 * gtm_candidates.retention_expires_at defaults to 90 days for never-promoted
 * candidates. This sweep HARD-DELETES (not soft-deletes) every candidate
 * whose retention window has passed, provided the candidate:
 *   - was never promoted to a CRM contact (promoted_contact_id IS NULL), and
 *   - has no enrollment row in any campaign (any status - an enrollment is
 *     durable outreach history and blocks deletion).
 *
 * The candidate's evidence and contact points cascade in the same
 * transaction. One gtm_audit_events row is written per swept (org, tenant)
 * batch carrying ONLY counts - no names, no addresses, no identity material
 * (the deleted rows are gone; the audit trail must not resurrect their PII).
 *
 * Post-campaign rule (review H7): an enrolled candidate is never hard-deleted
 * (the enrollment is outreach history), but once EVERY enrollment has been
 * stopped or completed for POST_CAMPAIGN_RETENTION_DAYS the personal data
 * has no remaining purpose: contact points, the rendered subject/body of
 * every message sent to them, and the identity are anonymized in place and
 * the candidate is soft-deleted. Bounded per sweep so a large backlog cannot
 * hold a transaction open.
 *
 * Manual outreach drafts carry their own 30-day retention_expires_at that
 * reads only filtered on; expired drafts are hard-deleted here regardless of
 * candidate state (review H7).
 *
 * Legal holds (review M11): a deletion request with legal_hold set protects
 * every candidate whose email contact point hashes to that request's address
 * (tenant requests in their org, global requests everywhere) and every
 * candidate a removal already stamped with that request id. The hold is
 * honoured whatever the request status (a completed removal can still be
 * placed under hold afterwards; over-retention under a hold is the safe
 * direction). Held rows are skipped by every rule above and counted.
 *
 * Exposure: the process-secret route /internal/gtm/retention (global) and the
 * represented-user op 'retention-sweep' on /internal/gtm/research-runs. The
 * schedule is documented in RETENTION_SCHEDULE.md. The sweep is idempotent.
 */

// Minimal structural slice of MikroORM's EntityManager used by the sweep, so
// tests can drive it with the in-memory FakeEm and routes pass the real em.
export interface RetentionEm {
  transactional<T>(cb: (tem: RetentionEm) => Promise<T>): Promise<T>
  create<T extends object>(entityClass: new () => T, data: object): T
  persist(entity: object): unknown
  remove(entity: object): unknown
  flush(): Promise<void>
  find<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
    options?: { orderBy?: Record<string, 'asc' | 'desc'>; limit?: number },
  ): Promise<T[]>
}

export const POST_CAMPAIGN_RETENTION_DAYS = 90
export const POST_CAMPAIGN_BATCH = 200
export const MANUAL_DRAFT_BATCH = 500

export type SweepOptions = {
  // limit the sweep to one organization; omitted = all organizations
  orgId?: string | null
  now?: Date
  postCampaignBatch?: number
  manualDraftBatch?: number
}

export type SweepResult = {
  candidatesDeleted: number
  evidenceDeleted: number
  contactPointsDeleted: number
  relationsDeleted: number
  manualDraftsDeleted: number
  // expired never-promoted candidates kept because an enrollment references them
  // and their outreach has not been finished for POST_CAMPAIGN_RETENTION_DAYS
  skippedEnrolled: number
  // expired candidates protected by a non-completed legal-hold request
  skippedLegalHold: number
  // post-campaign anonymization (enrolled candidates finished > 90 days ago)
  postCampaignAnonymized: number
  postCampaignContactPointsAnonymized: number
  postCampaignRenderedAnonymized: number
  // expired manual outreach drafts hard-deleted regardless of candidate state
  expiredManualDraftsDeleted: number
  // one audit event is written per swept (org, tenant) batch
  batches: number
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function hashAddress(address: string): string {
  return crypto.createHash('sha256').update(address.trim().toLowerCase()).digest('hex')
}

function groupByScope<T extends { organizationId: string; tenantId: string }>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const key = `${row.organizationId}:${row.tenantId}`
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }
  return [...groups.values()]
}

type LegalHoldIndex = {
  requestIds: Set<string>
  globalHashes: Set<string>
  // organizationId -> address hashes held in that org
  orgHashes: Map<string, Set<string>>
  empty: boolean
}

async function loadLegalHolds(em: RetentionEm): Promise<LegalHoldIndex> {
  const holds = await em.find(GtmDeletionRequest, {
    legalHold: true,
    deletedAt: null,
  })
  const index: LegalHoldIndex = {
    requestIds: new Set(),
    globalHashes: new Set(),
    orgHashes: new Map(),
    empty: holds.length === 0,
  }
  for (const hold of holds) {
    index.requestIds.add(hold.id)
    if (hold.organizationId === GLOBAL_SUPPRESSION_ORG_ID || hold.scope === 'global_email') {
      index.globalHashes.add(hold.addressHash)
    } else {
      const set = index.orgHashes.get(hold.organizationId) ?? new Set<string>()
      set.add(hold.addressHash)
      index.orgHashes.set(hold.organizationId, set)
    }
  }
  return index
}

function isHeld(
  candidate: GtmCandidate,
  hashes: string[],
  holds: LegalHoldIndex,
): boolean {
  if (holds.empty) return false
  const stamped = candidate.identity?.removal_request_id
  if (typeof stamped === 'string' && holds.requestIds.has(stamped)) return true
  const orgSet = holds.orgHashes.get(candidate.organizationId)
  return hashes.some((hash) => holds.globalHashes.has(hash) || orgSet?.has(hash) === true)
}

function enrollmentFinishedAt(enrollment: GtmEnrollment): Date | null {
  if (enrollment.status === 'active') return null
  return enrollment.stoppedAt ?? enrollment.updatedAt ?? null
}

export async function sweepExpiredCandidates(
  em: RetentionEm,
  options?: SweepOptions,
): Promise<SweepResult> {
  const now = options?.now ?? new Date()
  const result: SweepResult = {
    candidatesDeleted: 0,
    evidenceDeleted: 0,
    contactPointsDeleted: 0,
    relationsDeleted: 0,
    manualDraftsDeleted: 0,
    skippedEnrolled: 0,
    skippedLegalHold: 0,
    postCampaignAnonymized: 0,
    postCampaignContactPointsAnonymized: 0,
    postCampaignRenderedAnonymized: 0,
    expiredManualDraftsDeleted: 0,
    batches: 0,
  }

  // Expired manual drafts first: independent of candidate state, bounded.
  result.expiredManualDraftsDeleted = await deleteExpiredManualDrafts(em, now, options)

  // Expired AND never promoted. Soft-deleted rows are already invisible to
  // the product; they still hard-delete here so PII does not outlive the
  // retention window, hence no deletedAt filter.
  const where: Record<string, unknown> = {
    promotedContactId: null,
    retentionExpiresAt: { $lte: now },
  }
  if (options?.orgId) where.organizationId = options.orgId

  const expired = await em.find(GtmCandidate, where)
  if (expired.length === 0) return result

  const holds = await loadLegalHolds(em)
  const expiredIds = expired.map((candidate) => candidate.id)
  // Email hashes per candidate are only needed when a hold exists.
  const hashesByCandidate = new Map<string, string[]>()
  if (!holds.empty) {
    const points = await em.find(GtmContactPoint, {
      candidateId: { $in: expiredIds },
      channel: 'email',
    })
    for (const point of points) {
      const list = hashesByCandidate.get(point.candidateId) ?? []
      list.push(hashAddress(point.value))
      hashesByCandidate.set(point.candidateId, list)
    }
  }
  const unheld: GtmCandidate[] = []
  for (const candidate of expired) {
    if (isHeld(candidate, hashesByCandidate.get(candidate.id) ?? [], holds)) {
      result.skippedLegalHold += 1
      continue
    }
    unheld.push(candidate)
  }
  if (unheld.length === 0) return result

  // An enrollment in ANY status blocks hard deletion: enrolled candidates
  // carry durable outreach history (send attempts, replies) that must not
  // dangle. They fall through to the post-campaign anonymization rule.
  const enrollmentsByCandidate = new Map<string, GtmEnrollment[]>()
  const enrollments = await em.find(GtmEnrollment, {
    candidateId: { $in: unheld.map((candidate) => candidate.id) },
  })
  for (const enrollment of enrollments) {
    const list = enrollmentsByCandidate.get(enrollment.candidateId) ?? []
    list.push(enrollment)
    enrollmentsByCandidate.set(enrollment.candidateId, list)
  }

  const sweepable = unheld.filter((candidate) => !enrollmentsByCandidate.has(candidate.id))
  const enrolled = unheld.filter((candidate) => enrollmentsByCandidate.has(candidate.id))

  for (const batch of groupByScope(sweepable)) {
    const { organizationId, tenantId } = batch[0]
    const ids = batch.map((candidate) => candidate.id)

    await em.transactional(async (tem) => {
      const evidence = await tem.find(GtmEvidence, {
        organizationId,
        tenantId,
        candidateId: { $in: ids },
      })
      const contactPoints = await tem.find(GtmContactPoint, {
        organizationId,
        tenantId,
        candidateId: { $in: ids },
      })
      const matches = await tem.find(GtmCandidateMatch, {
        organizationId,
        tenantId,
        candidateId: { $in: ids },
      })
      const relations = await tem.find(GtmCandidateRelation, {
        organizationId,
        tenantId,
        $or: [
          { parentCandidateId: { $in: ids } },
          { childCandidateId: { $in: ids } },
        ],
      })
      const manualDrafts = await tem.find(GtmManualOutreachDraft, {
        organizationId,
        tenantId,
        candidateId: { $in: ids },
      })

      for (const row of manualDrafts) tem.remove(row)
      for (const row of relations) tem.remove(row)
      for (const row of matches) tem.remove(row)
      for (const row of evidence) tem.remove(row)
      for (const row of contactPoints) tem.remove(row)
      for (const candidate of batch) tem.remove(candidate)

      // Counts only - never identity material of the deleted rows.
      const audit = tem.create(GtmAuditEvent, {
        organizationId,
        tenantId,
        actor: 'system',
        action: 'gtm.candidate.retention_sweep',
        objectType: 'gtm_candidate',
        objectId: null,
        metadata: {
          candidates_deleted: batch.length,
          evidence_deleted: evidence.length,
          contact_points_deleted: contactPoints.length,
          relations_deleted: relations.length,
          manual_drafts_deleted: manualDrafts.length,
          cutoff: now.toISOString(),
        },
      })
      tem.persist(audit)
      await tem.flush()

      result.candidatesDeleted += batch.length
      result.evidenceDeleted += evidence.length
      result.contactPointsDeleted += contactPoints.length
      result.relationsDeleted += relations.length
      result.manualDraftsDeleted += manualDrafts.length
      result.batches += 1
    })
  }

  // Post-campaign rule: every enrollment finished more than
  // POST_CAMPAIGN_RETENTION_DAYS ago, not yet anonymized, bounded batch.
  const cutoff = new Date(now.getTime() - POST_CAMPAIGN_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const batchLimit = options?.postCampaignBatch ?? POST_CAMPAIGN_BATCH
  const finished: GtmCandidate[] = []
  for (const candidate of enrolled) {
    if (candidate.identity?.retention_anonymized_at) continue
    const rows = enrollmentsByCandidate.get(candidate.id) ?? []
    let latest: Date | null = null
    let allFinished = true
    for (const enrollment of rows) {
      const finishedAt = enrollmentFinishedAt(enrollment)
      if (!finishedAt) {
        allFinished = false
        break
      }
      if (!latest || finishedAt > latest) latest = finishedAt
    }
    if (!allFinished || !latest || latest > cutoff) {
      result.skippedEnrolled += 1
      continue
    }
    if (finished.length < batchLimit) finished.push(candidate)
    else result.skippedEnrolled += 1
  }

  for (const batch of groupByScope(finished)) {
    const { organizationId, tenantId } = batch[0]
    const ids = batch.map((candidate) => candidate.id)
    const enrollmentIds = batch.flatMap((candidate) =>
      (enrollmentsByCandidate.get(candidate.id) ?? []).map((row) => row.id),
    )
    await em.transactional(async (tem) => {
      const contactPoints = await tem.find(GtmContactPoint, {
        organizationId,
        tenantId,
        candidateId: { $in: ids },
      })
      const rendered = enrollmentIds.length
        ? await tem.find(GtmRenderedMessage, {
            organizationId,
            tenantId,
            enrollmentId: { $in: enrollmentIds },
          })
        : []
      const manualDrafts = await tem.find(GtmManualOutreachDraft, {
        organizationId,
        tenantId,
        candidateId: { $in: ids },
      })
      for (const point of contactPoints) {
        point.value = `removed:${digest({ retention: point.candidateId, point: point.id })}`
        point.verificationState = 'not_found'
        point.provenance = null
        point.verifiedAt = null
        point.deletedAt = now
        point.updatedAt = now
        tem.persist(point)
      }
      for (const row of rendered) {
        row.subject = null
        row.bodyHtml = null
        row.bodyText = null
        row.updatedAt = now
        tem.persist(row)
      }
      for (const row of manualDrafts) tem.remove(row)
      for (const candidate of batch) {
        candidate.identity = { removed: true, retention_anonymized_at: now.toISOString() }
        candidate.dedupeKey = digest({ retention: candidate.id })
        candidate.qualification = null
        candidate.deletedAt = now
        candidate.updatedAt = now
        tem.persist(candidate)
      }
      const audit = tem.create(GtmAuditEvent, {
        organizationId,
        tenantId,
        actor: 'system',
        action: 'gtm.candidate.post_campaign_anonymized',
        objectType: 'gtm_candidate',
        objectId: null,
        metadata: {
          candidates_anonymized: batch.length,
          contact_points_anonymized: contactPoints.length,
          rendered_messages_anonymized: rendered.length,
          manual_drafts_deleted: manualDrafts.length,
          retention_days: POST_CAMPAIGN_RETENTION_DAYS,
          cutoff: cutoff.toISOString(),
        },
      })
      tem.persist(audit)
      await tem.flush()

      result.postCampaignAnonymized += batch.length
      result.postCampaignContactPointsAnonymized += contactPoints.length
      result.postCampaignRenderedAnonymized += rendered.length
      result.manualDraftsDeleted += manualDrafts.length
      result.batches += 1
    })
  }

  return result
}

async function deleteExpiredManualDrafts(
  em: RetentionEm,
  now: Date,
  options?: SweepOptions,
): Promise<number> {
  const where: Record<string, unknown> = { retentionExpiresAt: { $lte: now } }
  if (options?.orgId) where.organizationId = options.orgId
  const expired = await em.find(GtmManualOutreachDraft, where, {
    orderBy: { retentionExpiresAt: 'asc' },
    limit: options?.manualDraftBatch ?? MANUAL_DRAFT_BATCH,
  })
  if (expired.length === 0) return 0
  let deleted = 0
  for (const batch of groupByScope(expired)) {
    const { organizationId, tenantId } = batch[0]
    await em.transactional(async (tem) => {
      for (const row of batch) tem.remove(row)
      tem.persist(
        tem.create(GtmAuditEvent, {
          organizationId,
          tenantId,
          actor: 'system',
          action: 'gtm.manual_outreach_draft.retention_sweep',
          objectType: 'gtm_manual_outreach_draft',
          objectId: null,
          metadata: { drafts_deleted: batch.length, cutoff: now.toISOString() },
        }),
      )
      await tem.flush()
      deleted += batch.length
    })
  }
  return deleted
}
