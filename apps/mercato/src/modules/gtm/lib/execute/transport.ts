/*
 * The GTM send-transport seam (SPEC-066 sections 3.1, 6, 8, 14 Tranche 6).
 *
 * Why this exists instead of reusing email-router/smtp-service directly:
 * the existing `sendViaSMTP` (email/lib/smtp-service.ts) and the router
 * (`sendEmailByPurpose`) accept ONLY (from, to, subject, html, text) - they
 * cannot carry the RFC 8058 one-click List-Unsubscribe headers section 8
 * requires on every GTM send, nor set our own pre-minted RFC Message-ID that
 * reply correlation (section 9) depends on. Editing email-module files is
 * out of scope for this tranche, so `smtpTransport` is gtm's own thin
 * nodemailer bridge. What it REUSES per spec 3.1 is the qualified
 * `email_connections` row itself: the same smtp_host / smtp_port /
 * smtp_user / smtp_pass app-password config shape smtp-service reads, with
 * the same well-known-domain SMTP presets imap-service applies when the
 * explicit host is absent.
 *
 * Ambiguity contract (section 6 rule 4): a transport that KNOWS the send
 * failed throws a plain Error -> the attempt goes 'failed'. A transport that
 * cannot know the outcome (network timeout after the payload may have been
 * accepted) throws GtmSendTimeoutError -> the attempt goes 'ambiguous' and
 * is never auto-retried.
 *
 * Tests use fake transports; nothing in the test paths ever opens a socket.
 */

import type { EmailConnection } from '../../../email/data/schema'

export class GtmSendTimeoutError extends Error {
  constructor(message = 'transport outcome unknown (timeout)') {
    super(message)
    this.name = 'GtmSendTimeoutError'
  }
}

export type GtmTransportSendArgs = {
  connection: EmailConnection
  from: string
  to: string
  subject: string
  html: string
  text: string
  // Includes List-Unsubscribe + List-Unsubscribe-Post on every GTM send.
  headers: Record<string, string>
  // Our pre-minted RFC Message-ID (already persisted on the attempt).
  messageId: string
}

export type GtmTransportSendResult = {
  ok: true
  providerMessageId?: string | null
  receipt?: Record<string, unknown> | null
}

export interface GtmSendTransport {
  // Resolves on provider acceptance; throws Error on known failure;
  // throws GtmSendTimeoutError when the outcome is unknowable.
  send(args: GtmTransportSendArgs): Promise<GtmTransportSendResult>
}

// Mirror of imap-service's well-known SMTP presets (module-private there, so
// duplicated rather than edited into an export; keyed by address domain).
const SMTP_PRESETS: Record<string, { host: string; port: number }> = {
  'gmail.com': { host: 'smtp.gmail.com', port: 587 },
  'googlemail.com': { host: 'smtp.gmail.com', port: 587 },
  'outlook.com': { host: 'smtp.office365.com', port: 587 },
  'hotmail.com': { host: 'smtp.office365.com', port: 587 },
  'live.com': { host: 'smtp.office365.com', port: 587 },
  'yahoo.com': { host: 'smtp.mail.yahoo.com', port: 587 },
  'icloud.com': { host: 'smtp.mail.me.com', port: 587 },
  'me.com': { host: 'smtp.mail.me.com', port: 587 },
  'mac.com': { host: 'smtp.mail.me.com', port: 587 },
  'zoho.com': { host: 'smtp.zoho.com', port: 587 },
  'fastmail.com': { host: 'smtp.fastmail.com', port: 587 },
}

export function resolveSmtpConfig(connection: EmailConnection): {
  host: string
  port: number
  user: string
  pass: string
} | null {
  const user = connection.smtpUser || connection.emailAddress
  const pass = connection.smtpPass || null
  if (!user || !pass) return null
  if (connection.smtpHost && connection.smtpPort) {
    return { host: connection.smtpHost, port: connection.smtpPort, user, pass }
  }
  const domain = (connection.emailAddress || '').split('@')[1]?.toLowerCase() ?? ''
  const preset = SMTP_PRESETS[domain]
  if (!preset) return null
  return { host: preset.host, port: preset.port, user, pass }
}

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'ETIME'])

// Production transport. Never invoked by tests; the internal execution route
// additionally refuses to use it unless GTM_EXECUTION_ENABLED === 'true'.
export const smtpTransport: GtmSendTransport = {
  async send(args: GtmTransportSendArgs): Promise<GtmTransportSendResult> {
    const config = resolveSmtpConfig(args.connection)
    if (!config) {
      throw new Error('sender connection has no usable SMTP configuration')
    }
    const nodemailer = await import('nodemailer')
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass },
      connectionTimeout: 30_000,
      socketTimeout: 60_000,
    })
    try {
      const info = await transporter.sendMail({
        from: args.from,
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
        headers: args.headers,
        messageId: args.messageId,
      })
      return {
        ok: true,
        providerMessageId: info.messageId || null,
        receipt: {
          response: info.response ?? null,
          accepted: (info.accepted as unknown[])?.map(String) ?? [],
          rejected: (info.rejected as unknown[])?.map(String) ?? [],
        },
      }
    } catch (err) {
      const code = (err as { code?: string })?.code
      if (code && TIMEOUT_CODES.has(code)) {
        // Outcome unknown: the payload may already be with the provider.
        throw new GtmSendTimeoutError(
          `smtp outcome unknown (${code}): ${(err as Error).message}`,
        )
      }
      throw err
    }
  },
}
