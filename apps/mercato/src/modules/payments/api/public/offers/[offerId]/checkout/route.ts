// ORM-SKIP: checkout_offers and landing_page_checkouts are raw-knex tables
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { getClientIp } from '@open-mercato/shared/lib/ratelimit/helpers'
import { createOfferCheckout, platformStripe } from '../../../../../services/public-checkout'

/*
 * Public checkout for an offer (checkout_offers). Called by marketing pages
 * (AMS on pages.noliai.com or a business's own domain, CRM pages running
 * sandboxed in an opaque origin): the request arrives cross-origin, maybe
 * with `Origin: null`, never with credentials; the dispatcher answers CORS
 * for this path (PUBLIC_SANDBOX_ENDPOINTS in src/lib/public-surface.ts).
 *
 * Body: { requestId, email?, name?, returnUrl, cancelUrl?, pageRef? }.
 * returnUrl (and cancelUrl) must be https on one of the offer's
 * success_url_hosts. The price, product and seller come from the offer.
 * Answer: { ok: true, url } -> the page navigates itself to url (Stripe
 * Checkout on the business's own connected account).
 */
export const metadata = {
  POST: { requireAuth: false, rateLimit: { points: 20, duration: 600, blockDuration: 600, keyPrefix: 'offer-public-checkout' } },
}

const MAX_BODY_BYTES = 8 * 1024

export async function POST(req: Request, { params }: { params: { offerId: string } | Promise<{ offerId: string }> }) {
  try {
    const { offerId } = await params
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
    const result = await createOfferCheckout(
      {
        knex,
        stripe: await platformStripe(),
        appUrl: (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/, ''),
      },
      { offerId: String(offerId || ''), ip: getClientIp(req, 1) ?? 'unknown', body },
    )
    return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[payments.public.offer-checkout] failed', error)
    return NextResponse.json({ ok: false, error: 'Checkout is unavailable right now. Please try again in a moment.' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Payments (Public)',
  summary: 'Start checkout for an offer',
  methods: {
    POST: {
      summary: "Start a Stripe Checkout for an offer on the business's own Stripe account; returns { url }",
      tags: ['Payments (Public)'],
    },
  },
}
