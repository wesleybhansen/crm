/**
 * Email Router Service
 * Routes outbound email through the user's connected email provider (Gmail, Outlook, SMTP, etc.)
 * Falls back to error if no connection is configured.
 */

import type { Knex } from 'knex'
import { openSecretForTenant } from '@open-mercato/shared/lib/encryption/secretColumns'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/aes'
import { sendViaGmail, getGmailToken } from './gmail-service'
import { sendViaOutlook, getOutlookToken } from './outlook-service'
import { sendViaESP } from './esp-service'
import {
  EMAIL_NOT_CONNECTED_CODE,
  OWN_MAILBOX_REQUIRED_MESSAGE,
  resolveSenderMailbox,
  senderMailboxRefusal,
  type EmailPurpose,
} from './routing-service'

import { EMAIL_NOT_SENT_NOT_CONNECTED } from './sending-readiness'
import { logTimelineEvent } from '../../../lib/timeline'

interface SendEmailParams {
  to: string
  cc?: string
  bcc?: string
  subject: string
  htmlBody: string
  textBody?: string
  contactId?: string
  /**
   * Pin the exact mailbox (an email_connections id that must belong to
   * `userId`). Used when the sender was resolved as an org-designated or
   * support mailbox rather than the user's own primary.
   */
  connectionId?: string
}

interface SendEmailResult {
  ok: boolean
  /** 'email_not_connected' when the org has no sending setup for the purpose. */
  code?: string
  messageId?: string
  sentVia?: string
  fromAddress?: string
  error?: string
}

/**
 * Strict decrypt at the send boundary (2026-09-25 review, LOW): read paths
 * return ciphertext (or the undecryptable placeholder) when a tenant key is
 * missing, which is right for a list but must never reach a recipient. Any
 * address, subject or body still carrying an envelope or the placeholder is
 * refused here, whatever path built it.
 */
const UNDECRYPTABLE_TEXT = 'This record could not be decrypted. Contact support.'
export function undecryptedSendPart(parts: { to?: unknown; subject?: unknown; body?: unknown }): string | null {
  for (const [name, value] of Object.entries(parts)) {
    if (typeof value !== 'string' || !value) continue
    if (value.includes(UNDECRYPTABLE_TEXT)) return name
    const trimmed = value.trim()
    if (isEncryptedEnvelope(trimmed)) return name
  }
  return null
}
const UNDECRYPTED_SEND_ERROR = 'Not sent: part of this message could not be decrypted. Contact support.'

interface BulkSendResult {
  ok: boolean
  total: number
  sent: number
  failed: number
  results: Array<{ to: string; ok: boolean; messageId?: string; error?: string }>
  sentVia: string
  warning?: string
}

/**
 * Send an email on behalf of a user, using their connected email provider.
 * Checks email_connections for the user's primary or first active connection.
 */
