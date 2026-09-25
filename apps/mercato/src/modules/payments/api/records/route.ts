import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { decryptRowsForDisplay } from '@/modules/customers/lib/display-decrypt'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['payments.view'] },
}

export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const url = new URL(req.url)

    const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 25))
    const status = url.searchParams.get('status')

    let query = knex('payment_records as pr')
      .select(
        'pr.id', 'pr.invoice_id', 'pr.contact_id', 'pr.amount', 'pr.currency',
        'pr.status', 'pr.stripe_checkout_session_id', 'pr.stripe_payment_intent_id',
        'pr.stripe_subscription_id', 'pr.refunded_amount',
        'pr.metadata', 'pr.created_at',
        'ce.display_name as contact_name',
        'inv.invoice_number',
      )
      .leftJoin('customer_entities as ce', function () {
        this.on('ce.id', '=', 'pr.contact_id').andOnNull('ce.deleted_at')
      })
      .leftJoin('invoices as inv', 'inv.id', 'pr.invoice_id')
      .where('pr.organization_id', auth.orgId)

    if (status && status !== 'all') {
      if (status === 'refunded') {
        query = query.whereIn('pr.status', ['refunded', 'partially_refunded'])
      } else {
        query = query.where('pr.status', status)
      }
    }

    // Get total count for pagination
    const countQuery = knex('payment_records')
      .where('organization_id', auth.orgId)
    if (status && status !== 'all') {
      if (status === 'refunded') {
        countQuery.whereIn('status', ['refunded', 'partially_refunded'])
      } else {
        countQuery.where('status', status)
      }
    }
    const [{ count }] = await countQuery.count()

    const records = await query
      .orderBy('pr.created_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
    // Joined contact name is encrypted at rest; this raw read skips the subscriber.
    await decryptRowsForDisplay(em, CONTACT_ENTITY_KEY, records, { contact_name: 'display_name' }, auth.tenantId, auth.orgId)

    // Parse metadata and build display-friendly records
    const enriched = records.map((r: any) => {
      let meta = r.metadata
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta) } catch { meta = {} }
      }
      // Build Stripe dashboard link
      let stripeUrl: string | null = null
      if (r.stripe_checkout_session_id) {
        stripeUrl = `https://dashboard.stripe.com/test/payments/${r.stripe_payment_intent_id || r.stripe_checkout_session_id}`
      }
      return {
        ...r,
        metadata: meta,
        contact_name: r.contact_name || meta?.customerName || meta?.customerEmail || null,
        stripe_url: stripeUrl,
      }
    })

    return NextResponse.json({
      ok: true,
      data: enriched,
      pagination: { page, pageSize, total: Number(count) },
    })
  } catch (error) {
    console.error('[payments.records.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Payments', summary: 'Payment Records',
  methods: {
    GET: { summary: 'List payment records (history)', tags: ['Payments'] },
  },
}
