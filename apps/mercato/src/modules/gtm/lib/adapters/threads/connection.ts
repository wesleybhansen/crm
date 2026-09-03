/*
 * Meta Threads per-customer OAuth connection (official Threads API).
 *
 * Contract (verified against developers.facebook.com on 2026-09-02):
 * - Authorization window: https://threads.net/oauth/authorize
 *   (client_id, redirect_uri, scope, response_type=code, state)
 * - Code exchange (short-lived, 1 hour): POST https://graph.threads.net/oauth/access_token
 * - Long-lived exchange (60 days): GET https://graph.threads.net/access_token
 *   ?grant_type=th_exchange_token&client_secret&access_token
 * - Refresh (60 days, token must be >= 24h old and unexpired):
 *   GET https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token
 * - Profile: GET https://graph.threads.net/v1.0/me?fields=id,username,name
 * - Keyword search needs `threads_basic` + `threads_keyword_search`. Without
 *   App Review approval the endpoint silently searches only the connected
 *   user's own posts, so the adapter also requires the deployment-level
 *   approval switch before it will serve customers.
 * - Rate limit: 2,200 keyword queries per user per rolling 24 hours.
 *
 * The long-lived token is sealed with the tenant DEK (AES-GCM) before it is
 * stored and only ever unsealed inside the adapter call path. Nothing here
 * logs or returns a plaintext token to a route response.
 */

import { decryptWithAesGcmStrict, encryptWithAesGcm } from '@open-mercato/shared/lib/encryption/aes'
import type { GtmSocialConnection } from '../../../data/entities'

export const THREADS_PROVIDER = 'threads'
export const THREADS_AUTHORIZE_URL = 'https://threads.net/oauth/authorize'
export const THREADS_TOKEN_URL = 'https://graph.threads.net/oauth/access_token'
export const THREADS_LONG_LIVED_TOKEN_URL = 'https://graph.threads.net/access_token'
export const THREADS_REFRESH_TOKEN_URL = 'https://graph.threads.net/refresh_access_token'
export const THREADS_GRAPH_URL = 'https://graph.threads.net/v1.0'
export const THREADS_REQUIRED_SCOPES = ['threads_basic', 'threads_keyword_search'] as const
export const THREADS_QUERY_WINDOW_MS = 24 * 60 * 60 * 1_000
// Meta allows 2,200 per rolling 24h. Noli reserves against a lower ceiling so
// a customer's own manual use of the same account is never starved.
export const THREADS_QUERY_BUDGET_PER_WINDOW = 2_000
export const THREADS_REFRESH_MIN_AGE_MS = 24 * 60 * 60 * 1_000
export const THREADS_REFRESH_WHEN_EXPIRING_WITHIN_MS = 14 * 24 * 60 * 60 * 1_000

export const THREADS_APP_ID_ENV = 'GTM_THREADS_APP_ID'
export const THREADS_APP_SECRET_ENV = 'GTM_THREADS_APP_SECRET'

type ThreadsEnv = Record<string, string | undefined>
type ThreadsFetch = typeof fetch

export type ThreadsAppConfig = { appId: string; appSecret: string }

export function threadsAppConfig(env: ThreadsEnv = process.env): ThreadsAppConfig | null {
  const appId = (env[THREADS_APP_ID_ENV] ?? '').trim()
  const appSecret = (env[THREADS_APP_SECRET_ENV] ?? '').trim()
  if (!/^\d{5,30}$/.test(appId) || !appSecret) return null
  return { appId, appSecret }
}

export function threadsAuthorizeUrl(args: { appId: string; redirectUri: string; state: string }): string {
  const url = new URL(THREADS_AUTHORIZE_URL)
  url.searchParams.set('client_id', args.appId)
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('scope', THREADS_REQUIRED_SCOPES.join(','))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', args.state)
  return url.toString()
}

export class ThreadsOAuthError extends Error {
  constructor(
    readonly code:
      | 'code_exchange_failed'
      | 'long_lived_exchange_failed'
      | 'refresh_failed'
      | 'profile_failed'
      | 'token_invalid'
      | 'transport',
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message)
    this.name = 'ThreadsOAuthError'
  }
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? Array.from(trimmed).slice(0, max).join('') : null
}

function graphErrorCode(body: unknown): number | null {
  const error = body && typeof body === 'object' ? (body as { error?: { code?: unknown } }).error : null
  const code = Number(error?.code)
  return Number.isFinite(code) ? code : null
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null)
}

