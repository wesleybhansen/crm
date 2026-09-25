// ORM-SKIP: checkout_offers and stripe_connections are raw-knex tables
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { listOffers } from '../../../../payments/services/checkout-offers'
import { connectedAccountFor } from '../../../../payments/services/public-checkout'

/*
 * The offers a marketing page may sell (org API key, like /ext/contacts).
 * The page builder shows these; a published page's buy button posts to each
 * offer's checkoutPath with a returnUrl on one of its successUrlHosts.
 * `paymentsConnected` says whether the business has connected Stripe (it does
 * not check with Stripe whether the account can take charges yet; the
 * checkout itself does).
 */
export const metadata = {
  path: '/ext/offers',
  GET: { requireAuth: true, requireFeatures: ['integrations_api.access'] },
}

export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const includeInactive = new URL(req.url).searchParams.get('includeInactive') === 'true'
    const scope = { organizationId: String(auth.orgId), tenantId: String(auth.tenantId) }
    const offers = await listOffers(knex, scope, { activeOnly: !includeInactive })
    const paymentsConnected = Boolean(await connectedAccountFor(knex, scope.organizationId))
    return NextResponse.json({
      ok: true,
      paymentsConnected,
      data: includeInactive ? offers : offers.filter((offer) => offer.sellable),
    })
  } catch (error) {
    console.error('[ext.offers.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load offers' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'External API',
  summary: 'Offers (external)',
  methods: {
    GET: { summary: 'List the checkout offers a page can sell', tags: ['External API'] },
  },
}
