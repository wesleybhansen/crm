import type { GtmEnrollment, GtmReply } from '../../data/entities'
import type { EmailMessage } from '../../../email/data/schema'

/*
 * Inbox search + per-reply inbound summary (SPEC-066 section 9; inbox
 * completeness). Pure functions over rows the route has ALREADY loaded
 * org+tenant scoped, so search can never widen the tenant boundary: it only
 * narrows the self-scoped set the caller passes in. The match is a
 * case-insensitive substring over the reply fields plus the linked
 * counterparty email (from / subject / body).
 */

export type ReplyInboundSummary = {
  from: string | null
  subject: string | null
  snippet: string | null
  received_at: Date | null
}

export function replyHaystack(
  reply: GtmReply,
  enrollment: GtmEnrollment | null | undefined,
  message: EmailMessage | null | undefined,
): string {
  const draft = (reply.draftResponse ?? {}) as Record<string, unknown>
  return [
    reply.channel,
    reply.classification,
    reply.classificationSource,
    reply.draftStatus,
    enrollment?.campaignId,
    enrollment?.stopReason,
    typeof draft.subject === 'string' ? draft.subject : null,
    typeof draft.body === 'string' ? draft.body : null,
    typeof draft.note === 'string' ? draft.note : null,
    message?.fromAddress,
    message?.subject,
    message?.bodyText,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase()
}

export function replyMatchesQuery(
  reply: GtmReply,
  enrollment: GtmEnrollment | null | undefined,
  message: EmailMessage | null | undefined,
  query: string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return replyHaystack(reply, enrollment, message).includes(q)
}

export function inboundSummary(
  reply: GtmReply,
  message: EmailMessage | null | undefined,
): ReplyInboundSummary | null {
  const draft = (reply.draftResponse ?? {}) as Record<string, unknown>
  const note = typeof draft.note === 'string' ? draft.note : null
  const snippetSource = message?.bodyText || note || ''
  if (!message && !note) return null
  return {
    from: message?.fromAddress ?? null,
    subject: message?.subject ?? null,
    snippet: snippetSource ? snippetSource.slice(0, 160) : null,
    received_at: message?.createdAt ?? reply.createdAt ?? null,
  }
}
