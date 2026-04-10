/**
 * Email Router Service
 * Routes outbound email through the user's connected email provider (Gmail, Outlook, SMTP, etc.)
 * Falls back to error if no connection is configured.
 */

import type { Knex } from 'knex'
import { sendViaGmail, getGmailToken } from './gmail-service'
import { sendViaOutlook, getOutlookToken } from './outlook-service'
import { sendViaESP } from './esp-service'
import type { EmailPurpose } from './routing-service'

interface SendEmailParams {
  to: string
  cc?: string
  bcc?: string
  subject: string
  htmlBody: string
  textBody?: string
  contactId?: string
}

interface SendEmailResult {
  ok: boolean
  messageId?: string
  sentVia?: string
  fromAddress?: string
  error?: string
}

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
  const { to, cc, bcc, subject, htmlBody, textBody, contactId } = params

  // Find user's email connection — prefer primary, then any active
  const connection = await knex('email_connections')
    .where('organization_id', orgId)
    .where('user_id', userId)
    .where('is_active', true)
    .orderBy('is_primary', 'desc')
    .first()

  console.log('[email-router] Looking up connection for orgId:', orgId, 'userId:', userId, 'found:', connection?.provider || 'NONE', 'active:', connection?.is_active)

  if (!connection) {
    return {
      ok: false,
      error: 'No email account connected. Connect Gmail or Outlook in Settings.',
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
          const nodemailer = await import('nodemailer')
          const transporter = nodemailer.createTransport({
            host: connection.smtp_host,
            port: connection.smtp_port || 587,
            secure: connection.smtp_port === 465,
            auth: {
              user: connection.smtp_user,
              pass: connection.smtp_pass,
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
): Promise<BulkSendResult> {
  // Check if org has an ESP connection
  const espConnection = await knex('esp_connections')
    .where('organization_id', orgId)
    .where('is_active', true)
    .first()

  if (espConnection) {
    // Use ESP for bulk sending
    const results: BulkSendResult['results'] = []
    let sent = 0
    let failed = 0

    for (const to of recipients) {
      try {
        const result = await sendViaESP(
          espConnection.provider,
          espConnection.api_key,
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

  // No ESP — fall back to user's personal email connection
  // Find any active connection for the org (prefer primary)
  const connection = await knex('email_connections')
    .where('organization_id', orgId)
    .where('is_active', true)
    .orderBy('is_primary', 'desc')
    .first()

  if (!connection) {
    return {
      ok: false,
      total: recipients.length,
      sent: 0,
      failed: recipients.length,
      results: recipients.map(to => ({ to, ok: false, error: 'No email connection configured' })),
      sentVia: 'none',
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
  params: SendEmailParams & { fromName?: string },
): Promise<SendEmailResult> {
  const { getProviderForPurpose } = await import('./routing-service')
  const resolved = await getProviderForPurpose(knex, orgId, purpose)

  if (!resolved) {
    return { ok: false, error: 'No email provider configured. Connect an email account or ESP in Settings.' }
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
    await knex('people')
      .where('id', contactId)
      .where('organization_id', orgId)
      .update({ updated_at: new Date() })
  } catch {
    // Non-critical — don't fail the send for engagement tracking
  }
}
