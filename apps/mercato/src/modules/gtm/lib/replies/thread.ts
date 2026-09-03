import type { GtmCtx } from '../campaign/build'
import type { ExecutionEm } from '../execute/schedule'
import { GtmExecutionError } from '../execute/schedule'
import {
  GtmContactPoint,
  GtmEnrollment,
  GtmRenderedMessage,
  GtmReply,
  GtmSendAttempt,
} from '../../data/entities'
import { EmailConnection, EmailMessage } from '../../../email/data/schema'
import { sanitizeInboundHtml } from './text'

/*
 * Full correlated conversation for one reply (SPEC-066 section 9, inbox
 * completeness). The thread combines two durable sources, org+tenant scoped:
 *
 *   - OUTBOUND: the enrollment's gtm_send_attempts that actually left our
 *     system (provider_started and later, or with a sent_at). Content comes
 *     from the frozen gtm_rendered_messages row; the sender is the mailbox
 *     connection's address, the recipient is the enrollment's verified
 *     contact point. One-off reply sends (idempotency key `reply:{id}:1`)
 *     carry their content on the GtmReply they answer, not a rendered row.
 *   - INBOUND: email_messages linked to the enrollment through the GtmReply
 *     rows (email_message_id), PLUS any inbound message whose thread_id
 *     matches an outbound rfc_message_id (the correlate.ts linkage), so a
 *     reply that has not yet been turned into a GtmReply still shows. Social
 *     replies (no email) surface from the reply note.
 *
 * Chronological ascending by the message instant. A foreign or missing reply
 * raises reply_not_found (the route returns an opaque 404).
 */

const OUTBOUND_CONTACTED = [
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

export type ThreadMessage = {
  id: string
  kind: 'outbound' | 'inbound'
  direction: string
  channel: string
  subject: string | null
  from: string | null
  to: string | null
  body_text: string | null
  body_html: string | null
  at: Date | null
  state: string | null
  rfc_message_id: string | null
  source: 'send_attempt' | 'email_message' | 'reply_note'
}

export type ThreadResult = {
  reply: GtmReply
  enrollment: GtmEnrollment
  messages: ThreadMessage[]
}

async function verifiedEmail(
  em: ExecutionEm,
  ctx: GtmCtx,
  candidateId: string,
): Promise<string | null> {
  const points = await em.find(GtmContactPoint, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    candidateId,
    channel: 'email',
    verificationState: 'verified',
    deletedAt: null,
  })
  return points[0]?.value?.trim().toLowerCase() ?? null
}

