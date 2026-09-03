import type { ResearchEm } from './execute'
import { GtmAuditEvent, type GtmCandidate, type GtmCandidateMatch } from '../../data/entities'

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

export type ReviewCandidateMatchInput = {
  em: ResearchEm
  candidate: GtmCandidate
  match: GtmCandidateMatch
  verdict: ReviewVerdict
  reason?: string | null
  userId: string
  requestId?: string | null
}

export type ReviewCandidateMatchResult = {
  candidate: GtmCandidate
  match: GtmCandidateMatch
  audit: GtmAuditEvent
}

/** Apply a human verdict to one frozen play/run match, never globally. */
export async function reviewCandidateMatch(
  input: ReviewCandidateMatchInput,
): Promise<ReviewCandidateMatchResult> {
  const { em, candidate, match, verdict, userId } = input
  const reason = (input.reason ?? '').trim() || null

  return em.transactional(async (tem) => {
    const previousFitStatus = match.fitStatus
    const previousRejectReason = match.rejectReason ?? null
    match.fitStatus = verdict
    match.rejectReason = verdict === 'rejected'
      ? reason ?? DEFAULT_MANUAL_REJECT_REASON
      : null
    tem.persist(match)

    const audit = tem.create(GtmAuditEvent, {
      organizationId: match.organizationId,
      tenantId: match.tenantId,
      actor: 'user_id',
      actorUserId: userId,
      action: 'gtm.candidate_match.review_override',
      objectType: 'gtm_candidate_match',
      objectId: match.id,
      requestId: input.requestId ?? null,
      metadata: {
        candidate_id: candidate.id,
        research_run_id: match.researchRunId,
        play_id: match.playId,
        verdict,
        reason: match.rejectReason,
        previous_fit_status: previousFitStatus,
        previous_reject_reason: previousRejectReason,
      },
    })
    tem.persist(audit)
    await tem.flush()
    return { candidate, match, audit }
  })
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
        // Lets requalify attribute a root-level override to the run that
        // inserted the row instead of any run that later reused it.
        research_run_id: candidate.researchRunId,
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
