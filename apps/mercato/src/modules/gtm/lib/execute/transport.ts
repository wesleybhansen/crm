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
 * is never auto-retried. A transport that KNOWS the provider refused the
 * payload BEFORE accepting it (HTTP 429/503 responses, an SMTP 4xx reply, a
 * connection that never reached DATA) throws GtmSendRetryableError -> the
 * attempt is rescheduled with backoff (bounded, send.ts) instead of being
 * parked ambiguous forever and eating mailbox capacity (review M1).
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

// The provider definitively did NOT accept the payload (rate limit, temporary
// unavailability, connection failure before the message body was sent). Safe
// to re-dispatch later; never raised once the body may have been accepted.
export class GtmSendRetryableError extends Error {
  constructor(message = 'transport rejected before acceptance (retryable)') {
    super(message)
    this.name = 'GtmSendRetryableError'
  }
}

export function isRetryableTransportError(err: unknown): boolean {
  return err instanceof GtmSendRetryableError || (err as Error)?.name === 'GtmSendRetryableError'
}

export function isAmbiguousTransportError(err: unknown): boolean {
  return err instanceof GtmSendTimeoutError || (err as Error)?.name === 'GtmSendTimeoutError'
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

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'ETIME', 'ECONNECTION'])

/*
 * nodemailer stamps `command` with the SMTP phase that failed ('CONN',
 * 'EHLO', 'AUTH ...', 'MAIL FROM', 'RCPT TO', 'DATA') and `responseCode`
 * with the server reply. The message body only travels during DATA, so any
 * failure before that phase provably left nothing with the provider, and an
 * explicit 4xx reply at ANY phase is the server refusing (not accepting) the
 * message. Only a dropped socket during/after DATA is truly unknowable.
 */
export function classifySmtpError(err: unknown): 'retryable' | 'ambiguous' | 'failed' {
  const error = err as { code?: string; command?: string; responseCode?: number }
  const code = error?.code
  const command = typeof error?.command === 'string' ? error.command.toUpperCase() : null
  const responseCode = typeof error?.responseCode === 'number' ? error.responseCode : null
  if (responseCode != null && responseCode >= 400 && responseCode < 500) return 'retryable'
  if (code && TIMEOUT_CODES.has(code)) {
    if (command && command !== 'DATA') return 'retryable'
    return 'ambiguous'
  }
  return 'failed'
}

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
      // A submission port that does not advertise STARTTLS must fail, never
      // fall back to sending the customer's app password in cleartext.
      requireTLS: config.port !== 465,
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
      const verdict = classifySmtpError(err)
      const code = (err as { code?: string })?.code ?? 'unknown'
      const command = (err as { command?: string })?.command ?? 'unknown'
      if (verdict === 'retryable') {
        throw new GtmSendRetryableError(
          `smtp refused before acceptance (${code} at ${command}): ${(err as Error).message}`,
        )
      }
      if (verdict === 'ambiguous') {
        // Outcome unknown: the payload may already be with the provider.
        throw new GtmSendTimeoutError(
          `smtp outcome unknown (${code} at ${command}): ${(err as Error).message}`,
        )
      }
      throw err
    }
  },
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type OAuthProvider = 'gmail' | 'microsoft'

// What a successful refresh returned, for the caller to persist on the
// connection row (review M4). Microsoft rotates refresh tokens; Google does
// not return one on refresh.
export type RefreshedMailboxCredentials = {
  accessToken: string
  tokenExpiry: Date
  refreshToken: string | null
}

export type PersistRefreshedToken = (
  connection: EmailConnection,
  refreshed: RefreshedMailboxCredentials,
) => Promise<void>

type AccessTokenResult = {
  accessToken: string
  source: 'stored' | 'refreshed_transiently' | 'refreshed_persisted'
  refreshed: RefreshedMailboxCredentials | null
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
  persist?: PersistRefreshedToken,
): Promise<AccessTokenResult> {
  if (accessTokenIsFresh(connection, now)) {
    return { accessToken: connection.accessToken as string, source: 'stored', refreshed: null }
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
    // Nothing reached the mail API: the send can safely be retried later.
    throw new GtmSendRetryableError(`${provider} token refresh failed (network)`)
  }
  if (response.status === 429 || response.status >= 500) {
    throw new GtmSendRetryableError(`${provider} token refresh failed (HTTP ${response.status})`)
  }
  if (!response.ok) throw new Error(`${provider} token refresh failed (${response.status})`)
  const body = await response.json().catch(() => null) as {
    access_token?: unknown
    expires_in?: unknown
    refresh_token?: unknown
  } | null
  if (typeof body?.access_token !== 'string' || !body.access_token) {
    throw new Error(`${provider} token refresh returned no access token`)
  }
  const expiresInSeconds = typeof body.expires_in === 'number' && body.expires_in > 0
    ? body.expires_in
    : 3600
  const refreshed: RefreshedMailboxCredentials = {
    accessToken: body.access_token,
    tokenExpiry: new Date(now.getTime() + expiresInSeconds * 1000),
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token
      ? body.refresh_token
      : null,
  }
  if (!persist) {
    return { accessToken: body.access_token, source: 'refreshed_transiently', refreshed }
  }
  // Persisting is best effort: a failed write must not turn an otherwise
  // sendable attempt into a failure, but the receipt records what happened.
  try {
    await persist(connection, refreshed)
    return { accessToken: body.access_token, source: 'refreshed_persisted', refreshed }
  } catch {
    return { accessToken: body.access_token, source: 'refreshed_transiently', refreshed }
  }
}

