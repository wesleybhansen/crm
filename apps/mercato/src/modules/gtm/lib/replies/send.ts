import crypto from 'crypto'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import type { GtmCtx } from '../campaign/build'
import type { Clock, ExecutionEm } from '../execute/schedule'
import { GtmExecutionError } from '../execute/schedule'
import { hashAddress } from '../campaign/exclusions'
import { buildUnsubscribeUrl } from '../unsubscribe'
import type { GtmSendTransport } from '../execute/transport'
import { GtmSendTimeoutError } from '../execute/transport'
import {
  GtmAuditEvent,
  GtmContactPoint,
  GtmEnrollment,
  GtmReply,
  GtmSendAttempt,
  GtmSuppression,
} from '../../data/entities'
import { EmailConnection, EmailMessage } from '../../../email/data/schema'

/*
 * Approved-draft SEND path for a one-off inbox reply (SPEC-066 sections 6, 8,
 * 9 - the send machine, reused for a single reply).
 *
 * Approving a reply draft mints a NEW durable gtm_send_attempts row and drives
 * it through the SAME state discipline as a campaign send:
 *
 *   approved -> claimed (fence + claim token) -> provider_started (rfc_message_id
 *   DURABLY persisted BEFORE any transport contact) -> accepted, with the RFC
 *   8058 one-click List-Unsubscribe headers on the wire and every write fenced
 *   on (id, claim_token, fence).
 *
 * Differences from a campaign send (send.ts), all deliberate:
 *   - The pre-send recheck is the reply-appropriate subset: suppression on the
 *     recipient + sender-connection health. It does NOT re-check the enrollment
 *     as active, the campaign/version, or play eligibility: a reply is a single
 *     human-approved message to a conversation that has already stopped, and it
 *     must NOT reopen the stopped enrollment.
 *   - Content comes from the reply draft (draft_response.subject/body), not a
 *     frozen rendered message. The row's rendered_message_id / campaign_version
 *     / step / mailbox are borrowed from the original outbound attempt purely to
 *     satisfy the non-null columns and to reuse the same thread mailbox.
 *   - Idempotency key `reply:{replyId}:1` under (organization_id,
 *     idempotency_key): re-approve / re-send returns the existing attempt and
 *     never sends twice.
 *
 * Execution kill switch: with GTM_EXECUTION_ENABLED off (deps.executionEnabled
 * false, or no transport injected) the approval is a DRY RUN. The draft is
 * flipped to 'approved' but NO attempt is created and NO transport is touched;
 * enabling execution and re-approving performs the real send.
 */

const IN_FLIGHT_OR_SETTLED = [
  'claimed',
  'provider_started',
  'accepted',
  'delivered',
  'bounced',
  'complained',
  'replied',
  'ambiguous',
  'failed',
]
const CONTACTED = [
  'provider_started',
  'accepted',
  'delivered',
  'bounced',
  'complained',
  'replied',
  'ambiguous',
]

const REPLY_LEASE_MINUTES = 10

export type ReplySendOutcome =
  | 'accepted'
  | 'failed'
  | 'ambiguous'
  | 'fenced'
  | 'dry_run'
  | 'already_sent'

export type ApproveSendResult = {
  reply: GtmReply
  attempt: GtmSendAttempt | null
  dryRun: boolean
  alreadySent: boolean
  outcome: ReplySendOutcome
}

export type ApproveSendDeps = {
  executionEnabled: boolean
  transport?: GtmSendTransport
  clock?: Clock
}

