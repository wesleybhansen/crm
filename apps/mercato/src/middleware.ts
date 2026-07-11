import { NextResponse, type NextRequest } from 'next/server'

/**
 * Custom-domain routing for published landing pages.
 *
 * nginx passes the original Host header through ($host) and proxies every
 * hostname to this app, so the middleware can route by Host:
 *  - requests on our own hosts (the app host, *.noliai.com,
 *    *.thelaunchpadincubator.com, localhost, IP literals) pass through
 *  - GET requests to '/' on any other host are rewritten to the public
 *    by-domain landing page route
 *  - every other path on a custom host gets a 404 (custom domains serve
 *    exactly one landing page; /api, /_next, and static files are excluded
 *    by the matcher so form submits on custom domains still work)
 */

const OWN_APEX_DOMAINS = ['noliai.com', 'thelaunchpadincubator.com']

function appHost(): string {
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
  if (host === appHost()) return true
  for (const apex of OWN_APEX_DOMAINS) {
    if (host === apex || host.endsWith(`.${apex}`)) return true
  }
  return false
}

export function middleware(req: NextRequest) {
  const rawHost = req.headers.get('host') ?? ''
  const host = rawHost.trim().toLowerCase().replace(/:\d+$/, '')

  if (isOwnHost(host)) return NextResponse.next()

  const { pathname } = req.nextUrl
  if (pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
    const url = req.nextUrl.clone()
    url.pathname = '/api/landing_pages/public/by-domain'
    url.search = `?host=${encodeURIComponent(host)}&path=${encodeURIComponent(pathname)}`
    return NextResponse.rewrite(url)
  }

  // Custom domains serve a single landing page at the root only.
  return new NextResponse('Not found', { status: 404 })
}

export const config = {
  // Exclude /api (form submits and the rewrite target itself), Next internals,
  // and anything with a file extension (static assets).
  matcher: ['/((?!api/|_next/|favicon\\.ico|.*\\..*).*)'],
}
