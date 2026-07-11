import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { servePublishedLandingPage } from '../../../services/public-serving'

export const metadata = {
  GET: { requireAuth: false },
}

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const page = await knex('landing_pages')
      .where('slug', params.slug)
      .where('status', 'published')
      .whereNull('deleted_at')
      .first()

    if (!page || !page.published_html) {
      return new NextResponse('<html><body><h1>Page not found</h1></body></html>', { status: 404, headers: { 'Content-Type': 'text/html' } })
    }

    return await servePublishedLandingPage(knex, page, req)
  } catch (error) {
    console.error('[landing_pages.public.serve] failed', error)
    return new NextResponse('Server error', { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Landing Pages (Public)',
  summary: 'Serve published page',
  methods: { GET: { summary: 'Serve published landing page', tags: ['Landing Pages (Public)'] } },
}
