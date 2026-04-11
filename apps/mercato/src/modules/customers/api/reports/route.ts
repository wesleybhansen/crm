export const metadata = { path: '/reports', GET: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { query, queryOne } from '@/lib/db'

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const orgId = auth.orgId
    const tenantId = auth.tenantId
    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000)

    // Pipeline by stage
    const pipelineByStage = await query(
      `SELECT pipeline_stage as stage, count(*)::text as count, coalesce(sum(value_amount), 0)::text as value
       FROM customer_deals WHERE tenant_id = $1 AND organization_id = $2 AND deleted_at IS NULL
       GROUP BY pipeline_stage ORDER BY count DESC`,
      [tenantId, orgId]
    )

    // Deals won/lost last 30 days
    const dealOutcomesRow = await queryOne(
      `SELECT
        count(*) filter (where status = 'win')::int as won,
        count(*) filter (where status = 'lose' or status = 'lost')::int as lost,
        coalesce(sum(value_amount) filter (where status = 'win'), 0)::numeric as revenue
       FROM customer_deals WHERE tenant_id = $1 AND organization_id = $2 AND deleted_at IS NULL AND updated_at >= $3`,
      [tenantId, orgId, thirtyDaysAgo]
    )
    const dealOutcomes = {
      won: Number(dealOutcomesRow?.won || 0),
      lost: Number(dealOutcomesRow?.lost || 0),
      revenue: Number(dealOutcomesRow?.revenue || 0),
    }

    // Contacts by source
    const contactsBySource = await query(
      `SELECT source, count(*)::text as count FROM customer_entities
       WHERE tenant_id = $1 AND organization_id = $2 AND deleted_at IS NULL AND source IS NOT NULL
       GROUP BY source ORDER BY count DESC LIMIT 10`,
      [tenantId, orgId]
    )

    // Contacts over time (last 30 days by day)
    const contactsOverTime = await query(
      `SELECT date_trunc('day', created_at)::date::text as day, count(*)::text as count
       FROM customer_entities WHERE tenant_id = $1 AND organization_id = $2 AND deleted_at IS NULL AND created_at >= $3
       GROUP BY day ORDER BY day`,
      [tenantId, orgId, thirtyDaysAgo]
    )

    // Landing page performance
    const landingPagePerf = await query(
      `SELECT title, view_count, submission_count FROM landing_pages
       WHERE tenant_id = $1 AND organization_id = $2 AND deleted_at IS NULL AND status = 'published'
       ORDER BY view_count DESC LIMIT 10`,
      [tenantId, orgId]
    )

    // Revenue from payments
    let paymentRevenue = { total: 0, thisMonth: 0, lastMonth: 0 }
    try {
      const rev = await queryOne(
        `SELECT
          coalesce(sum(amount), 0) as total,
          coalesce(sum(amount) filter (where created_at >= $2), 0) as this_month,
          coalesce(sum(amount) filter (where created_at >= $3 and created_at < $2), 0) as last_month
         FROM payment_records WHERE organization_id = $1 AND status = 'succeeded'`,
        [orgId, thirtyDaysAgo, sixtyDaysAgo]
      )
      if (rev) paymentRevenue = { total: Number(rev.total), thisMonth: Number(rev.this_month), lastMonth: Number(rev.last_month) }
    } catch {}

    // Bookings count
    let bookingStats = { upcoming: 0, thisMonth: 0 }
    try {
      const bs = await queryOne(
        `SELECT
          count(*) filter (where start_time >= now() and status = 'confirmed')::int as upcoming,
          count(*) filter (where created_at >= $2)::int as this_month
         FROM bookings WHERE organization_id = $1`,
        [orgId, thirtyDaysAgo]
      )
      if (bs) bookingStats = { upcoming: Number(bs.upcoming), thisMonth: Number(bs.this_month) }
    } catch {}

    return NextResponse.json({
      ok: true,
      data: { pipelineByStage, dealOutcomes, contactsBySource, contactsOverTime, landingPagePerf, paymentRevenue, bookingStats },
    })
  } catch (error) {
    console.error('[reports]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load reports' }, { status: 500 })
  }
}
