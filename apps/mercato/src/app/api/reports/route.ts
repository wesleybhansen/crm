import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const w = { tenant_id: auth.tenantId, organization_id: auth.orgId }

    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000)

    // Pipeline by stage
    const pipelineByStage = await knex('customer_deals')
      .where(w).whereNull('deleted_at')
      .groupBy('pipeline_stage')
      .select('pipeline_stage as stage')
      .count('* as count')
      .sum('value_amount as value')
      .orderBy('count', 'desc')

    // Deals won/lost last 30 days
    const [dealOutcomes] = await knex('customer_deals').where(w).whereNull('deleted_at')
      .where('updated_at', '>=', thirtyDaysAgo)
      .select(
        knex.raw("count(*) filter (where status = 'win') as won"),
        knex.raw("count(*) filter (where status = 'lose' or status = 'lost') as lost"),
        knex.raw("coalesce(sum(value_amount) filter (where status = 'win'), 0) as revenue"),
      )

    // Contacts by source
    const contactsBySource = await knex('customer_entities')
      .where(w).whereNull('deleted_at')
      .whereNotNull('source')
      .groupBy('source')
      .select('source')
      .count('* as count')
      .orderBy('count', 'desc')
      .limit(10)

    // Contacts over time (last 30 days, grouped by day)
    const contactsOverTime = await knex('customer_entities')
      .where(w).whereNull('deleted_at')
      .where('created_at', '>=', thirtyDaysAgo)
      .select(knex.raw("date_trunc('day', created_at) as day"))
      .count('* as count')
      .groupBy('day')
      .orderBy('day')

    // Landing page performance
    const landingPagePerf = await knex('landing_pages')
      .where(w).whereNull('deleted_at')
      .where('status', 'published')
      .select('title', 'view_count', 'submission_count')
      .orderBy('view_count', 'desc')
      .limit(10)

    // Revenue from payments
    let paymentRevenue = { total: 0, thisMonth: 0, lastMonth: 0 }
    try {
      const [rev] = await knex('payment_records')
        .where('organization_id', auth.orgId)
        .where('status', 'succeeded')
        .select(
          knex.raw('coalesce(sum(amount), 0) as total'),
          knex.raw('coalesce(sum(amount) filter (where created_at >= ?), 0) as this_month', [thirtyDaysAgo]),
          knex.raw('coalesce(sum(amount) filter (where created_at >= ? and created_at < ?), 0) as last_month', [sixtyDaysAgo, thirtyDaysAgo]),
        )
      if (rev) paymentRevenue = { total: Number(rev.total), thisMonth: Number(rev.this_month), lastMonth: Number(rev.last_month) }
    } catch {}

    // Bookings count
    let bookingStats = { upcoming: 0, thisMonth: 0 }
    try {
      const [bs] = await knex('bookings')
        .where('organization_id', auth.orgId)
        .select(
          knex.raw("count(*) filter (where start_time >= now() and status = 'confirmed') as upcoming"),
          knex.raw("count(*) filter (where created_at >= ?) as this_month", [thirtyDaysAgo]),
        )
      if (bs) bookingStats = { upcoming: Number(bs.upcoming), thisMonth: Number(bs.this_month) }
    } catch {}

    return NextResponse.json({
      ok: true,
      data: {
        pipelineByStage,
        dealOutcomes: { won: Number(dealOutcomes?.won || 0), lost: Number(dealOutcomes?.lost || 0), revenue: Number(dealOutcomes?.revenue || 0) },
        contactsBySource,
        contactsOverTime,
        landingPagePerf,
        paymentRevenue,
        bookingStats,
      },
    })
  } catch (error) {
    console.error('[reports]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
