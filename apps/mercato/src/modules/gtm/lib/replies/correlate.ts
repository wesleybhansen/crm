import type { GtmCtx } from '../campaign/build'
import type { Clock, ExecutionEm } from '../execute/schedule'
import { GtmExecutionError } from '../execute/schedule'
import { keywordClassifier, classifyReply, type ReplyClassifier } from './classify'
import {
  GtmAuditEvent,
  GtmContactPoint,
  GtmEnrollment,
  GtmReply,
  GtmSendAttempt,
  GtmStep,
} from '../../data/entities'
import { EmailMessage } from '../../../email/data/schema'

/*
 * Reply correlation + THE atomic stop (SPEC-066 sections 9, 3.3, Tranche 6).
 *
 * Constraint honored here: nothing outside modules/gtm is edited, so there
 * is no inbox-ingest hook. Correlation instead SCANS recent inbound
 * email_messages rows (org+tenant scoped, direction 'inbound'):
 *
 *   1. Header match: candidate Message-IDs parsed from
 *      metadata.headers['in-reply-to'] / ['references'] (when the ingest
 *      captured them) PLUS the row's thread_id (inbox-ingest stores the
 *      References-chain root there with angle brackets stripped, so a reply
 *      to a GTM send carries our rfc_message_id as its thread_id even though
 *      the raw headers are not persisted today). The candidates are matched
 *      against gtm_send_attempts.rfc_message_id by exact string lookup
 *      (bracketed + bare forms) - an indexed $in query, never a scan of the
 *      attempts table.
 *   2. Fallback match: same mailbox (email_messages.account_id equals the
 *      attempt's mailbox_connection_id) + counterparty from_address equal to
 *      a LIVE enrollment's verified contact address; the reply is linked to
 *      that enrollment's most recent provider-contacted attempt.
 *
 * THE ATOMIC STOP (section 9), in ONE transaction: enrollment 'stopped'
 * (stop_reason 'email_reply' / 'social_reply'), every remaining pre-claim
 * attempt cancelled (approved/planned/rendered/reviewed -> 'failed' reason
 * 'stopped'), pending manual steps cancelled BY that same stop (manual
 * social steps have no rows of their own in this tranche - Tranche 7 tasks
 * key off enrollment.status, so status != 'active' IS the durable cancel
 * marker), THEN the GtmReply row is inserted in the same transaction. The
 * reply can never surface before the stop is durable. Rows already under
 * claim ARE cancelled (claim_token nulled), which is what actually closes the
 * race: the executor rechecks enrollment.status early but then does nine more
 * DB round trips before contacting the provider, so a reply correlating in
 * that window would otherwise still be mailed. Safe because send.ts writes
 * 'provider_started' BEFORE the transport, so a 'claimed' row has provably
 * not reached the provider; the executor's fenced write then matches 0 rows
 * and returns 'fenced'. 'provider_started' and later are left alone - the
 * message may already be out, and their own fenced writes settle it.
 *
 * Idempotent: a message that already has a GtmReply row is skipped;
 * re-recording a social reply for the same (enrollment, step) returns the
 * existing row.
 *
 * User-recorded social replies (recordSocialReply) take the IDENTICAL
 * transaction path - the non-negotiable that both reply kinds stop all
 * remaining mixed-channel steps atomically.
 */

const NON_TERMINAL_CANCELABLE = ['planned', 'rendered', 'reviewed', 'approved', 'claimed']
const PROVIDER_CONTACTED_STATES = [
  'provider_started',
  'accepted',
  'delivered',
  'bounced',
  'complained',
  'replied',
  'ambiguous',
]

function normalizeMessageId(value: string): string {
  return value.replace(/[<>]/g, '').trim()
}

// Candidate Message-IDs a reply may reference: parsed In-Reply-To /
// References headers (metadata.headers, when present) plus thread_id.
export function parseReplyCandidateIds(message: EmailMessage): string[] {
  const out = new Set<string>()
  const metadata = (message.metadata ?? {}) as Record<string, unknown>
  const headers = (metadata.headers ?? {}) as Record<string, unknown>
  for (const key of ['in-reply-to', 'references']) {
    const raw = headers[key]
    if (typeof raw !== 'string' || !raw.trim()) continue
    for (const token of raw.split(/[\s,]+/)) {
      const normalized = normalizeMessageId(token)
      if (normalized) out.add(normalized)
    }
  }
  if (message.threadId) {
    const normalized = normalizeMessageId(message.threadId)
    if (normalized) out.add(normalized)
  }
  return [...out]
}

