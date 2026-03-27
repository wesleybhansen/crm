import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

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

    await knex('landing_pages').where('id', page.id).increment('view_count', 1)

    // Inject UTM capture script before </body> to populate hidden form fields
    const utmCaptureScript = `<script>(function(){try{var p=new URLSearchParams(window.location.search);var u=['utm_source','utm_medium','utm_campaign','utm_content','utm_term'];var r=document.referrer||'';document.querySelectorAll('form').forEach(function(f){u.forEach(function(k){var v=p.get(k);if(v){var h=document.createElement('input');h.type='hidden';h.name='_'+k;h.value=v;f.appendChild(h)}});if(r){var rh=document.createElement('input');rh.type='hidden';rh.name='_referrer';rh.value=r;f.appendChild(rh)}})}catch(e){}})()</script>`
    const htmlWithUtm = page.published_html.includes('</body>')
      ? page.published_html.replace('</body>', utmCaptureScript + '</body>')
      : page.published_html + utmCaptureScript

    return new NextResponse(htmlWithUtm, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
    })
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
