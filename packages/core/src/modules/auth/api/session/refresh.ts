import { NextResponse } from 'next/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { toAbsoluteUrl } from '@open-mercato/shared/lib/url'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { AuthService } from '@open-mercato/core/modules/auth/services/authService'
import { signJwt } from '@open-mercato/shared/lib/auth/jwt'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { refreshSessionRequestSchema } from '@open-mercato/core/modules/auth/data/validators'
import { checkAuthRateLimit } from '@open-mercato/core/modules/auth/lib/rateLimitCheck'
import { readEndpointRateLimitConfig } from '@open-mercato/shared/lib/ratelimit/config'
import { rateLimitErrorSchema } from '@open-mercato/shared/lib/ratelimit/helpers'
import { z } from 'zod'

const refreshRateLimitConfig = readEndpointRateLimitConfig('REFRESH', {
  points: 15, duration: 60, blockDuration: 60, keyPrefix: 'refresh',
})
const refreshIpRateLimitConfig = readEndpointRateLimitConfig('REFRESH_IP', {
  points: 60, duration: 60, blockDuration: 60, keyPrefix: 'refresh-ip',
})

function parseCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get('cookie') || ''
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'))
  return m ? decodeURIComponent(m[1]) : null
}

function sanitizeRedirect(param: string | null, baseUrl: string): string {
  const value = param || '/'
  try {
    const base = new URL(baseUrl)
    const resolved = new URL(value, baseUrl)
    if (resolved.origin === base.origin && resolved.pathname.startsWith('/')) {
      return resolved.pathname + resolved.search + resolved.hash
    }
  } catch {}
  return '/'
}