export type AtomicStopInput = {
  enrollment: GtmEnrollment
  stopReason: 'email_reply' | 'social_reply'
  channel: 'email' | 'linkedin' | 'x'
  sendAttemptId?: string | null
  stepId?: string | null
  emailMessageId?: string | null
  note?: string | null
  actorUserId?: string | null
  requestId?: string | null
  now: Date
}

// ONE transaction: stop, cancel, then insert the reply (section 9).
export async function atomicStopWithReply(
  em: ExecutionEm,
  input: AtomicStopInput,
): Promise<GtmReply> {
  const { enrollment, now } = input
  return em.transactional(async (tem) => {
    if (enrollment.status === 'active') {
      enrollment.status = 'stopped'
      enrollment.stopReason = input.stopReason
      enrollment.stoppedAt = now
      tem.persist(enrollment)
    }
    // Cancel every attempt that has not yet contacted the provider, INCLUDING
    // 'claimed' (see the header note): nulling claim_token fences the in-flight
    // executor out. 'provider_started' and later settle through their own
    // fenced writes.
    await tem.nativeUpdate(
      GtmSendAttempt,
      {
        organizationId: enrollment.organizationId,
        tenantId: enrollment.tenantId,
        enrollmentId: enrollment.id,
        state: { $in: NON_TERMINAL_CANCELABLE },
      },
      {
        state: 'failed',
        failureReason: 'stopped',
        claimToken: null,
        failedAt: now,
        updatedAt: now,
      },
    )
    const reply = tem.create(GtmReply, {
      organizationId: enrollment.organizationId,
      tenantId: enrollment.tenantId,
      enrollmentId: enrollment.id,
      sendAttemptId: input.sendAttemptId ?? null,
      stepId: input.stepId ?? null,
      channel: input.channel,
      direction: 'inbound',
      emailMessageId: input.emailMessageId ?? null,
      classification: null,
      classificationSource: null,
      draftResponse: input.note ? { note: input.note } : null,
      draftStatus: 'none',
    })
    tem.persist(reply)
    tem.persist(
      tem.create(GtmAuditEvent, {
        organizationId: enrollment.organizationId,
        tenantId: enrollment.tenantId,
        actor: input.actorUserId ? 'user_id' : 'system',
        actorUserId: input.actorUserId ?? null,
        action: 'gtm.reply.recorded',
        objectType: 'gtm_reply',
        objectId: reply.id,
        requestId: input.requestId ?? null,
        metadata: {
          enrollment_id: enrollment.id,
          stop_reason: input.stopReason,
          channel: input.channel,
          email_message_id: input.emailMessageId ?? null,
          step_id: input.stepId ?? null,
        },
      }),
    )
    await tem.flush()
    return reply
  })
}

export type CorrelatedReply = {
  reply: GtmReply
  matchedBy: 'header' | 'fallback'
  attemptId: string
  enrollmentId: string
  emailMessageId: string
}

export type CorrelateResult = {
  scanned: number
  matched: CorrelatedReply[]
}