export function buildReplyIdempotencyKey(replyId: string, attemptNo = 1): string {
  return `reply:${replyId}:${attemptNo}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function coreHtml(bodyText: string): string {
  return escapeHtml(bodyText).replace(/\n/g, '<br/>')
}

async function loadReply(em: ExecutionEm, ctx: GtmCtx, replyId: string): Promise<GtmReply> {
  const reply = await em.findOne(GtmReply, {
    id: replyId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!reply) throw new GtmExecutionError('reply_not_found', 'Reply not found')
  return reply
}

// Org + global email suppression check (mirrors send.ts findSuppression).
async function findSuppression(
  em: ExecutionEm,
  organizationId: string,
  addressHash: string,
  now: Date,
): Promise<GtmSuppression | null> {
  const rows = [
    ...(await em.find(GtmSuppression, { organizationId, addressHash, deletedAt: null })),
    ...(await em.find(GtmSuppression, { scope: 'global', addressHash, deletedAt: null })),
  ]
  for (const row of rows) {
    if (row.channel !== 'email' && row.channel !== 'all') continue
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) continue
    return row
  }
  return null
}

type SendContext = {
  stepId: string
  campaignVersionId: string
  renderedMessageId: string
  mailboxConnectionId: string
}

// The FKs a reply attempt borrows: the original correlated outbound attempt,
// else the enrollment's most recent non-reply provider-contacted attempt.
async function resolveSendContext(
  em: ExecutionEm,
  ctx: GtmCtx,
  reply: GtmReply,
  enrollment: GtmEnrollment,
): Promise<SendContext | null> {
  let original: GtmSendAttempt | null = reply.sendAttemptId
    ? await em.findOne(GtmSendAttempt, {
        id: reply.sendAttemptId,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
      })
    : null
  if (!original) {
    const attempts = (
      await em.find(GtmSendAttempt, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        enrollmentId: enrollment.id,
        deletedAt: null,
      })
    )
      .filter((row) => !(typeof row.idempotencyKey === 'string' && row.idempotencyKey.startsWith('reply:')))
      .filter((row) => !!row.renderedMessageId)
      .sort(
        (a, b) =>
          (b.sentAt?.getTime() ?? b.createdAt?.getTime() ?? 0) -
          (a.sentAt?.getTime() ?? a.createdAt?.getTime() ?? 0),
      )
    original = attempts[0] ?? null
  }
  if (!original?.renderedMessageId || !original.mailboxConnectionId) return null
  return {
    stepId: original.stepId,
    campaignVersionId: original.campaignVersionId,
    renderedMessageId: original.renderedMessageId,
    mailboxConnectionId: original.mailboxConnectionId,
  }
}

// Who the reply is addressed to: the inbound message's from address, else the
// enrollment's verified email contact point (mirrors classify.resolveReplyAddress).
async function resolveRecipient(
  em: ExecutionEm,
  ctx: GtmCtx,
  reply: GtmReply,
  enrollment: GtmEnrollment,
): Promise<string | null> {
  if (reply.emailMessageId) {
    const message = await em.findOne(EmailMessage, {
      id: reply.emailMessageId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
    })
    if (message?.fromAddress) return message.fromAddress.trim().toLowerCase()
  }
  const points = await em.find(GtmContactPoint, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    candidateId: enrollment.candidateId,
    channel: 'email',
    verificationState: 'verified',
    deletedAt: null,
  })
  return points[0]?.value?.trim().toLowerCase() ?? null
}

async function auditApprove(em: ExecutionEm, ctx: GtmCtx, reply: GtmReply): Promise<void> {
  await em.transactional(async (tem) => {
    reply.draftStatus = 'approved'
    tem.persist(reply)
    tem.persist(
      tem.create(GtmAuditEvent, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        actor: 'user_id',
        actorUserId: ctx.userId,
        action: 'gtm.reply.draft_approved',
        objectType: 'gtm_reply',
        objectId: reply.id,
        requestId: ctx.requestId ?? null,
        metadata: null,
      }),
    )
    await tem.flush()
  })
}

async function markSent(
  em: ExecutionEm,
  ctx: GtmCtx,
  reply: GtmReply,
  attempt: GtmSendAttempt,
): Promise<void> {
  await em.transactional(async (tem) => {
    reply.draftStatus = 'sent'
    tem.persist(reply)
    tem.persist(
      tem.create(GtmAuditEvent, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        actor: 'user_id',
        actorUserId: ctx.userId,
        action: 'gtm.reply.sent',
        objectType: 'gtm_reply',
        objectId: reply.id,
        requestId: ctx.requestId ?? null,
        metadata: { send_attempt_id: attempt.id },
      }),
    )
    await tem.flush()
  })
}

// Mirrors executeClaimedAttempt for a one-off reply: fenced writes, rfc minted
// and provider_started persisted before transport, reply-appropriate recheck.
async function executeReplyAttempt(
  em: ExecutionEm,
  ctx: GtmCtx,
  attempt: GtmSendAttempt,
  opts: {
    transport: GtmSendTransport
    enrollment: GtmEnrollment
    recipient: string
    subject: string
    body: string
    clock?: Clock
  },
): Promise<ReplySendOutcome> {
  const claimToken = attempt.claimToken
  const fence = attempt.fence
  const attemptId = attempt.id
  if (attempt.state !== 'claimed' || !claimToken) {
    throw new GtmExecutionError(
      'attempt_not_claimed',
      `Reply attempt ${attemptId} is not held under a claim (state '${attempt.state}')`,
    )
  }
  const now = () => opts.clock?.now() ?? new Date()
  const fencedUpdate = (
    extraWhere: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<number> =>
    em.nativeUpdate(
      GtmSendAttempt,
      { id: attemptId, claimToken, fence, ...extraWhere },
      { ...data, updatedAt: now() },
    )
  const fail = async (reason: string): Promise<ReplySendOutcome> => {
    const n = await fencedUpdate({}, { state: 'failed', failureReason: reason, failedAt: now() })
    return n === 1 ? 'failed' : 'fenced'
  }

  if (attempt.organizationId !== ctx.organizationId || attempt.tenantId !== ctx.tenantId) {
    return fail('org_tenant_mismatch')
  }

  // Sender connection exists, belongs to this org/tenant, and is active.
  const connection = await em.findOne(EmailConnection, {
    id: attempt.mailboxConnectionId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!connection || !connection.isActive) return fail('sender_inactive')

  // Suppression recheck on the recipient at claim time.
  const addressHash = hashAddress(opts.recipient)
  const suppressed = await findSuppression(em, ctx.organizationId, addressHash, now())
  if (suppressed) return fail('suppressed')

  // Mint rfc_message_id + go provider_started DURABLY before transport contact.
  const senderDomain = (connection.emailAddress || '').split('@')[1] || 'invalid.local'
  const rfcMessageId = `<${crypto.randomUUID()}@${senderDomain}>`
  const started = await fencedUpdate({ state: 'claimed' }, { state: 'provider_started', rfcMessageId })
  if (started !== 1) return 'fenced'
  attempt.rfcMessageId = rfcMessageId

  // RFC 8058 one-click headers on the reply send too (section 8).
  const unsubscribeUrl = buildUnsubscribeUrl(opts.enrollment.id, addressHash)
  const headers: Record<string, string> = {
    'List-Unsubscribe': unsubscribeUrl
      ? `<mailto:${connection.emailAddress}?subject=unsubscribe>, <${unsubscribeUrl}>`
      : `<mailto:${connection.emailAddress}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }

  try {
    const result = await opts.transport.send({
      connection,
      from: connection.emailAddress,
      to: opts.recipient,
      subject: opts.subject,
      html: coreHtml(opts.body),
      text: opts.body,
      headers,
      messageId: rfcMessageId,
    })
    const sentAt = now()
    const n = await fencedUpdate(
      { state: 'provider_started' },
      {
        state: 'accepted',
        providerMessageId: result.providerMessageId ?? null,
        providerReceipt: result.receipt ?? null,
        sentAt,
        acceptedAt: sentAt,
      },
    )
    return n === 1 ? 'accepted' : 'fenced'
  } catch (err) {
    if (err instanceof GtmSendTimeoutError || (err as Error)?.name === 'GtmSendTimeoutError') {
      const reason = `transport_timeout: ${(err as Error).message}`
      const n = await fencedUpdate(
        { state: 'provider_started' },
        { state: 'ambiguous', ambiguousAt: now(), failureReason: reason },
      )
      return n === 1 ? 'ambiguous' : 'fenced'
    }
    const reason = `transport_error: ${(err as Error)?.message ?? 'unknown'}`
    const n = await fencedUpdate(
      { state: 'provider_started' },
      { state: 'failed', failureReason: reason, failedAt: now() },
    )
    return n === 1 ? 'failed' : 'fenced'
  }
}

