import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

/* Marketing revenue attribution for the Noli AMS: how much Stripe revenue
 * (payment_records, checkout.session.completed) came from contacts the AMS
 * pushed in — matched via payment_records.contact_id → customer_entities and
 * the AMS source prefixes on the contact. Called by the AMS dashboard with
 * the org's provisioned integration key, so tenant scoping is automatic. */

export const metadata = {
  path: '/ext/marketing/revenue',
  GET: { requireAuth: true, requireFeatures: ['integrations_api.access'] },
}

const AMS_SOURCE_PREFIXES = ['ams:%', 'landing_page:%', 'lead_magnet:%', 'blog-ops%', 'chat_widget%']

export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const url = new URL(req.url)
    const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10) || 30))
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const sourceFilter = (qb: any) => {
      qb.where((inner: any) => {
        for (const prefix of AMS_SOURCE_PREFIXES) inner.orWhere('ce.source', 'like', prefix)
      })
    }

    const [totals] = await knex('payment_records as pr')
      .join('customer_entities as ce', 'ce.id', 'pr.contact_id')
      .where('pr.organization_id', auth.orgId)
      .where('pr.status', 'succeeded')
      .where('pr.created_at', '>=', since)
      .whereNull('ce.deleted_at')
      .modify(sourceFilter)
      .select(
        knex.raw('coalesce(sum(pr.amount), 0) as revenue'),
        knex.raw('count(*) as payments'),
        knex.raw('count(distinct pr.contact_id) as paying_contacts'),
      )

    const bySource = await knex('payment_records as pr')
      .join('customer_entities as ce', 'ce.id', 'pr.contact_id')
      .where('pr.organization_id', auth.orgId)
      .where('pr.status', 'succeeded')
      .where('pr.created_at', '>=', since)
      .whereNull('ce.deleted_at')
      .modify(sourceFilter)
      .groupBy('ce.source')
      .orderByRaw('sum(pr.amount) desc')
      .limit(8)
      .select('ce.source', knex.raw('coalesce(sum(pr.amount), 0) as revenue'), knex.raw('count(*) as payments'))

    const [contacts] = await knex('customer_entities as ce')
      .where('ce.organization_id', auth.orgId)
      .whereNull('ce.deleted_at')
      .where('ce.created_at', '>=', since)
      .modify(sourceFilter)
      .select(knex.raw('count(*) as new_contacts'))

    return NextResponse.json({
      ok: true,
      data: {
        days,
        revenue: Number(totals?.revenue ?? 0),
        payments: Number(totals?.payments ?? 0),
        payingContacts: Number(totals?.paying_contacts ?? 0),
        newContacts: Number(contacts?.new_contacts ?? 0),
        bySource: (bySource ?? []).map((r: any) => ({
          source: r.source,
          revenue: Number(r.revenue ?? 0),
          payments: Number(r.payments ?? 0),
        })),
      },
    })
  } catch (error) {
    console.error('[ext.marketing.revenue]', error)
    return NextResponse.json({ ok: false, error: 'Failed to compute marketing revenue' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'External API',
  summary: 'Marketing-attributed Stripe revenue (AMS-sourced contacts)',
}
