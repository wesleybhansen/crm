import { matchPublicSandboxEndpoint } from './public-surface'

/**
 * Cross-site request forgery guard for cookie-authenticated API writes
 * (security sweep 2026-09-25, high finding 2).
 *
 * The CRM session cookies are SameSite=Lax, and browsers treat every
 * *.noliai.com host as the same site, so a page on any noliai.com host could
 * make the visitor's browser send a CRM write with their cookies attached
 * (a `text/plain` no-cors POST needs no preflight). The handlers read the body
 * with req.json() whatever its declared type, so that write worked.
 *
 * Rule, for POST/PUT/PATCH/DELETE on /api/* that carry a session cookie:
 *  1. the request must come from the CRM's own origin: `Origin` is one of
 *     allowedOrigins(), or `Sec-Fetch-Site: same-origin`. A request with
 *     neither header is not from a browser (curl, server-to-server), so it
 *     cannot be a forged browser request and is allowed;
 *  2. the body must be declared `application/json` or `multipart/form-data`
 *     (uploads), or be empty. `text/plain` and url-encoded bodies are exactly
 *     the types a cross-site page can send without a CORS preflight.
 *
 * Exempt: requests with no session cookie (bearer tokens, API keys, MCP,
 * shared-secret internal calls, webhooks and cron carry none, and a
 * cookie-less request has no session to ride), `/api/<module>/internal/*`,
 * inbound webhooks, cron, SSO callbacks, and the public endpoints sandboxed
 * customer pages call (PUBLIC_SANDBOX_ENDPOINTS, which use no session).
 *
 * Pure and Edge-safe: the proxy and the [...slug] dispatcher both call it.
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Cookies that authenticate a request somewhere in the CRM. */
const SESSION_COOKIE_NAMES = new Set([
  '__session', // Clerk (also __session_<suffix>)
  'auth_token', // legacy staff JWT
  'session_token', // legacy staff refresh token
  'customer_auth_token', // customer portal
  'customer_session_token', // customer portal refresh
  'course_session', // course student area
])

export function hasSessionCookie(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    const name = (eq === -1 ? part : part.slice(0, eq)).trim()
    if (!name) continue
    if (SESSION_COOKIE_NAMES.has(name) || name.startsWith('__session_')) {
      const value = eq === -1 ? '' : part.slice(eq + 1).trim()
      if (value) return true
    }
  }
  return false
}

function segments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean)
}

/** Paths that are authenticated by something other than a session cookie. */
export function isCsrfExemptPath(pathname: string, method: string): boolean {
  const parts = segments(pathname)
  if (parts[0] !== 'api') return true
  // Shared-secret service calls: /api/<module>/internal/...
  if (parts.includes('internal')) return true
  // Inbound provider webhooks (signature-verified): .../webhook or .../webhook/<x>
  if (parts.includes('webhook')) return true
  // Cron endpoints (CRON_SECRET): .../cron, .../<name>-cron
  if (parts.some((p) => p === 'cron' || p.endsWith('-cron'))) return true
  // SSO: identity providers POST the callback cross-site (form_post mode).
  if (parts[1] === 'sso' && parts[2] === 'callback') return true
  // Meta's data-deletion callback is a server-to-server POST.
  if (pathname === '/api/gtm/threads-callback') return true
  const publicEndpoint = matchPublicSandboxEndpoint(pathname)
  if (publicEndpoint && !publicEndpoint.usesSession && publicEndpoint.methods.includes(method.toUpperCase())) return true
  return false
}

function originOf(value: string | undefined | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin
  } catch {
    return null
  }
}

export type CsrfEnv = {
  APP_URL?: string
  NEXT_PUBLIC_APP_URL?: string
  NODE_ENV?: string
}

/** Origins allowed to make cookie-authenticated writes. */
export function allowedOrigins(env: CsrfEnv = process.env as CsrfEnv): Set<string> {
  const out = new Set<string>(['https://crm.noliai.com'])
  for (const candidate of [env.APP_URL, env.NEXT_PUBLIC_APP_URL]) {
    const origin = originOf(candidate)
    if (origin) out.add(origin)
  }
  return out
}

function isLocalDevOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  } catch {
    return false
  }
}

export type CsrfInput = {
  method: string
  pathname: string
  headers: Pick<Headers, 'get'>
}

export type CsrfVerdict =
  | { ok: true }
  | { ok: false; status: 403 | 415; reason: 'cross-origin' | 'content-type' }

const ALLOWED_BODY_TYPES = new Set(['application/json', 'multipart/form-data'])

function hasBody(headers: Pick<Headers, 'get'>): boolean {
  const length = headers.get('content-length')
  if (length !== null) return Number(length) > 0
  return headers.get('transfer-encoding') !== null
}

export function evaluateCsrf(input: CsrfInput, env: CsrfEnv = process.env as CsrfEnv): CsrfVerdict {
  const method = input.method.toUpperCase()
  if (!MUTATING_METHODS.has(method)) return { ok: true }
  if (!input.pathname.startsWith('/api/')) return { ok: true }
  if (!hasSessionCookie(input.headers.get('cookie'))) return { ok: true }
  if (isCsrfExemptPath(input.pathname, method)) return { ok: true }

  const origin = input.headers.get('origin')
  const fetchSite = input.headers.get('sec-fetch-site')
  let sameOrigin = false
  if (origin && origin !== 'null') {
    const allowed = allowedOrigins(env)
    sameOrigin = allowed.has(origin) || (env.NODE_ENV !== 'production' && isLocalDevOrigin(origin))
  }
  if (!sameOrigin && fetchSite === 'same-origin') sameOrigin = true
  // Neither header: not a browser request, so not a forged one.
  if (!sameOrigin && !origin && !fetchSite) sameOrigin = true
  if (!sameOrigin) return { ok: false, status: 403, reason: 'cross-origin' }

  const rawType = input.headers.get('content-type')
  const baseType = rawType ? rawType.split(';')[0].trim().toLowerCase() : ''
  if (baseType) {
    if (ALLOWED_BODY_TYPES.has(baseType)) return { ok: true }
    // The sign-out buttons are plain HTML forms (url-encoded, no fields).
    if (baseType === 'application/x-www-form-urlencoded' && input.pathname === '/api/auth/logout') return { ok: true }
    return { ok: false, status: 415, reason: 'content-type' }
  }
  if (hasBody(input.headers)) return { ok: false, status: 415, reason: 'content-type' }
  return { ok: true }
}

export function csrfErrorBody(verdict: Exclude<CsrfVerdict, { ok: true }>): { error: string } {
  return verdict.reason === 'cross-origin'
    ? { error: 'This request did not come from the CRM, so it was blocked.' }
    : { error: 'Send this request as JSON (Content-Type: application/json).' }
}