export async function approveAndSendReply(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: { replyId: string },
  deps: ApproveSendDeps,
): Promise<ApproveSendResult> {
  const reply = await loadReply(em, ctx, input.replyId)

  // A reply send is an email send: social replies have no mailbox thread.
  if (reply.channel !== 'email') {
    throw new GtmExecutionError('invalid_state', 'Only email replies can be sent from the inbox')
  }
  const draft = (reply.draftResponse ?? {}) as Record<string, unknown>
  const body = typeof draft.body === 'string' ? draft.body.trim() : ''
  if (reply.draftStatus === 'none' || !body) {
    throw new GtmExecutionError('invalid_state', 'Draft a response body before approving')
  }

  const key = buildReplyIdempotencyKey(reply.id)

  // Idempotent: already sent -> return the durable attempt unchanged.
  if (reply.draftStatus === 'sent') {
    const existing = await em.findOne(GtmSendAttempt, {
      organizationId: ctx.organizationId,
      idempotencyKey: key,
    })
    return { reply, attempt: existing, dryRun: false, alreadySent: true, outcome: 'already_sent' }
  }

  // Flip 'drafted' -> 'approved' with an audit (idempotent if already approved).
  if (reply.draftStatus === 'drafted') {
    await auditApprove(em, ctx, reply)
  }

  // Execution double-lock: no transport reachable unless execution is enabled.
  if (!deps.executionEnabled || !deps.transport) {
    return { reply, attempt: null, dryRun: true, alreadySent: false, outcome: 'dry_run' }
  }
  const transport = deps.transport

  const enrollment = await em.findOne(GtmEnrollment, {
    id: reply.enrollmentId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!enrollment) throw new GtmExecutionError('enrollment_not_found', 'Enrollment not found')

  const sendContext = await resolveSendContext(em, ctx, reply, enrollment)
  if (!sendContext) {
    throw new GtmExecutionError('invalid_state', 'No outbound context to send this reply from')
  }
  const recipient = await resolveRecipient(em, ctx, reply, enrollment)
  if (!recipient) {
    throw new GtmExecutionError('invalid_state', 'No recipient address for this reply')
  }
  const subject =
    typeof draft.subject === 'string' && draft.subject.trim() ? draft.subject.trim() : 'Re: your reply'

  const now = deps.clock?.now() ?? new Date()

  // Create-or-get the durable reply attempt (idempotent on the unique key).
  let attempt = await em.findOne(GtmSendAttempt, {
    organizationId: ctx.organizationId,
    idempotencyKey: key,
  })
  if (!attempt) {
    try {
      attempt = await em.transactional(async (tem) => {
        const created = tem.create(GtmSendAttempt, {
          id: crypto.randomUUID(),
          organizationId: ctx.organizationId,
          tenantId: ctx.tenantId,
          enrollmentId: enrollment.id,
          stepId: sendContext.stepId,
          renderedMessageId: sendContext.renderedMessageId,
          campaignVersionId: sendContext.campaignVersionId,
          mailboxConnectionId: sendContext.mailboxConnectionId,
          state: 'approved',
          claimToken: null,
          claimExpiresAt: null,
          fence: 0,
          attemptNo: 1,
          idempotencyKey: key,
          rfcMessageId: null,
          scheduledFor: now,
        })
        tem.persist(created)
        await tem.flush()
        return created
      })
    } catch (err) {
      if (!(err instanceof UniqueConstraintViolationException)) throw err
      attempt = await em.findOne(GtmSendAttempt, {
        organizationId: ctx.organizationId,
        idempotencyKey: key,
      })
    }
  }
  if (!attempt) throw new GtmExecutionError('invalid_state', 'Could not materialize the reply attempt')

  // Idempotent: an attempt already in flight or settled is never re-sent.
  if (IN_FLIGHT_OR_SETTLED.includes(attempt.state)) {
    const contacted = CONTACTED.includes(attempt.state)
    if (contacted && reply.draftStatus !== 'sent') await markSent(em, ctx, reply, attempt)
    return {
      reply,
      attempt,
      dryRun: false,
      alreadySent: contacted,
      outcome: contacted ? 'already_sent' : attempt.state === 'failed' ? 'failed' : 'fenced',
    }
  }

  // Claim: fenced CAS approved -> claimed (mirrors claim.ts).
  const claimToken = crypto.randomUUID()
  const observedFence = attempt.fence
  const claimed = await em.nativeUpdate(
    GtmSendAttempt,
    {
      id: attempt.id,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      state: 'approved',
      fence: observedFence,
    },
    {
      state: 'claimed',
      claimToken,
      claimExpiresAt: new Date(now.getTime() + REPLY_LEASE_MINUTES * 60 * 1000),
      fence: observedFence + 1,
      updatedAt: now,
    },
  )
  const claimedAttempt = await em.findOne(GtmSendAttempt, {
    id: attempt.id,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
  })
  if (claimed !== 1 || !claimedAttempt) {
    return { reply, attempt: claimedAttempt ?? attempt, dryRun: false, alreadySent: false, outcome: 'fenced' }
  }

  const outcome = await executeReplyAttempt(em, ctx, claimedAttempt, {
    transport,
    enrollment,
    recipient,
    subject,
    body,
    clock: deps.clock,
  })
  if (outcome === 'accepted') await markSent(em, ctx, reply, claimedAttempt)
  return { reply, attempt: claimedAttempt, dryRun: false, alreadySent: false, outcome }
}