function reconnectingPage(retryUrl: string): Response {
  // A temporary failure (database down, timeout) is not a sign-out. Show a
  // small page that retries on its own instead of the sign-in screen.
  const safeUrl = retryUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5;url=${safeUrl}">
<title>Reconnecting | Noli CRM</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px;background:#fafafa;color:#111}
main{max-width:420px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#555;line-height:1.5;margin:0 0 16px}
a{display:inline-block;min-height:40px;line-height:40px;padding:0 16px;border-radius:8px;background:#111;color:#fff;text-decoration:none}</style>
</head><body><main><h1>Reconnecting&hellip;</h1>
<p>We're having trouble reaching the server. You're still signed in. This page will try again in a few seconds.</p>
<a href="${safeUrl}">Try again now</a></main></body></html>`
  return new Response(html, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5', 'cache-control': 'no-store' },
  })
}

async function signedOutRedirect(req: Request, redirectTo: string): Promise<Response> {
  const { isHubSignInEnabled, buildHubSignInUrl } = await import('@open-mercato/shared/lib/auth/errors')
  // Noli signs people in on the hub. The legacy /login page is only for
  // deployments without Clerk (local dev, tests).
  if (isHubSignInEnabled()) {
    return NextResponse.redirect(buildHubSignInUrl(toAbsoluteUrl(req, redirectTo)))
  }
  return NextResponse.redirect(toAbsoluteUrl(req, '/login?redirect=' + encodeURIComponent(redirectTo)))
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const baseUrl = process.env.APP_URL || `${url.protocol}//${url.host}`
  const redirectTo = sanitizeRedirect(url.searchParams.get('redirect'), baseUrl)
  const retryUrl = toAbsoluteUrl(req, '/api/auth/session/refresh?redirect=' + encodeURIComponent(redirectTo))

  // 1. Legacy session_token cookie (pre-Clerk sessions).
  const token = parseCookie(req, 'session_token')
  if (token) {
    try {
      const c = await createRequestContainer()
      const auth = c.resolve<AuthService>('authService')
      const ctx = await auth.refreshFromSessionToken(token)
      if (ctx) {
        const { user, roles } = ctx
        const jwt = signJwt({ sub: String(user.id), tenantId: String(user.tenantId), orgId: String(user.organizationId), email: user.email, roles })
        const res = NextResponse.redirect(toAbsoluteUrl(req, redirectTo))
        res.cookies.set('auth_token', jwt, { httpOnly: true, path: '/', sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 8 })
        return res
      }
    } catch (error) {
      console.error('[auth/session/refresh] session refresh failed, showing reconnecting page:', error)
      return reconnectingPage(retryUrl)
    }
  }

  // 2. Clerk session (the normal Noli path). Tell a real sign-out apart
  //    from a temporary failure before sending anyone to sign in.
  const { resolveAuthFromRequest } = await import('@open-mercato/shared/lib/auth/server')
  const resolution = await resolveAuthFromRequest(req)
  if (resolution.status === 'authenticated') {
    return NextResponse.redirect(toAbsoluteUrl(req, redirectTo))
  }
  if (resolution.status === 'unavailable') {
    return reconnectingPage(retryUrl)
  }
  if (resolution.status === 'no-access') {
    const { buildHubHomeUrl } = await import('@open-mercato/shared/lib/auth/errors')
    return NextResponse.redirect(buildHubHomeUrl())
  }
  return signedOutRedirect(req, redirectTo)
}

export async function POST(req: Request) {
  const { translate } = await resolveTranslations()
  let token: string | null = null

  try {
    const body = await req.json()
    const parsed = refreshSessionRequestSchema.safeParse(body)
    if (parsed.success) {
      token = parsed.data.refreshToken
    }
  } catch {
    // Invalid JSON
  }

  const { error: rateLimitError } = await checkAuthRateLimit({
    req,
    ipConfig: refreshIpRateLimitConfig,
    compoundConfig: refreshRateLimitConfig,
    compoundIdentifier: token ?? undefined,
  })
  if (rateLimitError) return rateLimitError

  if (!token) {
    return NextResponse.json({
      ok: false,
      error: translate('auth.session.refresh.errors.invalidPayload', 'Missing or invalid refresh token'),
    }, { status: 400 })
  }

  const c = await createRequestContainer()
  const auth = c.resolve<AuthService>('authService')
  const ctx = await auth.refreshFromSessionToken(token)

  if (!ctx) {
    return NextResponse.json({
      ok: false,
      error: translate('auth.session.refresh.errors.invalidToken', 'Invalid or expired refresh token'),
    }, { status: 401 })
  }

  const { user, roles } = ctx
  const jwt = signJwt({
    sub: String(user.id),
    tenantId: String(user.tenantId),
    orgId: String(user.organizationId),
    email: user.email,
    roles,
  })

  const res = NextResponse.json({
    ok: true,
    accessToken: jwt,
    expiresIn: 60 * 60 * 8,
  })

  res.cookies.set('auth_token', jwt, {
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 8,
  })

  return res
}

export const metadata = {
  GET: { requireAuth: false },
  POST: { requireAuth: false },
}

const refreshQuerySchema = z.object({
  redirect: z.string().optional().describe('Absolute or relative URL to redirect after refresh'),
})

const refreshSuccessSchema = z.object({
  ok: z.literal(true),
  accessToken: z.string().describe('New JWT access token'),
  expiresIn: z.number().describe('Token expiration time in seconds'),
})

const refreshErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'Authentication & Accounts',
  summary: 'Refresh session token',
  methods: {
    GET: {
      summary: 'Refresh auth cookie from session token (browser)',
      description: 'Exchanges an existing `session_token` cookie for a fresh JWT auth cookie and redirects the browser.',
      query: refreshQuerySchema,
      responses: [
        { status: 302, description: 'Redirect to target location when session is valid, or to sign in when it is not', mediaType: 'text/html' },
        { status: 503, description: 'Sign-in could not be checked right now; a self-retrying page is returned', mediaType: 'text/html' },
      ],
    },
    POST: {
      summary: 'Refresh access token (API/mobile)',
      description: 'Exchanges a refresh token for a new JWT access token. Pass the refresh token obtained from login in the request body.',
      requestBody: { schema: refreshSessionRequestSchema, contentType: 'application/json' },
      responses: [
        { status: 200, description: 'New access token issued', schema: refreshSuccessSchema },
      ],
      errors: [
        { status: 400, description: 'Missing refresh token', schema: refreshErrorSchema },
        { status: 401, description: 'Invalid or expired token', schema: refreshErrorSchema },
        { status: 429, description: 'Too many refresh attempts', schema: rateLimitErrorSchema },
      ],
    },
  },
}