export async function exchangeThreadsCode(
  config: ThreadsAppConfig,
  args: { code: string; redirectUri: string },
  fetchImpl: ThreadsFetch = fetch,
): Promise<{ accessToken: string; userId: string }> {
  let response: Response
  try {
    response = await fetchImpl(THREADS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.appId,
        client_secret: config.appSecret,
        grant_type: 'authorization_code',
        redirect_uri: args.redirectUri,
        code: args.code,
      }),
    })
  } catch (error) {
    throw new ThreadsOAuthError('transport', error instanceof Error ? error.message : String(error))
  }
  const body = await readJson(response) as { access_token?: unknown; user_id?: unknown } | null
  const accessToken = text(body?.access_token, 4_000)
  const userId = body?.user_id != null ? text(String(body.user_id), 60) : null
  if (!response.ok || !accessToken || !userId) {
    throw new ThreadsOAuthError('code_exchange_failed', `Threads code exchange failed (${response.status})`, response.status)
  }
  return { accessToken, userId }
}

export async function exchangeThreadsLongLivedToken(
  config: ThreadsAppConfig,
  shortLivedToken: string,
  fetchImpl: ThreadsFetch = fetch,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const url = new URL(THREADS_LONG_LIVED_TOKEN_URL)
  url.searchParams.set('grant_type', 'th_exchange_token')
  url.searchParams.set('client_secret', config.appSecret)
  url.searchParams.set('access_token', shortLivedToken)
  let response: Response
  try {
    response = await fetchImpl(url.toString(), { method: 'GET' })
  } catch (error) {
    throw new ThreadsOAuthError('transport', error instanceof Error ? error.message : String(error))
  }
  const body = await readJson(response) as { access_token?: unknown; expires_in?: unknown } | null
  const accessToken = text(body?.access_token, 4_000)
  const expiresIn = Number(body?.expires_in)
  if (!response.ok || !accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new ThreadsOAuthError('long_lived_exchange_failed', `Threads long-lived exchange failed (${response.status})`, response.status)
  }
  return { accessToken, expiresInSeconds: Math.floor(expiresIn) }
}

export async function refreshThreadsToken(
  longLivedToken: string,
  fetchImpl: ThreadsFetch = fetch,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const url = new URL(THREADS_REFRESH_TOKEN_URL)
  url.searchParams.set('grant_type', 'th_refresh_token')
  url.searchParams.set('access_token', longLivedToken)
  let response: Response
  try {
    response = await fetchImpl(url.toString(), { method: 'GET' })
  } catch (error) {
    throw new ThreadsOAuthError('transport', error instanceof Error ? error.message : String(error))
  }
  const body = await readJson(response)
  const row = body as { access_token?: unknown; expires_in?: unknown } | null
  const accessToken = text(row?.access_token, 4_000)
  const expiresIn = Number(row?.expires_in)
  if (!response.ok || !accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    const invalid = response.status === 400 || response.status === 401 || graphErrorCode(body) === 190
    throw new ThreadsOAuthError(
      invalid ? 'token_invalid' : 'refresh_failed',
      `Threads token refresh failed (${response.status})`,
      response.status,
    )
  }
  return { accessToken, expiresInSeconds: Math.floor(expiresIn) }
}

export async function fetchThreadsProfile(
  accessToken: string,
  fetchImpl: ThreadsFetch = fetch,
): Promise<{ id: string; username: string | null; name: string | null }> {
  const url = new URL(`${THREADS_GRAPH_URL}/me`)
  url.searchParams.set('fields', 'id,username,name')
  let response: Response
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  } catch (error) {
    throw new ThreadsOAuthError('transport', error instanceof Error ? error.message : String(error))
  }
  const body = await readJson(response) as { id?: unknown; username?: unknown; name?: unknown } | null
  const id = body?.id != null ? text(String(body.id), 60) : null
  if (!response.ok || !id) {
    throw new ThreadsOAuthError('profile_failed', `Threads profile lookup failed (${response.status})`, response.status)
  }
  return { id, username: text(body?.username, 100), name: text(body?.name, 120) }
}

// ---------------------------------------------------------------------------
// Token sealing
// ---------------------------------------------------------------------------

export function sealThreadsToken(token: string, dekBase64: string): string {
  const sealed = encryptWithAesGcm(token, dekBase64).value
  if (!sealed) throw new Error('Threads token sealing failed')
  return sealed
}

export function openThreadsToken(sealed: string, dekBase64: string): string {
  return decryptWithAesGcmStrict(sealed, dekBase64)
}

// ---------------------------------------------------------------------------
// Runtime access handed to the source adapter
// ---------------------------------------------------------------------------

/** The adapter never sees the connection entity or the DEK; it gets a narrow
 *  capability object. `reserveQuery` is called BEFORE the provider call so a
 *  window-exhausted account refuses without contacting Meta. */
export type ThreadsConnectionAccess = {
  connectionId: string
  providerUserId: string
  username: string | null
  scopes: string[]
  remainingQueries(): number
  reserveQuery(): Promise<boolean>
  getAccessToken(): Promise<string>
  markInvalid(reason: string): Promise<void>
  recordUse(): Promise<void>
}

