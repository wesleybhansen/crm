// ORM-SKIP: landing_page_checkouts, products, courses and stripe_connections are raw-knex tables
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { getClientIp } from '@open-mercato/shared/lib/ratelimit/helpers'
import { createLandingPageCheckout, platformStripe } from '../../../../../payments/services/public-checkout'

/*
 * Public checkout for a published CRM wizard landing page (transition: pages
 * built elsewhere sell through offers, POST /api/payments/public/offers/{id}/checkout,
 * which shares this core). Called by the page itself,
 * which runs sandboxed in an opaque origin: the request arrives with
 * `Origin: null` and no cookies, and the dispatcher answers CORS for this path
 * (PUBLIC_SANDBOX_ENDPOINTS in src/lib/public-surface.ts), never with
 * credentials. The body names the product only to select it; the price and
 * seller come from the page configuration. See
 * payments/services/public-checkout.ts. Answer: { ok: true, url }.
 */
export const metadata = {
  POST: { requireAuth: false, rateLimit: { points: 20, duration: 600, blockDuration: 600, keyPrefix: 'landing-public-checkout' } },
}

const MAX_BODY_BYTES = 8 * 1024

export async function POST(req: Request, { params }: { params: { slug: string } | Promise<{ slug: string }> }) {
  try {
    const { slug } = await params
    const raw = await req.text()
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: 'Request too large' }, { status: 413 })
    }
    let body: unknown = {}
    if (raw.trim()) {
      try {
        body = JSON.parse(raw)
      } catch {
        return NextResponse.json({ ok: false, error: 'Invalid request' }, { status: 400 })
      }
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const result = await createLandingPageCheckout(
      {
        knex,
        stripe: await platformStripe(),
        appUrl: (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/, ''),
      },
      { slug: String(slug || ''), ip: getClientIp(req, 1) ?? 'unknown', body },
    )
    return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[landing_pages.public.checkout] failed', error)
    return NextResponse.json({ ok: false, error: 'Checkout is unavailable right now. Please try again in a moment.' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Landing Pages (Public)',
  summary: 'Start checkout',
  methods: {
    POST: {
      summary: "Start a Stripe Checkout for the page's configured product on the business's own Stripe account",
      tags: ['Landing Pages (Public)'],
    },
  },
}