export async function buildThread(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: { replyId: string },
): Promise<ThreadResult> {
  const reply = await em.findOne(GtmReply, {
    id: input.replyId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!reply) throw new GtmExecutionError('reply_not_found', 'Reply not found')

  const enrollment = await em.findOne(GtmEnrollment, {
    id: reply.enrollmentId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  // Opaque to the caller: a reply whose enrollment we cannot see is a 404.
  if (!enrollment) throw new GtmExecutionError('reply_not_found', 'Reply not found')

  const recipient = await verifiedEmail(em, ctx, enrollment.candidateId)

  // -- Outbound: the enrollment's send attempts that reached the provider. --
  const attempts = (
    await em.find(GtmSendAttempt, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      enrollmentId: enrollment.id,
      deletedAt: null,
    })
  ).filter((row) => OUTBOUND_CONTACTED.includes(row.state) || row.sentAt != null)

  const renderedIds = [
    ...new Set(
      attempts
        .map((attempt) => attempt.renderedMessageId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ]
  const rendered = renderedIds.length
    ? await em.find(GtmRenderedMessage, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        id: { $in: renderedIds },
        deletedAt: null,
      })
    : []
  const renderedById = new Map(rendered.map((row) => [row.id, row]))

  const connectionIds = [
    ...new Set(
      attempts
        .map((attempt) => attempt.mailboxConnectionId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ]
  const connections = connectionIds.length
    ? await em.find(EmailConnection, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        id: { $in: connectionIds },
      })
    : []
  const connectionById = new Map(connections.map((row) => [row.id, row]))

  const messages: ThreadMessage[] = []
  for (const attempt of attempts) {
    const renderedRow = attempt.renderedMessageId
      ? renderedById.get(attempt.renderedMessageId)
      : undefined
    const connection = attempt.mailboxConnectionId
      ? connectionById.get(attempt.mailboxConnectionId)
      : undefined
    let subject = renderedRow?.subject ?? null
    let bodyText = renderedRow?.bodyText ?? null
    let bodyHtml = renderedRow?.bodyHtml ?? null
    // A one-off reply send stores its content on the GtmReply it answers.
    if (typeof attempt.idempotencyKey === 'string' && attempt.idempotencyKey.startsWith('reply:')) {
      const answeredId = attempt.idempotencyKey.split(':')[1]
      const answered = answeredId
        ? await em.findOne(GtmReply, {
            id: answeredId,
            organizationId: ctx.organizationId,
            tenantId: ctx.tenantId,
          })
        : null
      const draft = (answered?.draftResponse ?? {}) as Record<string, unknown>
      if (typeof draft.subject === 'string' && draft.subject) subject = draft.subject
      if (typeof draft.body === 'string') {
        bodyText = draft.body
        bodyHtml = null
      }
    }
    messages.push({
      id: attempt.id,
      kind: 'outbound',
      direction: 'outbound',
      channel: 'email',
      subject,
      from: connection?.emailAddress ?? null,
      to: recipient,
      body_text: bodyText,
      body_html: bodyHtml,
      at: attempt.sentAt ?? attempt.scheduledFor ?? attempt.createdAt ?? null,
      state: attempt.state,
      rfc_message_id: attempt.rfcMessageId ?? null,
      source: 'send_attempt',
    })
  }

  // -- Inbound: email_messages linked to this enrollment's replies, plus any
  //    inbound message threaded onto one of our outbound rfc_message_ids. --
  const enrollmentReplies = await em.find(GtmReply, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    enrollmentId: enrollment.id,
    deletedAt: null,
  })
  const emailIds = new Set<string>()
  for (const row of enrollmentReplies) {
    if (row.emailMessageId) emailIds.add(row.emailMessageId)
  }

  const outboundRfc = new Set(
    attempts
      .map((a) => a.rfcMessageId)
      .filter((v): v is string => !!v)
      .map(normalizeMessageId),
  )
  if (outboundRfc.size > 0) {
    const inbound = await em.find(EmailMessage, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      direction: 'inbound',
      deletedAt: null,
    })
    for (const message of inbound) {
      if (message.threadId && outboundRfc.has(normalizeMessageId(message.threadId))) {
        emailIds.add(message.id)
      }
    }
  }

  for (const emailId of emailIds) {
    const message = await em.findOne(EmailMessage, {
      id: emailId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
    })
    if (!message) continue
    messages.push({
      id: message.id,
      kind: 'inbound',
      direction: 'inbound',
      channel: 'email',
      subject: message.subject ?? null,
      from: message.fromAddress ?? null,
      to: message.toAddress ?? null,
      body_text: message.bodyText ?? null,
      // Inbound HTML is sender-controlled: active content, event handlers
      // and javascript: URLs are stripped before it leaves the server (L10).
      body_html: sanitizeInboundHtml(message.bodyHtml),
      at: message.createdAt ?? null,
      state: null,
      rfc_message_id: message.threadId ?? null,
      source: 'email_message',
    })
  }

  // Social (non-email) replies surface from their note.
  for (const row of enrollmentReplies) {
    if (row.emailMessageId || row.channel === 'email') continue
    const note = (row.draftResponse as Record<string, unknown> | null)?.note
    messages.push({
      id: row.id,
      kind: 'inbound',
      direction: 'inbound',
      channel: row.channel,
      subject: null,
      from: null,
      to: null,
      body_text: typeof note === 'string' ? note : null,
      body_html: null,
      at: row.createdAt ?? null,
      state: null,
      rfc_message_id: null,
      source: 'reply_note',
    })
  }

  messages.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0))
  return { reply, enrollment, messages }
}
