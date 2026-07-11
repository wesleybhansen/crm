import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { servePublishedLandingPage } from '../../../services/public-serving'

export const metadata = {
  GET: { requireAuth: false },
}

/** Lowercase, strip port; returns '' when the value is not a plausible hostname. */
function normalizeHost(raw: string | null): string {
  if (!raw) return ''
  const host = raw.trim().toLowerCase().replace(/:\d+$/, '')
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return ''
  return host
}

/** Hosts that belong to us and must never resolve to a tenant landing page. */
function isReservedHost(host: string): boolean {
  if (!host || host === 'localhost' || host === '127.0.0.1') return true
  const appHost = (() => {
    if (process.env.APP_HOST) return process.env.APP_HOST.toLowerCase().replace(/:\d+$/, '')
    try {
      if (process.env.APP_URL) return new URL(process.env.APP_URL).hostname.toLowerCase()
    } catch {}
    return 'crm.noliai.com'
  })()
  if (host === appHost) return true
  if (host === 'noliai.com' || host.endsWith('.noliai.com')) return true
  if (host === 'thelaunchpadincubator.com' || host.endsWith('.thelaunchpadincubator.com')) return true
  return false
}

// Served via the root middleware: GET requests to '/' on a custom domain are
// rewritten to /api/landing_pages/public/by-domain?host={host}&path=/
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const host = normalizeHost(url.searchParams.get('host'))
    if (!host || isReservedHost(host)) {
      return new NextResponse('<html><body><h1>Page not found</h1></body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } })
    }

    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const page = await knex('landing_pages')
      .whereRaw('lower(custom_domain) = ?', [host])
      .where('status', 'published')
      .whereNull('deleted_at')
      .first()

    if (!page || !page.published_html) {
      return new NextResponse('<html><body><h1>Page not found</h1></body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } })
    }

    return await servePublishedLandingPage(knex, page, req, { makeApiUrlsRelative: true })
  } catch (error) {
    console.error('[landing_pages.public.by-domain] failed', error)
    return new NextResponse('Server error', { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Landing Pages (Public)',
  summary: 'Serve published page by custom domain',
  methods: { GET: { summary: 'Serve published landing page by custom domain', tags: ['Landing Pages (Public)'] } },
}
