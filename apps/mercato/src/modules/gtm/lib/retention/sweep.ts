import {
  GtmAuditEvent,
  GtmCandidate,
  GtmContactPoint,
  GtmEnrollment,
  GtmEvidence,
} from '../../data/entities'

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
 * Exposure: there is no in-app worker convention in apps/mercato modules
 * (queue workers live in packages/* behind BullMQ wiring), so the sweep is
 * exposed as op 'retention-sweep' on the /internal/gtm/research-runs route,
 * guarded by the same shared-secret service auth. Any scheduler (cron,
 * hub-side job) can trigger it; the sweep itself is idempotent - a second
 * run finds nothing left to delete.
 */

// Minimal structural slice of MikroORM's EntityManager used by the sweep, so
// tests can drive it with the in-memory FakeEm and routes pass the real em.
export interface RetentionEm {
  transactional<T>(cb: (tem: RetentionEm) => Promise<T>): Promise<T>
  create<T extends object>(entityClass: new () => T, data: object): T
  persist(entity: object): unknown
  remove(entity: object): unknown
  flush(): Promise<void>
  find<T extends object>(entityClass: new () => T, where: Record<string, unknown>): Promise<T[]>
}

export type SweepOptions = {
  // limit the sweep to one organization; omitted = all organizations
  orgId?: string | null
  now?: Date
}

export type SweepResult = {
  candidatesDeleted: number
  evidenceDeleted: number
  contactPointsDeleted: number
  // expired never-promoted candidates kept because an enrollment references them
  skippedEnrolled: number
  // one audit event is written per swept (org, tenant) batch
  batches: number
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
    skippedEnrolled: 0,
    batches: 0,
  }

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

  // An enrollment in ANY status blocks deletion: enrolled candidates carry
  // durable outreach history (send attempts, replies) that must not dangle.
  const enrolledIds = new Set<string>()
  const enrollments = await em.find(GtmEnrollment, {
    candidateId: { $in: expired.map((candidate) => candidate.id) },
  })
  for (const enrollment of enrollments) enrolledIds.add(enrollment.candidateId)

  const sweepable = expired.filter((candidate) => !enrolledIds.has(candidate.id))
  result.skippedEnrolled = expired.length - sweepable.length
  if (sweepable.length === 0) return result

  // Group by (org, tenant): each group deletes and audits atomically.
  const groups = new Map<string, GtmCandidate[]>()
  for (const candidate of sweepable) {
    const key = `${candidate.organizationId}:${candidate.tenantId}`
    const list = groups.get(key) ?? []
    list.push(candidate)
    groups.set(key, list)
  }

  for (const batch of groups.values()) {
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
          cutoff: now.toISOString(),
        },
      })
      tem.persist(audit)
      await tem.flush()

      result.candidatesDeleted += batch.length
      result.evidenceDeleted += evidence.length
      result.contactPointsDeleted += contactPoints.length
      result.batches += 1
    })
  }

  return result
}
