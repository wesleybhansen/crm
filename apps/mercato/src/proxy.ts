import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import {
  applyBrowserSecurityHeaders,
  COMPANY_LEGAL_REDIRECTS,
  OWNED_BROWSER_APEX_DOMAINS,
  trailingSlashRedirectPath,
} from '@/lib/security-headers'

// Note: Do NOT import bootstrap here — proxy runs in Edge runtime which
// cannot use Node.js modules like MikroORM. Bootstrap is called in
// layout.tsx, which runs in Node.js runtime.
//
// Phase 1.4 (Clerk migration): clerkMiddleware annotates the request so
// downstream getAuthFromRequest can resolve the Clerk session. The
// dispatcher (`/api/[...slug]`) keeps owning per-route auth via its
// requireAuth metadata; this proxy only enforces redirect-to-sign-in
// for top-level page navigations.

const HUB_SIGN_IN_URL =
  process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL ?? 'https://app.noliai.com/sign-in'

// Pages that must NOT trigger a Clerk redirect:
//   - public token surfaces (validated by the token in the URL)
//   - legacy auth UI orphans (deleted in Phase G but still routable now)
//   (the root path is handled separately below: redirected to marketing or the app)
const isPublicPage = createRouteMatcher([
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/landing',
  '/terms',
  '/privacy',
])

function lpAppHost(): string {
  if (process.env.APP_HOST) return process.env.APP_HOST.toLowerCase().replace(/:\d+$/, '')
  try {
    if (process.env.APP_URL) return new URL(process.env.APP_URL).hostname.toLowerCase()
  } catch {}
  return 'crm.noliai.com'
}

function isOwnHost(host: string): boolean {
  if (!host) return true
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')) return true
  // IP literals (direct-to-box requests, health checks) keep default behavior
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return true
  if (host === lpAppHost()) return true
  for (const apex of OWNED_BROWSER_APEX_DOMAINS) {
    if (host === apex || host.endsWith(`.${apex}`)) return true
  }
  return false
}

function withBrowserSecurityHeaders<T extends Response>(
  response: T,
  pathname: string,
  includeHsts: boolean,
): T {
  applyBrowserSecurityHeaders(response.headers, pathname, { includeHsts })
  return response
}

export default clerkMiddleware(async (auth, req) => {
  // 0. Custom-domain landing pages: nginx passes the original Host through,
  //    so any host that isn't ours serves exactly one published landing page
  //    at '/' (rewritten to the public by-domain route) and 404s elsewhere.
  //    /api, /_next, and file assets never reach here (see config.matcher),
  //    so form submits on custom domains still work.
  const rawHost = req.headers.get('host') ?? req.headers.get('x-forwarded-host') ?? ''
  const customHost = rawHost.trim().toLowerCase().replace(/:\d+$/, '')
  const ownHost = isOwnHost(customHost)

  const canonicalPathname = trailingSlashRedirectPath(req.nextUrl.pathname)
  if (canonicalPathname) {
    const proto = req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(/:$/, '')
    const host = req.headers.get('host') ?? req.nextUrl.host
    return withBrowserSecurityHeaders(
      NextResponse.redirect(
        new URL(`${canonicalPathname}${req.nextUrl.search}`, `${proto}://${host}`),
        308,
      ),
      req.nextUrl.pathname,
      ownHost,
    )
  }

  const legalRedirect = COMPANY_LEGAL_REDIRECTS[req.nextUrl.pathname]
  if (legalRedirect) {
    const url = new URL(legalRedirect)
    url.search = req.nextUrl.search
    return withBrowserSecurityHeaders(
      NextResponse.redirect(url),
      req.nextUrl.pathname,
      ownHost,
    )
  }

  if (!ownHost) {
    if (req.nextUrl.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      const url = req.nextUrl.clone()
      url.pathname = '/api/landing_pages/public/by-domain'
      url.search = `?host=${encodeURIComponent(customHost)}&path=${encodeURIComponent('/')}`
      return withBrowserSecurityHeaders(NextResponse.rewrite(url), req.nextUrl.pathname, false)
    }
    // Unlike the standalone-middleware version, this proxy's matcher covers
    // /api — let API calls (the landing page's own form submit) through.
    if (!req.nextUrl.pathname.startsWith('/api/')) {
      return withBrowserSecurityHeaders(
        new NextResponse('Not found', { status: 404 }),
        req.nextUrl.pathname,
        false,
      )
    }
  }

  // 1. Root: the marketing page is the single source of truth at
  //    noliai.com/crm. The in-repo landing.html drifted from it, so we no
  //    longer serve a local copy. Logged-out visitors are redirected to the
  //    marketing page; signed-in users go straight to the CRM app.
  if (req.nextUrl.pathname === '/') {
    const { userId } = await auth()
    if (!userId) {
      return withBrowserSecurityHeaders(
        NextResponse.redirect(`https://noliai.com/crm${req.nextUrl.search}`),
        req.nextUrl.pathname,
        ownHost,
      )
    }
    // Reconstruct the public-facing origin (behind nginx, req.url reads as
    // http://0.0.0.0:3000) so the redirect lands on crm.noliai.com/backend.
    const proto = req.headers.get('x-forwarded-proto') ?? 'https'
    const host =
      req.headers.get('x-forwarded-host') ??
      req.headers.get('host') ??
      req.nextUrl.host
    return withBrowserSecurityHeaders(
      NextResponse.redirect(new URL('/backend', `${proto}://${host}`)),
      req.nextUrl.pathname,
      ownHost,
    )
  }

  // 2. Set x-next-url for server components (preserved from original).
  const requestHeaders = new Headers(req.headers)
  requestHeaders.set('x-next-url', req.nextUrl.pathname)
  const passThrough = NextResponse.next({ request: { headers: requestHeaders } })
  applyBrowserSecurityHeaders(passThrough.headers, req.nextUrl.pathname, { includeHsts: ownHost })

  // 3. Public-page allowlist — auth UI orphans and legal pages.
  if (isPublicPage(req)) return passThrough

  // 4. API routes: dispatcher's requireAuth metadata gates per-route via
  //    the Clerk-aware getAuthFromRequest. Don't enforce here.
  if (req.nextUrl.pathname.startsWith('/api/')) return passThrough

  // 5. MCP edge — separate container, API-key gated at nginx + service.
  if (req.nextUrl.pathname.startsWith('/mcp')) return passThrough

  // 6. Page navigations: enforce sign-in by bouncing unauthed visitors
  //    to the Noli hub. Hub is the single sign-in surface for the suite.
  const { userId } = await auth()
  if (!userId) {
    // Behind nginx, req.url reads as http://0.0.0.0:3000/... because Next's
    // standalone server doesn't trust the proxy's X-Forwarded-* headers by
    // default. Reconstruct the public-facing URL so the hub can redirect
    // back to the original CRM page after sign-in.
    const proto = req.headers.get('x-forwarded-proto') ?? 'https'
    const host =
      req.headers.get('x-forwarded-host') ??
      req.headers.get('host') ??
      req.nextUrl.host
    const publicUrl = `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`
    const signInUrl = new URL(HUB_SIGN_IN_URL)
    signInUrl.searchParams.set('redirect_url', publicUrl)
    return withBrowserSecurityHeaders(
      NextResponse.redirect(signInUrl),
      req.nextUrl.pathname,
      ownHost,
    )
  }

  return passThrough
})

export const config = {
  matcher: [
    // Skip Next internals and static assets, but otherwise cover everything
    // so clerkMiddleware can annotate every request and getAuthFromRequest
    // sees the Clerk session.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