// Minimal EntityManager slice needed to persist a refreshed token.
type TokenPersistEm = {
  nativeUpdate<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<number>
}

/*
 * Persist a refreshed access token (and a rotated refresh token) on the
 * connection row so every later send/ingest reuses it instead of paying a
 * token round-trip, and so Microsoft's rotating refresh tokens never expire
 * out from under a steadily-used mailbox (review M4).
 *
 * Deliberately a conditional nativeUpdate that does NOT touch updated_at: the
 * approval snapshot's sender fingerprint (send.ts canonicalHash of the
 * connection material) includes updated_at, so an ORM flush with the onUpdate
 * hook would fail every subsequent send with 'sender_changed'.
 *
 * Encryption note: email_connections.access_token / refresh_token are plain
 * text columns whose at-rest encryption depends on a runtime encryption_maps
 * row that this repository does not seed (and email/api/smtp writes the
 * sibling smtp_pass via raw knex, bypassing the subscriber). This write
 * therefore stores the token exactly the way the connect flow stored the
 * original. If a tenant map for email_connections is ever seeded, route this
 * write through the encrypting path instead. Not changed here on purpose.
 */
export function createTokenPersister(
  em: TokenPersistEm,
  EmailConnectionEntity: new () => EmailConnection,
): PersistRefreshedToken {
  return async (connection, refreshed) => {
    await em.nativeUpdate(
      EmailConnectionEntity,
      {
        id: connection.id,
        organizationId: connection.organizationId,
        tenantId: connection.tenantId,
        deletedAt: null,
      },
      {
        accessToken: refreshed.accessToken,
        tokenExpiry: refreshed.tokenExpiry,
        ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
      },
    )
  }
}

/*
 * HTTP outcome classes for the provider send call. The payload is the request
 * body, so ANY response from the API means the provider read the request and
 * replied; the only unknowable case is no response at all (dropped socket,
 * client-side timeout). 429 (rate limited), 503 (unavailable) and 408 are the
 * provider explicitly refusing before acceptance: definitely not sent,
 * retryable. Other 5xx responses (500/502/504) are ambiguous: the API may
 * have handed the message to the mail backend before failing.
 */
export function classifyHttpSendStatus(status: number): 'accepted' | 'retryable' | 'ambiguous' | 'failed' {
  if (status >= 200 && status < 300) return 'accepted'
  if (status === 408 || status === 429 || status === 503) return 'retryable'
  if (status >= 500) return 'ambiguous'
  return 'failed'
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
  const verdict = classifyHttpSendStatus(response.status)
  if (verdict === 'retryable') {
    throw new GtmSendRetryableError(`${provider} refused before acceptance (HTTP ${response.status})`)
  }
  if (verdict === 'ambiguous') {
    throw new GtmSendTimeoutError(`${provider} outcome unknown (HTTP ${response.status})`)
  }
  if (verdict === 'failed') throw new Error(`${provider} send failed (HTTP ${response.status})`)
  return response
}

export function createMailboxTransport(input: {
  fetch?: FetchLike
  now?: () => Date
  smtp?: GtmSendTransport
  persistRefreshedToken?: PersistRefreshedToken
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
      const token = await resolveMailboxAccessToken(
        args.connection,
        provider,
        fetchImpl,
        now(),
        input.persistRefreshedToken,
      )
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

// Production transport bound to an EntityManager so refreshed OAuth tokens
// are persisted on the connection row (see createTokenPersister).
export function createPersistingMailboxTransport(
  em: TokenPersistEm,
  EmailConnectionEntity: new () => EmailConnection,
): GtmSendTransport {
  return createMailboxTransport({
    persistRefreshedToken: createTokenPersister(em, EmailConnectionEntity),
  })
}
