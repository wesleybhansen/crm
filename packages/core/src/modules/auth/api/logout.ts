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
  // bounce the user to the Noli hub instead of /login (which still renders
  // the legacy Mercato sign-in form during the Phase G transition window).
  // Full Clerk sign-out across .noliai.com is a hub responsibility — until
  // the hub gets a /sign-out route that calls Clerk's signOut(), users
  // with a live Clerk session will land on the hub launcher signed in.
  // The legacy Mercato JWT cookies cleared below are now inert anyway
  // because getAuthFromRequest tries Clerk first.
  const target = process.env.CLERK_SECRET_KEY
    ? (process.env.NEXT_PUBLIC_HUB_URL ?? 'https://app.noliai.com')
    : toAbsoluteUrl(req, '/login')
  const res = NextResponse.redirect(target)
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
