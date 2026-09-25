"use client"
// Simple fetch wrapper that redirects to session refresh on 401 (Unauthorized)
// Used across UI data utilities to avoid duplication.
import { flash } from '../FlashMessages'
import { deserializeOperationMetadata } from '@open-mercato/shared/lib/commands/operationMetadata'
import { pushOperation } from '../operations/store'
import { pushPartialIndexWarning } from '../indexes/store'
import { createScopedHeaderStack } from './scopedHeaderStack'

const scopedHeaders = createScopedHeaderStack()

function mergeHeaders(base: HeadersInit | undefined, scoped: Record<string, string>): Headers {
  const headers = new Headers(base ?? {})
  for (const [key, value] of Object.entries(scoped)) {
    if (headers.has(key)) continue
    headers.set(key, value)
  }
  return headers
}

export async function withScopedApiHeaders<T>(headers: Record<string, string>, run: () => Promise<T>): Promise<T> {
  return scopedHeaders.withScopedHeaders(headers, run)
}

export class UnauthorizedError extends Error {
  readonly status = 401
  constructor(message = 'Unauthorized') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export function redirectToSessionRefresh() {
  if (typeof window === 'undefined') return
  const current = window.location.pathname + window.location.search
  // Avoid redirect loops if already on an auth/session route
  if (window.location.pathname.startsWith('/api/auth')) return
  // Portal routes have their own customer auth — never redirect to staff login
  if (/\/[^/]+\/portal(\/|$)/.test(window.location.pathname)) return
  try {
    flash('Session expired. Redirecting to sign in…', 'warning')
    setTimeout(() => {
      window.location.href = `/api/auth/session/refresh?redirect=${encodeURIComponent(current)}`
    }, 20)
  } catch {
    // no-op
  }
}

export class ForbiddenError extends Error {
  readonly status = 403
  constructor(message = 'Forbidden') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

let DEFAULT_FORBIDDEN_ROLES: string[] = ['admin']

export function setAuthRedirectConfig(cfg: { defaultForbiddenRoles?: readonly string[] }) {
  if (cfg?.defaultForbiddenRoles && cfg.defaultForbiddenRoles.length) {
    DEFAULT_FORBIDDEN_ROLES = [...cfg.defaultForbiddenRoles].map(String)
  }
}

/**
 * Called when the server says the signed-in user lacks a role or feature.
 * Noli signs people in on the hub and the CRM has no sign-in page of its
 * own, so sending them to a login screen would only sign them out. Tell them
 * instead. (Name kept for backward compatibility.)
 */
export function redirectToForbiddenLogin(_options?: { requiredRoles?: string[] | null; requiredFeatures?: string[] | null }) {
  if (typeof window === 'undefined') return
  if (window.location.pathname.startsWith('/login')) return
  // Portal routes have their own customer auth
  if (/\/[^/]+\/portal(\/|$)/.test(window.location.pathname)) return
  try {
    flash("You don't have permission to do that. Ask your workspace admin for access.", 'warning')
  } catch {
    // no-op
  }
}

const TRANSIENT_STATUSES = new Set([502, 503, 504])
const TRANSIENT_RETRY_DELAYS_MS = [1500, 4000]
const UNAUTHORIZED_RECHECK_DELAY_MS = 1200
const RECONNECTING_NOTICE_INTERVAL_MS = 10_000
let lastReconnectingNoticeAt = 0

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function notifyReconnecting() {
  const now = Date.now()
  if (now - lastReconnectingNoticeAt < RECONNECTING_NOTICE_INTERVAL_MS) return
  lastReconnectingNoticeAt = now
  try {
    flash('Having trouble reaching the server. Reconnecting…', 'warning')
  } catch {
    // no-op
  }
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase()
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase()
  return 'GET'
}

/** @internal exported for tests */
export function isIdempotentRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = requestMethod(input, init)
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
}

/** @internal exported for tests. A request whose body can be sent twice. */
export function isReplayableRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  // A Request object's body can only be read once.
  if (typeof Request !== 'undefined' && input instanceof Request && input.body) return false
  const body = init?.body
  if (body === undefined || body === null) return true
  if (typeof body === 'string') return true
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true
  if (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) return true
  return false
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  type FetchType = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  const originalFetch =
    typeof window !== 'undefined'
      ? (window as Window & { __omOriginalFetch?: FetchType }).__omOriginalFetch
      : undefined
  const fallbackFetch = (globalThis as typeof globalThis & { fetch?: FetchType }).fetch
  const baseFetch = originalFetch ?? fallbackFetch
  if (!baseFetch) {
    return new Response(
      JSON.stringify({ error: 'Fetch API is not available in this runtime' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )
  }
  const scoped = scopedHeaders.resolveScopedHeaders()
  const mergedInit = Object.keys(scoped).length
    ? { ...(init ?? {}), headers: mergeHeaders(init?.headers, scoped) }
    : init
  const pathname = typeof window !== 'undefined' ? window.location.pathname : ''
  const onLoginPage = pathname.startsWith('/login')
  const onPortalRoute = /\/[^/]+\/portal(\/|$)/.test(pathname)
  const inBrowser = typeof window !== 'undefined'
  const replayable = isReplayableRequest(input, mergedInit)
  const idempotent = isIdempotentRequest(input, mergedInit)
  let res = await baseFetch(input, mergedInit)
  // Server restarting, database blip or sign-in check unavailable: retry
  // reads a couple of times and tell the user we're reconnecting, instead of
  // failing the page (or worse, signing them out).
  if (inBrowser && idempotent && replayable) {
    for (const delayMs of TRANSIENT_RETRY_DELAYS_MS) {
      if (!TRANSIENT_STATUSES.has(res.status)) break
      notifyReconnecting()
      await sleep(delayMs)
      res = await baseFetch(input, mergedInit)
    }
  }
  // A single 401 can be a race (a deploy, a session cookie being rotated).
  // Ask once more before treating it as a real sign-out. The server rejected
  // the first attempt before running the handler, so replaying is safe.
  if (res.status === 401 && inBrowser && replayable && !onLoginPage && !onPortalRoute) {
    await sleep(UNAUTHORIZED_RECHECK_DELAY_MS)
    res = await baseFetch(input, mergedInit)
  }
  if (res.status === 401) {
    // Trigger same redirect flow as protected pages
    // Skip for staff login page and all portal routes (portal has its own auth)
    if (!onLoginPage && !onPortalRoute) {
      redirectToSessionRefresh()
      // Throw a typed error for callers that might still handle it
      throw new UnauthorizedError(await res.text().catch(() => 'Unauthorized'))
    }
    return res
  }
  if (res.status === 403) {
    // Try to read requiredRoles from JSON body; ignore if not JSON
    let roles: string[] | null = null
    let features: string[] | null = null
    let payload: unknown = null
    try {
      const clone = res.clone()
      const data = await clone.json()
      if (Array.isArray(data?.requiredRoles)) roles = data.requiredRoles.map((r: any) => String(r))
      if (Array.isArray(data?.requiredFeatures)) features = data.requiredFeatures.map((f: any) => String(f))
      if (data && typeof data === 'object') payload = data
    } catch {}
    // Only redirect if not already on login page or a portal route
    if (!onLoginPage && !onPortalRoute) {
      const target =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (typeof Request !== 'undefined' && input instanceof Request)
              ? input.url
              : 'unknown'
      try {
        // eslint-disable-next-line no-console
        console.warn('[apiFetch] Forbidden response', {
          url: target,
          status: res.status,
          requiredRoles: roles,
          requiredFeatures: features,
          details: payload,
        })
      } catch {}
      const hasAclHints = Boolean((roles && roles.length) || (features && features.length))
      if (hasAclHints) {
        redirectToForbiddenLogin({ requiredRoles: roles, requiredFeatures: features })
      }
      const msg = await res.clone().text().catch(() => 'Forbidden')
      throw new ForbiddenError(msg)
    }
    // If already on login, just return the response for the caller to handle
  }
  try {
    const header = res.headers.get('x-om-operation')
    const metadata = deserializeOperationMetadata(header)
    if (metadata) pushOperation(metadata)
  } catch {
    // ignore malformed headers
  }
  try {
    const warningRaw = res.headers.get('x-om-partial-index')
    if (warningRaw) {
      const parsed = JSON.parse(warningRaw) as Record<string, unknown>
      if (parsed && typeof parsed === 'object' && parsed.type === 'partial_index') {
        const entity = typeof parsed.entity === 'string' ? parsed.entity : String(parsed.entity ?? '')
        if (entity) {
          const baseCount = typeof parsed.baseCount === 'number' ? parsed.baseCount : null
          const indexedCount = typeof parsed.indexedCount === 'number' ? parsed.indexedCount : null
          const scope = parsed.scope === 'global' ? 'global' : 'scoped'
          const entityLabel =
            typeof parsed.entityLabel === 'string' && parsed.entityLabel.trim()
              ? parsed.entityLabel.trim()
              : entity
          pushPartialIndexWarning({ entity, entityLabel, baseCount, indexedCount, scope })
        }
      }
    }
  } catch {
    // ignore malformed headers
  }
  return res
}
