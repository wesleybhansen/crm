import type { Knex } from 'knex'
import crypto from 'crypto'
import { sendEmailForOrg } from '@/modules/email/lib/email-router'
import { EmailSenderService } from '@/modules/email/services/email-sender'
import { upsertInboxConversation } from '@/lib/inbox-conversation'

/**
 * Shared "send a drafted customer-service reply for the org" logic. Factored out
 * of customers/api/customer-service/drafts/[id]/approve so the interactive
 * Approve button and the recurring Customer Service engine (auto / hybrid modes)
 * send through ONE code path: resolve the org's sending connection, send via the
 * email router, record the outbound email_messages row, and keep the unified
 * inbox + contact timeline current.
 *
 * Org-scope is the caller's responsibility: pass the trusted orgId/tenantId from
 * server-side auth (approve) or from the org's own settings row (the cron). This
 * function never reads org from a client.
 */

export type SendReplyInput = {
  to: string
  toName?: string | null
  subject: string
  body: string
  contactId?: string | null
  // Optional id of the user who triggered the send (approve flow). Auto-send
  // from the cron leaves this null.
  sentByUserId?: string | null
}

export type SendReplyResult = {
  ok: boolean
  error?: string
  // HTTP-ish status hint so the approve route can preserve its prior codes.
  status?: number
  messageId?: string
  sentVia?: string
}

export async function sendReply(
  knex: Knex,
  orgId: string,
  tenantId: string,
  input: SendReplyInput,
): Promise<SendReplyResult> {
  const to = (input.to || '').trim()
  const subject = input.subject || 'Re: your message'
  const bodyText = input.body || ''
  const contactId = input.contactId || null

  if (!to || !bodyText) {
    return { ok: false, error: 'Draft is missing a recipient or body', status: 400 }
  }

  // Resolve a sending user: owner of the org's primary/first active email
  // connection. sendEmailForOrg routes through that user's provider.
  const connection = await knex('email_connections')
    .where('organization_id', orgId)
    .where('is_active', true)
    .orderBy('is_primary', 'desc')
    .first()

  if (!connection) {
    return {
      ok: false,
      error: 'No email account connected. Connect Gmail, Outlook, or an ESP in Settings.',
      status: 400,
    }
  }

  const baseUrl = process.env.APP_URL || 'http://localhost:3000'
  const sender = new EmailSenderService()
  const trackingId = crypto.randomUUID()
  const bodyHtml = bodyText.replace(/\n/g, '<br>')

  let trackedHtml = sender.injectTrackingPixel(bodyHtml, trackingId, baseUrl)
  trackedHtml = sender.wrapLinksForTracking(trackedHtml, trackingId, baseUrl)
  if (contactId) trackedHtml = sender.injectUnsubscribeLink(trackedHtml, contactId, baseUrl)

  const routerResult = await sendEmailForOrg(knex, orgId, tenantId, connection.user_id, {
    to,
    subject,
    htmlBody: trackedHtml,
    textBody: bodyText,
    contactId: contactId || undefined,
  })

  if (!routerResult.ok) {
    return { ok: false, error: routerResult.error || 'Failed to send email', status: 502 }
  }

  const now = new Date()
  const messageId = crypto.randomUUID()
  await knex('email_messages').insert({
    id: messageId,
    tenant_id: tenantId,
    organization_id: orgId,
    direction: 'outbound',
    from_address: routerResult.fromAddress || '',
    to_address: to,
    subject,
    body_html: bodyHtml,
    body_text: bodyText,
    contact_id: contactId || null,
    status: 'sent',
    tracking_id: trackingId,
    metadata: JSON.stringify({ providerId: routerResult.messageId, provider: routerResult.sentVia, source: 'customer_service' }),
    created_at: now,
    sent_at: now,
  })

  // Keep the unified inbox current + log to the contact timeline.
  if (contactId) {
    await upsertInboxConversation(knex, orgId, tenantId, {
      contactId,
      channel: 'email',
      preview: bodyText,
      direction: 'outbound',
      avatarEmail: to,
    })
    try {
      const { logTimelineEvent } = await import('@/lib/timeline')
      await logTimelineEvent(knex, {
        tenantId,
        organizationId: orgId,
        contactId,
        eventType: 'email_sent',
        title: `Email sent: ${subject}`,
        metadata: { to, sentVia: routerResult.sentVia, source: 'customer_service' },
      })
    } catch {}
  }

  return { ok: true, messageId: routerResult.messageId, sentVia: routerResult.sentVia }
}
