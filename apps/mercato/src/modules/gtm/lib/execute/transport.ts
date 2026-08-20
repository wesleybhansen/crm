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
import { buildGtmMimeMessage, encodeGmailRaw, encodeGraphMime } from './mime'

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

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type OAuthProvider = 'gmail' | 'microsoft'

type AccessTokenResult = {
  accessToken: string
  source: 'stored' | 'refreshed_transiently'
}

function normalizeProvider(provider: string): 'gmail' | 'microsoft' | 'smtp' | null {
  const normalized = provider.trim().toLowerCase()
  if (normalized === 'gmail') return 'gmail'
  if (normalized === 'microsoft' || normalized === 'outlook') return 'microsoft'
  if (normalized === 'smtp' || normalized === 'imap') return 'smtp'
  return null
}

function accessTokenIsFresh(connection: EmailConnection, now: Date): boolean {
  return Boolean(
    connection.accessToken
      && (!connection.tokenExpiry || connection.tokenExpiry.getTime() > now.getTime() + 5 * 60 * 1000),
  )
}

function oauthConfiguration(provider: OAuthProvider): {
  url: string
  body: URLSearchParams
} {
  if (provider === 'gmail') {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
    if (!clientId) throw new Error('gmail oauth is not configured')
    const body = new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token' })
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
    if (clientSecret) body.set('client_secret', clientSecret)
    return { url: 'https://oauth2.googleapis.com/token', body }
  }
  const clientId = process.env.MICROSOFT_CLIENT_ID
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('microsoft oauth is not configured')
  return {
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      scope: 'Mail.Send Mail.ReadWrite User.Read offline_access',
    }),
  }
}

export async function resolveMailboxAccessToken(
  connection: EmailConnection,
  provider: OAuthProvider,
  fetchImpl: FetchLike,
  now: Date,
): Promise<AccessTokenResult> {
  if (accessTokenIsFresh(connection, now)) {
    return { accessToken: connection.accessToken as string, source: 'stored' }
  }
  if (!connection.refreshToken) throw new Error(`${provider} mailbox requires reconnection`)
  const config = oauthConfiguration(provider)
  config.body.set('refresh_token', connection.refreshToken)
  let response: Response
  try {
    response = await fetchImpl(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: config.body,
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new Error(`${provider} token refresh failed`)
  }
  if (!response.ok) throw new Error(`${provider} token refresh failed (${response.status})`)
  const body = await response.json().catch(() => null) as { access_token?: unknown } | null
  if (typeof body?.access_token !== 'string' || !body.access_token) {
    throw new Error(`${provider} token refresh returned no access token`)
  }
  return { accessToken: body.access_token, source: 'refreshed_transiently' }
}

function outcomeIsAmbiguous(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

async function providerFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  provider: OAuthProvider,
): Promise<Response> {
  let response: Response
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(60_000) })
  } catch {
    throw new GtmSendTimeoutError(`${provider} outcome unknown (transport error)`)
  }
  if (outcomeIsAmbiguous(response.status)) {
    throw new GtmSendTimeoutError(`${provider} outcome unknown (HTTP ${response.status})`)
  }
  if (!response.ok) throw new Error(`${provider} send failed (HTTP ${response.status})`)
  return response
}

export function createMailboxTransport(input: {
  fetch?: FetchLike
  now?: () => Date
  smtp?: GtmSendTransport
} = {}): GtmSendTransport {
  const fetchImpl = input.fetch ?? fetch
  const now = input.now ?? (() => new Date())
  const smtp = input.smtp ?? smtpTransport
  return {
    async send(args): Promise<GtmTransportSendResult> {
      const provider = normalizeProvider(args.connection.provider)
      if (!provider) throw new Error('sender connection provider is unsupported')
      if (provider === 'smtp') return smtp.send(args)
      const mime = buildGtmMimeMessage(args)
      const token = await resolveMailboxAccessToken(args.connection, provider, fetchImpl, now())
      if (provider === 'gmail') {
        const response = await providerFetch(
          fetchImpl,
          'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ raw: encodeGmailRaw(mime) }),
          },
          provider,
        )
        const body = await response.json().catch(() => null) as {
          id?: unknown
          threadId?: unknown
        } | null
        const providerMessageId = typeof body?.id === 'string' && body.id ? body.id : null
        return {
          ok: true,
          providerMessageId,
          receipt: {
            provider: 'gmail',
            http_status: response.status,
            thread_id: typeof body?.threadId === 'string' ? body.threadId : null,
            token_source: token.source,
          },
        }
      }
      const response = await providerFetch(
        fetchImpl,
        'https://graph.microsoft.com/v1.0/me/sendMail',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token.accessToken}`,
            'Content-Type': 'text/plain',
          },
          body: encodeGraphMime(mime),
        },
        provider,
      )
      return {
        ok: true,
        providerMessageId: null,
        receipt: {
          provider: 'microsoft_graph',
          http_status: response.status,
          rfc_message_id: args.messageId,
          token_source: token.source,
        },
      }
    },
  }
}

export const mailboxTransport = createMailboxTransport()