export async function sendEmailForOrg(
  knex: Knex,
  orgId: string,
  tenantId: string,
  userId: string,
  params: SendEmailParams,
): Promise<SendEmailResult> {
  const { to, cc, bcc, subject, htmlBody, textBody, contactId, connectionId } = params
  if (undecryptedSendPart({ to, subject, body: htmlBody })) {
    return { ok: false, code: 'undecryptable', error: UNDECRYPTED_SEND_ERROR }
  }

  // Find user's email connection — the pinned one, else primary, then any active
  const connectionQuery = knex('email_connections')
    .where('organization_id', orgId)
    .where('user_id', userId)
    .where('is_active', true)
  if (connectionId) connectionQuery.where('id', connectionId)
  const connection = await connectionQuery.orderBy('is_primary', 'desc').first()

  console.log('[email-router] Looking up connection for orgId:', orgId, 'userId:', userId, 'found:', connection?.provider || 'NONE', 'active:', connection?.is_active)

  if (!connection) {
    return {
      ok: false,
      error: 'No email account connected. Connect Gmail or Outlook in Inbox > Connections.',
    }
  }

  // Get user's display name for the From header
  const appUser = await knex('users').where('id', userId).first().catch(() => null)
  const userDisplayName = appUser?.name || null

  try {
    switch (connection.provider) {
      case 'gmail': {
        let token
        try {
          token = await getGmailToken(knex, orgId, userId)
        } catch (gmailErr) {
          const msg = gmailErr instanceof Error ? gmailErr.message : 'Gmail token error'
          console.error('[email-router] Gmail token failed:', msg)
          return { ok: false, error: `Gmail error: ${msg}. Try reconnecting Gmail in Settings.` }
        }
        if (!token) {
          return { ok: false, error: 'Gmail token not available. Please reconnect Gmail in Settings.' }
        }

        const gmailFrom = userDisplayName ? `${userDisplayName} <${token.emailAddress}>` : token.emailAddress
        console.log('[email-router] Sending via Gmail from:', gmailFrom, 'to:', to)
        const result = await sendViaGmail(
          token.accessToken,
          gmailFrom,
          to,
          subject,
          htmlBody,
          textBody,
          cc,
          bcc,
        )

        if (contactId) {
          await trackEngagement(knex, orgId, tenantId, contactId)
        }

        return {
          ok: true,
          messageId: result.messageId,
          sentVia: 'gmail',
          fromAddress: token.emailAddress,
        }
      }

      case 'microsoft': {
        const token = await getOutlookToken(knex, orgId, userId)
        if (!token) {
          return { ok: false, error: 'Outlook token not available. Please reconnect Outlook in Settings.' }
        }

        const result = await sendViaOutlook(
          token.accessToken,
          token.emailAddress,
          to,
          subject,
          htmlBody,
          cc,
          bcc,
          userDisplayName || undefined,
        )

        if (contactId) {
          await trackEngagement(knex, orgId, tenantId, contactId)
        }

        return {
          ok: true,
          messageId: result.messageId,
          sentVia: 'microsoft',
          fromAddress: token.emailAddress,
        }
      }

      case 'smtp': {
        try {
          const smtpPass = await openSecretForTenant(null, connection.tenant_id ?? tenantId, connection.smtp_pass)
          if (connection.smtp_pass && !smtpPass) {
            return { ok: false, error: 'Mailbox password could not be decrypted. Reconnect the mailbox in Settings.' }
          }
          const nodemailer = await import('nodemailer')
          const transporter = nodemailer.createTransport({
            host: connection.smtp_host,
            port: connection.smtp_port || 587,
            secure: connection.smtp_port === 465,
            auth: {
              user: connection.smtp_user,
              pass: smtpPass ?? undefined,
            },
          })

          const smtpFrom = userDisplayName ? `${userDisplayName} <${connection.email_address}>` : connection.email_address
          const info = await transporter.sendMail({
            from: smtpFrom,
            to,
            cc: cc || undefined,
            bcc: bcc || undefined,
            subject,
            html: htmlBody,
            text: textBody,
          })

          if (contactId) {
            await trackEngagement(knex, orgId, tenantId, contactId)
          }

          return {
            ok: true,
            messageId: info.messageId,
            sentVia: 'smtp',
            fromAddress: connection.email_address,
          }
        } catch (smtpError) {
          const message = smtpError instanceof Error ? smtpError.message : 'SMTP send failed'
          return { ok: false, error: message }
        }
      }

      default:
        return { ok: false, error: `Unsupported email provider: ${connection.provider}` }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to send email'
    console.error('[email-router] Send failed:', message)
    return { ok: false, error: message }
  }
}

/**
 * Send bulk emails for an organization.
 * Prefers ESP (Resend/SendGrid/Mailgun/SES) for bulk sending.
 * Falls back to the user's personal email connection with a rate limit warning.
 */
export async function sendBulkEmailForOrg(
  knex: Knex,
  orgId: string,
  tenantId: string,
  from: string,
  recipients: string[],
  subject: string,
  htmlBody: string,
  /** Who is sending; null for a system send. Decides the mailbox fallback. */
  actingUserId: string | null = null,
): Promise<BulkSendResult> {
  if (undecryptedSendPart({ subject, body: htmlBody })) {
    return { ok: false, total: recipients.length, sent: 0, failed: recipients.length, sentVia: 'none',
      results: recipients.map((to) => ({ to, ok: false, error: UNDECRYPTED_SEND_ERROR })) }
  }
  const unreadable = recipients.filter((to) => undecryptedSendPart({ to }))
  if (unreadable.length) {
    console.error('[email-router] refused undecrypted recipients', { orgId, count: unreadable.length })
    recipients = recipients.filter((to) => !undecryptedSendPart({ to }))
  }
  // Check if org has an ESP connection
  const espConnection = await knex('esp_connections')
    .where('organization_id', orgId)
    .where('is_active', true)
    .first()

  if (espConnection) {
    // Use ESP for bulk sending
    const espApiKey = await openSecretForTenant(null, espConnection.tenant_id ?? tenantId, espConnection.api_key)
    const results: BulkSendResult['results'] = []
    let sent = 0
    let failed = 0

    for (const to of recipients) {
      try {
        const result = await sendViaESP(
          espConnection.provider,
          espApiKey || '',
          from,
          to,
          subject,
          htmlBody,
        )
        results.push({ to, ok: true, messageId: result.messageId })
        sent++
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Send failed'
        results.push({ to, ok: false, error })
        failed++
      }
    }

    return {
      ok: failed === 0,
      total: recipients.length,
      sent,
      failed,
      results,
      sentVia: `esp:${espConnection.provider}`,
    }
  }

  // No ESP: fall back to a mailbox this send may use: the acting user's own,
  // an org-designated marketing mailbox, or (system sends) the org's only
  // mailbox owner. Never a teammate's personal address.
  const picked = await resolveSenderMailbox(knex, orgId, actingUserId, { routingPurpose: 'marketing' })
  const connection = picked.connection

  if (!connection) {
    const error = senderMailboxRefusal(picked.connection === null ? picked.reason : 'no_mailbox')
    return {
      ok: false,
      total: recipients.length,
      sent: 0,
      failed: recipients.length,
      results: recipients.map(to => ({ to, ok: false, error })),
      sentVia: 'none',
      warning: error,
    }
  }

  const results: BulkSendResult['results'] = []
  let sent = 0
  let failed = 0

  for (const to of recipients) {
    try {
      const sendResult = await sendEmailForOrg(knex, orgId, tenantId, connection.user_id, {
        to,
        subject,
        htmlBody,
        connectionId: connection.id,
      })

      if (sendResult.ok) {
        results.push({ to, ok: true, messageId: sendResult.messageId })
        sent++
      } else {
        results.push({ to, ok: false, error: sendResult.error })
        failed++
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Send failed'
      results.push({ to, ok: false, error })
      failed++
    }
  }

  return {
    ok: failed === 0,
    total: recipients.length,
    sent,
    failed,
    results,
    sentVia: connection.provider,
    warning: recipients.length > 50
      ? 'Sending bulk email via personal email account. Consider connecting an ESP (Resend, SendGrid, etc.) for better deliverability and higher rate limits.'
      : undefined,
  }
}

/**
 * Send an email routed by purpose (invoices, marketing, automations, transactional).
 * Uses the org's configured email routing, with intelligent fallbacks.
 * This is the preferred function for all non-inbox email sending.
 */
export async function sendEmailByPurpose(
  knex: Knex,
  orgId: string,
  tenantId: string,
  purpose: EmailPurpose,
  params: SendEmailParams & {
    fromName?: string
    /**
     * The user who triggered this send (clicked send, approved), or null for a
     * system send (sequences, automations, crons). With a user, a mailbox
     * fallback uses only that user's own mailbox; see resolveSenderMailbox.
     */
    actingUserId?: string | null
  },
): Promise<SendEmailResult> {
  const badPart = undecryptedSendPart({ to: params.to, subject: params.subject, body: params.htmlBody })
  if (badPart) {
    console.error('[email-router] refused an undecrypted send', { orgId, purpose, part: badPart })
    return { ok: false, code: 'undecryptable', error: UNDECRYPTED_SEND_ERROR }
  }
  const { getProviderForPurpose } = await import('./routing-service')
  const actingUserId = params.actingUserId ?? null
  const resolved = await getProviderForPurpose(knex, orgId, purpose, actingUserId)

  if (!resolved) {
    // Mailboxes exist but none this send may use: say so plainly rather than
    // "not connected", which would confuse a teammate whose colleague is.
    const picked = await resolveSenderMailbox(knex, orgId, actingUserId).catch(() => null)
    if (picked && picked.connection === null && picked.reason === 'no_own_mailbox') {
      if (params.contactId) {
        await logTimelineEvent(knex, {
          tenantId,
          organizationId: orgId,
          contactId: params.contactId,
          eventType: 'email_not_sent',
          title: `Email not sent: ${params.subject || '(no subject)'}`,
          description: `Not sent: ${OWN_MAILBOX_REQUIRED_MESSAGE}`,
          metadata: { purpose, reason: EMAIL_NOT_CONNECTED_CODE },
        }).catch(() => {})
      }
      return { ok: false, code: EMAIL_NOT_CONNECTED_CODE, error: OWN_MAILBOX_REQUIRED_MESSAGE }
    }
    // Never a fallback sender. Make the skip visible where the owner looks: the
    // contact's timeline, when the send was for a contact.
    if (params.contactId) {
      await logTimelineEvent(knex, {
        tenantId,
        organizationId: orgId,
        contactId: params.contactId,
        eventType: 'email_not_sent',
        title: `Email not sent: ${params.subject || '(no subject)'}`,
        description: EMAIL_NOT_SENT_NOT_CONNECTED,
        metadata: { purpose, reason: EMAIL_NOT_CONNECTED_CODE },
      }).catch(() => {})
    }
    return { ok: false, code: EMAIL_NOT_CONNECTED_CODE, error: EMAIL_NOT_SENT_NOT_CONNECTED }
  }

  const { to, cc, bcc, subject, htmlBody, textBody, contactId } = params
  const displayName = resolved.fromName || params.fromName || null
  const fromDisplay = displayName
    ? `${displayName} <${resolved.fromAddress}>`
    : resolved.fromAddress

  try {
    if (resolved.type === 'esp' && resolved.espConnection) {
      // Send via ESP (Resend, SendGrid, etc.)
      const result = await sendViaESP(
        resolved.espConnection.provider,
        resolved.espConnection.api_key,
        fromDisplay,
        to,
        subject,
        htmlBody,
      )

      if (contactId) await trackEngagement(knex, orgId, tenantId, contactId)

      return { ok: true, messageId: result.messageId, sentVia: `esp:${resolved.provider}`, fromAddress: resolved.fromAddress }
    }

    if (resolved.type === 'connection' && resolved.connection) {
      const conn = resolved.connection

      switch (conn.provider) {
        case 'gmail': {
          const token = await getGmailToken(knex, orgId, conn.user_id)
          if (!token) return { ok: false, error: 'Gmail token expired. Reconnect Gmail in Settings.' }
          const result = await sendViaGmail(token.accessToken, token.emailAddress, to, subject, htmlBody, textBody, cc, bcc)
          if (contactId) await trackEngagement(knex, orgId, tenantId, contactId)
          return { ok: true, messageId: result.messageId, sentVia: 'gmail', fromAddress: token.emailAddress }
        }
        case 'microsoft': {
          const token = await getOutlookToken(knex, orgId, conn.user_id)
          if (!token) return { ok: false, error: 'Outlook token expired. Reconnect Outlook in Settings.' }
          const result = await sendViaOutlook(token.accessToken, token.emailAddress, to, subject, htmlBody, cc, bcc)
          if (contactId) await trackEngagement(knex, orgId, tenantId, contactId)
          return { ok: true, messageId: result.messageId, sentVia: 'microsoft', fromAddress: token.emailAddress }
        }
        case 'smtp': {
          const nodemailer = await import('nodemailer')
          const transporter = nodemailer.createTransport({
            host: conn.smtp_host, port: conn.smtp_port || 587,
            secure: conn.smtp_port === 465,
            auth: { user: conn.smtp_user, pass: conn.smtp_pass },
            // conn came from getProviderForPurpose, which already opened the seal.
          })
          const info = await transporter.sendMail({
            from: fromDisplay, to, cc: cc || undefined, bcc: bcc || undefined,
            subject, html: htmlBody, text: textBody,
          })
          if (contactId) await trackEngagement(knex, orgId, tenantId, contactId)
          return { ok: true, messageId: info.messageId, sentVia: 'smtp', fromAddress: conn.email_address }
        }
        default:
          return { ok: false, error: `Unsupported provider: ${conn.provider}` }
      }
    }

    return { ok: false, error: 'Could not resolve email provider' }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to send email'
    console.error(`[email-router] sendEmailByPurpose(${purpose}) failed:`, message)
    return { ok: false, error: message }
  }
}

/**
 * Track email engagement — update contact's last_contacted timestamp.
 */
async function trackEngagement(
  knex: Knex,
  orgId: string,
  tenantId: string,
  contactId: string,
): Promise<void> {
  try {
    // Contacts live in customer_entities, not a `people` table (which does not
    // exist) — the old name made every send's engagement update a silent no-op.
    await knex('customer_entities')
      .where('id', contactId)
      .where('organization_id', orgId)
      .update({ updated_at: new Date() })
  } catch {
    // Non-critical — don't fail the send for engagement tracking
  }
}
