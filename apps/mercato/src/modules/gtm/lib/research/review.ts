import type { ResearchEm } from './execute'
import { GtmAuditEvent, type GtmCandidate } from '../../data/entities'

/*
 * Manual review override for a sourced candidate (Tranche 3 qualification).
 * A human verdict replaces the rule-based one; the change and its actor are
 * written to gtm_audit_events in the SAME transaction as the candidate
 * update. A rejected candidate always carries an explicit reject reason.
 */

export type ReviewVerdict = 'accepted' | 'rejected'

export const DEFAULT_MANUAL_REJECT_REASON = 'manual_review_rejected'

export type ReviewCandidateInput = {
  em: ResearchEm
  candidate: GtmCandidate
  verdict: ReviewVerdict
  reason?: string | null
  userId: string
  requestId?: string | null
}

export type ReviewCandidateResult = {
  candidate: GtmCandidate
  audit: GtmAuditEvent
}

export async function reviewCandidate(input: ReviewCandidateInput): Promise<ReviewCandidateResult> {
  const { em, candidate, verdict, userId } = input
  const reason = (input.reason ?? '').trim() || null

  return em.transactional(async (tem) => {
    const previousFitStatus = candidate.fitStatus
    const previousRejectReason = candidate.rejectReason ?? null

    candidate.fitStatus = verdict
    if (verdict === 'rejected') {
      // Never blank for rejected candidates.
      candidate.rejectReason = reason ?? DEFAULT_MANUAL_REJECT_REASON
    } else {
      candidate.rejectReason = null
    }
    tem.persist(candidate)

    const audit = tem.create(GtmAuditEvent, {
      organizationId: candidate.organizationId,
      tenantId: candidate.tenantId,
      actor: 'user_id',
      actorUserId: userId,
      action: 'gtm.candidate.review_override',
      objectType: 'gtm_candidate',
      objectId: candidate.id,
      requestId: input.requestId ?? null,
      metadata: {
        verdict,
        reason: candidate.rejectReason,
        previous_fit_status: previousFitStatus,
        previous_reject_reason: previousRejectReason,
      },
    })
    tem.persist(audit)
    await tem.flush()

    return { candidate, audit }
  })
}
