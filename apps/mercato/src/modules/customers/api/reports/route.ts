// ORM-SKIP: uses raw pg query() — conversion requires SQL rewrite
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

    // Weighted revenue forecast — the "will I hit my month?" answer. Open
    // deals bucketed by expected-close month; weighted = value x probability
    // (unset probability counts at 50%). The data always existed; nothing
    // computed it.
    let forecast: Array<{ bucket: string; deals: number; totalValue: number; weightedValue: number }> = []
    try {
      const rows = await query(
        `SELECT
          CASE
            WHEN expected_close_at IS NULL THEN 'unscheduled'
            WHEN expected_close_at < date_trunc('month', now()) THEN 'overdue'
            ELSE to_char(date_trunc('month', expected_close_at), 'YYYY-MM')
          END as bucket,
          count(*)::int as deals,
          coalesce(sum(value_amount), 0)::numeric as total_value,
          coalesce(sum(value_amount * coalesce(probability, 50) / 100.0), 0)::numeric as weighted_value
         FROM customer_deals
         WHERE tenant_id = $1 AND organization_id = $2 AND deleted_at IS NULL AND status = 'open'
         GROUP BY 1 ORDER BY 1`,
        [tenantId, orgId]
      )
      forecast = (rows || []).map((r: Record<string, unknown>) => ({
        bucket: String(r.bucket),
        deals: Number(r.deals || 0),
        totalValue: Number(r.total_value || 0),
        weightedValue: Number(r.weighted_value || 0),
      }))
      // Text ORDER BY puts 'overdue' between months — present overdue first,
      // then months ascending, unscheduled last.
      const bucketRank = (b: string) => (b === 'overdue' ? 0 : b === 'unscheduled' ? 2 : 1)
      forecast.sort((a, b) => (bucketRank(a.bucket) - bucketRank(b.bucket)) || a.bucket.localeCompare(b.bucket))
    } catch {}

    // Win/loss by lead source (last 90 days; updated_at approximates close
    // time since deals have no dedicated closed_at).
    let winLossBySource: Array<{ source: string; won: number; lost: number; winRate: number; wonValue: number }> = []
    try {
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
      const rows = await query(
        `SELECT coalesce(nullif(trim(source), ''), 'unknown') as source,
          count(*) filter (where status = 'win')::int as won,
          count(*) filter (where status in ('lose', 'lost'))::int as lost,
          coalesce(sum(value_amount) filter (where status = 'win'), 0)::numeric as won_value
         FROM customer_deals
         WHERE tenant_id = $1 AND organization_id = $2 AND deleted_at IS NULL
           AND status in ('win', 'lose', 'lost') AND updated_at >= $3
         GROUP BY 1 ORDER BY won DESC LIMIT 10`,
        [tenantId, orgId, ninetyDaysAgo]
      )
      winLossBySource = (rows || []).map((r: Record<string, unknown>) => {
        const won = Number(r.won || 0)
        const lost = Number(r.lost || 0)
        return {
          source: String(r.source),
          won,
          lost,
          winRate: won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0,
          wonValue: Number(r.won_value || 0),
        }
      })
    } catch {}

    // Sales velocity: average days from deal creation to win (last 90 days).
    let salesVelocity: { avgDaysToWin: number | null; sampled: number } = { avgDaysToWin: null, sampled: 0 }
    try {
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
      const row = await queryOne(
        `SELECT count(*)::int as sampled,
          avg(extract(epoch from (updated_at - created_at)) / 86400.0)::numeric as avg_days
         FROM customer_deals
         WHERE tenant_id = $1 AND organization_id = $2 AND deleted_at IS NULL
           AND status = 'win' AND updated_at >= $3`,
        [tenantId, orgId, ninetyDaysAgo]
      )
      if (row && Number(row.sampled) > 0) {
        salesVelocity = { avgDaysToWin: Math.round(Number(row.avg_days) * 10) / 10, sampled: Number(row.sampled) }
      }
    } catch {}

    return NextResponse.json({
      ok: true,
      data: { pipelineByStage, dealOutcomes, contactsBySource, contactsOverTime, landingPagePerf, paymentRevenue, bookingStats, forecast, winLossBySource, salesVelocity },
    })
  } catch (error) {
    console.error('[reports]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load reports' }, { status: 500 })
  }
}
