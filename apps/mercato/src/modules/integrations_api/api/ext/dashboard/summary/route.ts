import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  path: '/ext/dashboard/summary',
  GET: { requireAuth: true, requireFeatures: ['integrations_api.access'] },
}

export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const w = { tenant_id: auth.tenantId, organization_id: auth.orgId }

    const [cs] = await knex('customer_entities').where(w).whereNull('deleted_at').select(
      knex.raw('count(*) as total'),
      knex.raw('count(*) filter (where created_at >= ?) as last_30', [thirtyDaysAgo]),
      knex.raw('count(*) filter (where created_at >= ?) as last_7', [sevenDaysAgo]),
    )

    const [ds] = await knex('customer_deals').where(w).whereNull('deleted_at').select(
      knex.raw('count(*) as total'),
      knex.raw("count(*) filter (where status = 'open') as open"),
      knex.raw("coalesce(sum(value_amount) filter (where status = 'open'), 0) as pipeline_value"),
      knex.raw("count(*) filter (where status = 'win' and updated_at >= ?) as won_30", [thirtyDaysAgo]),
      knex.raw("coalesce(sum(value_amount) filter (where status = 'win' and updated_at >= ?), 0) as revenue_30", [thirtyDaysAgo]),
    )

    let lp = { total: 0, published: 0, views: 0, submissions: 0 }
    try {
      const [r] = await knex('landing_pages').where(w).whereNull('deleted_at').select(
        knex.raw('count(*) as total'),
        knex.raw("count(*) filter (where status = 'published') as published"),
        knex.raw('coalesce(sum(view_count), 0) as views'),
        knex.raw('coalesce(sum(submission_count), 0) as submissions'),
      )
      if (r) lp = { total: Number(r.total), published: Number(r.published), views: Number(r.views), submissions: Number(r.submissions) }
    } catch {}

    let em2 = { sent: 0, opened: 0, clicked: 0 }
    try {
      const [r] = await knex('email_messages').where(w).where('direction', 'outbound').where('created_at', '>=', thirtyDaysAgo).select(
        knex.raw('count(*) as sent'),
        knex.raw('count(*) filter (where opened_at is not null) as opened'),
        knex.raw('count(*) filter (where clicked_at is not null) as clicked'),
      )
      if (r) em2 = { sent: Number(r.sent), opened: Number(r.opened), clicked: Number(r.clicked) }
    } catch {}

    return NextResponse.json({
      ok: true,
      data: {
        contacts: { total: Number(cs?.total || 0), last30Days: Number(cs?.last_30 || 0), last7Days: Number(cs?.last_7 || 0) },
        deals: { total: Number(ds?.total || 0), open: Number(ds?.open || 0), pipelineValue: Number(ds?.pipeline_value || 0), wonLast30: Number(ds?.won_30 || 0), revenueLast30: Number(ds?.revenue_30 || 0) },
        landingPages: lp,
        email: em2,
      },
    })
  } catch (error) {
    console.error('[ext.dashboard.summary]', error)
    return NextResponse.json({ ok: false, error: 'Failed to get summary' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'External API', summary: 'Dashboard KPIs',
  methods: { GET: { summary: 'Dashboard KPI summary', tags: ['External API'] } },
}