export async function correlateReplies(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: { sinceMinutes?: number; clock?: Clock; classifier?: ReplyClassifier } = {},
): Promise<CorrelateResult> {
  const now = input.clock?.now() ?? new Date()
  const sinceMinutes = input.sinceMinutes && input.sinceMinutes > 0 ? input.sinceMinutes : 24 * 60
  const since = new Date(now.getTime() - sinceMinutes * 60 * 1000)

  const messages = await em.find(EmailMessage, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    direction: 'inbound',
    deletedAt: null,
    createdAt: { $gte: since },
  })

  const matched: CorrelatedReply[] = []
  for (const message of messages) {
    // Idempotency: one GtmReply per inbound message, ever.
    const existing = await em.findOne(GtmReply, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      emailMessageId: message.id,
    })
    if (existing) continue

    let attempt: GtmSendAttempt | null = null
    let matchedBy: 'header' | 'fallback' = 'header'

    // 1. Header/thread exact match against rfc_message_id (indexed lookup).
    const candidateIds = parseReplyCandidateIds(message)
    if (candidateIds.length > 0) {
      const forms = candidateIds.flatMap((id) => [id, `<${id}>`])
      const matches = await em.find(GtmSendAttempt, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        rfcMessageId: { $in: forms },
        deletedAt: null,
      })
      attempt = matches[0] ?? null
    }

    // 2. Fallback: same mailbox + counterparty address of a live enrollment.
    if (!attempt && message.accountId && message.fromAddress) {
      attempt = await fallbackMatch(em, ctx, message)
      matchedBy = 'fallback'
    }
    if (!attempt) continue

    const enrollment = await em.findOne(GtmEnrollment, {
      id: attempt.enrollmentId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    })
    if (!enrollment) continue

    const reply = await atomicStopWithReply(em, {
      enrollment,
      stopReason: 'email_reply',
      channel: 'email',
      sendAttemptId: attempt.id,
      emailMessageId: message.id,
      requestId: ctx.requestId ?? null,
      now,
    })

    // Post-send transition on the matched attempt: accepted/delivered ->
    // replied (state-conditional, so terminal/failed rows are untouched).
    await em.nativeUpdate(
      GtmSendAttempt,
      {
        id: attempt.id,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        state: { $in: ['accepted', 'delivered'] },
      },
      { state: 'replied', repliedAt: now, updatedAt: now },
    )

    // Classification runs after the stop committed (section 9); an
    // unsubscribe classification suppresses in its own transaction.
    await classifyReply(
      em,
      ctx,
      { replyId: reply.id },
      { classifier: input.classifier ?? keywordClassifier, clock: input.clock },
    )

    matched.push({
      reply,
      matchedBy,
      attemptId: attempt.id,
      enrollmentId: enrollment.id,
      emailMessageId: message.id,
    })
  }

  return { scanned: messages.length, matched }
}

async function fallbackMatch(
  em: ExecutionEm,
  ctx: GtmCtx,
  message: EmailMessage,
): Promise<GtmSendAttempt | null> {
  const address = message.fromAddress.trim().toLowerCase()
  if (!address) return null
  const points = (
    await em.find(GtmContactPoint, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      channel: 'email',
      verificationState: 'verified',
      deletedAt: null,
    })
  ).filter((point) => point.value.trim().toLowerCase() === address)
  if (points.length === 0) return null
  const candidateIds = [...new Set(points.map((point) => point.candidateId))]
  const enrollments = (
    await em.find(GtmEnrollment, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      candidateId: { $in: candidateIds },
      deletedAt: null,
    })
  ).filter((row) => row.status === 'active')
  if (enrollments.length === 0) return null
  const enrollmentIds = enrollments.map((row) => row.id)
  const attempts = (
    await em.find(GtmSendAttempt, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      enrollmentId: { $in: enrollmentIds },
      state: { $in: PROVIDER_CONTACTED_STATES },
      deletedAt: null,
    })
  ).filter((row) => row.mailboxConnectionId === message.accountId)
  if (attempts.length === 0) return null
  attempts.sort(
    (a, b) =>
      (b.sentAt?.getTime() ?? b.updatedAt?.getTime() ?? 0) -
      (a.sentAt?.getTime() ?? a.updatedAt?.getTime() ?? 0),
  )
  return attempts[0]
}

// -----------------------------------------------------------------------
// User-recorded social replies (section 9: identical transaction path)
// -----------------------------------------------------------------------

export type RecordSocialReplyResult = {
  reply: GtmReply
  alreadyRecorded: boolean
}

export async function recordSocialReply(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: { enrollmentId: string; stepId: string; note?: string | null },
  deps: { clock?: Clock } = {},
): Promise<RecordSocialReplyResult> {
  const now = deps.clock?.now() ?? new Date()
  const enrollment = await em.findOne(GtmEnrollment, {
    id: input.enrollmentId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!enrollment) throw new GtmExecutionError('enrollment_not_found', 'Enrollment not found')
  const step = await em.findOne(GtmStep, {
    id: input.stepId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!step) throw new GtmExecutionError('step_not_found', 'Step not found')
  if (step.mode !== 'manual_social') {
    throw new GtmExecutionError(
      'invalid_state',
      'Social replies can only be recorded on manual social steps',
    )
  }

  // Idempotent per (enrollment, step).
  const existing = await em.findOne(GtmReply, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    enrollmentId: enrollment.id,
    stepId: step.id,
  })
  if (existing) return { reply: existing, alreadyRecorded: true }

  const reply = await atomicStopWithReply(em, {
    enrollment,
    stopReason: 'social_reply',
    channel: step.channel === 'x' ? 'x' : 'linkedin',
    stepId: step.id,
    note: input.note ?? null,
    actorUserId: ctx.userId,
    requestId: ctx.requestId ?? null,
    now,
  })
  return { reply, alreadyRecorded: false }
}
