import { NextResponse } from 'next/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { toAbsoluteUrl } from '@open-mercato/shared/lib/url'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { AuthService } from '@open-mercato/core/modules/auth/services/authService'

function parseCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get('cookie') || ''
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'))
  return m ? decodeURIComponent(m[1]) : null
}

export async function POST(req: Request) {
  const sessToken = parseCookie(req, 'session_token')
  if (sessToken) {
    try { const c = await createRequestContainer(); const auth = c.resolve<AuthService>('authService'); await auth.deleteSessionByToken(sessToken) } catch {}
  }
  // Post-Phase-1.4 (Clerk migration): when CLERK_SECRET_KEY is configured,
  // route through the hub's /sign-out endpoint which calls Clerk's
  // signOut() to clear the .noliai.com cookie + session row, then
  // redirects the browser to the marketing site. Without this hop,
  // clearing only the Mercato JWT cookies below would leave the user
  // technically still signed in to the suite (Clerk session intact).
  const hubUrl = process.env.NEXT_PUBLIC_HUB_URL ?? 'https://app.noliai.com'
  const target = process.env.CLERK_SECRET_KEY
    ? `${hubUrl}/sign-out`
    : toAbsoluteUrl(req, '/login')
  // 303 (See Other) forces the browser to change method to GET on the
  // redirect. NextResponse.redirect defaults to 307, which preserves the
  // POST method from the form submission — that POSTs to /sign-out on the
  // hub, which then triggers Clerk's cross-origin handshake with a POST,
  // and Clerk's handshake endpoint rejects with 405. The form-submission
  // → navigation pattern is exactly what 303 was designed for.
  const res = NextResponse.redirect(target, 303)
  res.cookies.set('auth_token', '', { path: '/', maxAge: 0 })
  res.cookies.set('session_token', '', { path: '/', maxAge: 0 })
  return res
}

export async function GET(req: Request) {
  return POST(req)
}

export const metadata = {
  GET: { requireAuth: true },
  POST: { requireAuth: true },
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Authentication & Accounts',
  summary: 'Log out current session',
  methods: {
    POST: {
      summary: 'Invalidate session and redirect',
      description: 'Clears authentication cookies and redirects the browser to the login page.',
      responses: [
        { status: 302, description: 'Redirect to login after successful logout', mediaType: 'text/html' },
      ],
    },
    GET: {
      summary: 'Log out (legacy GET)',
      description: 'For convenience, the GET variant performs the same logout logic as POST and issues a redirect.',
      responses: [
        { status: 302, description: 'Redirect to login after successful logout', mediaType: 'text/html' },
      ],
    },
  },
}