export type ThreadsConnectionEm = {
  findOne(entity: unknown, where: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>
  find(entity: unknown, where: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown[]>
  persist(entity: unknown): unknown
  flush(): Promise<void>
}

export type ThreadsConnectionScope = { organizationId: string; tenantId: string }

export function queryWindowState(
  connection: Pick<GtmSocialConnection, 'queryWindowStartedAt' | 'queriesInWindow'>,
  now: Date,
): { windowStartedAt: Date; used: number; remaining: number } {
  const started = connection.queryWindowStartedAt
  const fresh = !started || now.getTime() - started.getTime() >= THREADS_QUERY_WINDOW_MS
  const windowStartedAt = fresh ? now : started
  const used = fresh ? 0 : Math.max(0, connection.queriesInWindow ?? 0)
  return { windowStartedAt, used, remaining: Math.max(0, THREADS_QUERY_BUDGET_PER_WINDOW - used) }
}

export function shouldRefreshThreadsToken(
  connection: Pick<GtmSocialConnection, 'tokenIssuedAt' | 'lastRefreshedAt' | 'tokenExpiresAt'>,
  now: Date,
): boolean {
  const issued = connection.lastRefreshedAt ?? connection.tokenIssuedAt
  const expires = connection.tokenExpiresAt
  if (!issued || !expires) return false
  if (expires.getTime() <= now.getTime()) return false // expired tokens cannot be refreshed
  if (now.getTime() - issued.getTime() < THREADS_REFRESH_MIN_AGE_MS) return false
  return expires.getTime() - now.getTime() <= THREADS_REFRESH_WHEN_EXPIRING_WITHIN_MS
}

export function createThreadsConnectionAccess(
  em: ThreadsConnectionEm,
  connection: GtmSocialConnection,
  deps: { dekKey: string; fetchImpl?: ThreadsFetch; now?: () => Date },
): ThreadsConnectionAccess {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => new Date())
  let cachedToken: string | null = null
  return {
    connectionId: connection.id,
    providerUserId: connection.providerUserId,
    username: connection.username ?? null,
    scopes: Array.isArray(connection.scopes) ? [...connection.scopes] : [],
    remainingQueries() {
      return queryWindowState(connection, now()).remaining
    },
    async reserveQuery() {
      const state = queryWindowState(connection, now())
      if (state.remaining <= 0) return false
      connection.queryWindowStartedAt = state.windowStartedAt
      connection.queriesInWindow = state.used + 1
      em.persist(connection)
      await em.flush()
      return true
    },
    async getAccessToken() {
      if (cachedToken) return cachedToken
      if (connection.status !== 'active') {
        throw new ThreadsOAuthError('token_invalid', `Threads connection is ${connection.status}`)
      }
      const current = openThreadsToken(connection.accessTokenSealed, deps.dekKey)
      const at = now()
      if (connection.tokenExpiresAt && connection.tokenExpiresAt.getTime() <= at.getTime()) {
        connection.status = 'reauth_required'
        connection.statusReason = 'token_expired'
        em.persist(connection)
        await em.flush()
        throw new ThreadsOAuthError('token_invalid', 'Threads token has expired; reconnect the account')
      }
      if (!shouldRefreshThreadsToken(connection, at)) {
        cachedToken = current
        return current
      }
      try {
        const refreshed = await refreshThreadsToken(current, fetchImpl)
        connection.accessTokenSealed = sealThreadsToken(refreshed.accessToken, deps.dekKey)
        connection.lastRefreshedAt = at
        connection.tokenExpiresAt = new Date(at.getTime() + refreshed.expiresInSeconds * 1_000)
        em.persist(connection)
        await em.flush()
        cachedToken = refreshed.accessToken
        return refreshed.accessToken
      } catch (error) {
        if (error instanceof ThreadsOAuthError && error.code === 'token_invalid') {
          connection.status = 'reauth_required'
          connection.statusReason = 'refresh_rejected'
          em.persist(connection)
          await em.flush()
          throw error
        }
        // A transient refresh failure keeps the still-valid token usable.
        cachedToken = current
        return current
      }
    },
    async markInvalid(reason) {
      connection.status = 'reauth_required'
      connection.statusReason = reason.slice(0, 200)
      em.persist(connection)
      await em.flush()
    },
    async recordUse() {
      connection.lastUsedAt = now()
      em.persist(connection)
      await em.flush()
    },
  }
}

/** The newest active Threads connection for the scope, or null. */
export async function findActiveThreadsConnection(
  em: ThreadsConnectionEm,
  entity: unknown,
  scope: ThreadsConnectionScope,
): Promise<GtmSocialConnection | null> {
  const rows = await em.find(
    entity,
    {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      provider: THREADS_PROVIDER,
      status: 'active',
      deletedAt: null,
    },
    { orderBy: { createdAt: 'desc' }, limit: 1 },
  )
  return (rows[0] as GtmSocialConnection | undefined) ?? null
}
