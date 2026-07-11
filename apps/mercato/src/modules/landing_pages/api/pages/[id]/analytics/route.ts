import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { CONTROL_VARIANT_UUID } from '../../../../services/public-serving'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['landing_pages.view'] },
}

function isMissingRelation(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01' || (err as { code?: string })?.code === '42703'
}

function rate(submissions: number, views: number): number {
  if (!views) return 0
  return Math.round((submissions / views) * 1000) / 10
}

export async function GET(req: Request, ctx: any) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const id = ctx?.params?.id

    const page = await knex('landing_pages')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()
    if (!page) return NextResponse.json({ ok: false, error: 'Page not found' }, { status: 404 })

    let variants: any[] = []
    let dailyRows: any[] = []
    let referrers: any[] = []
    let provisioned = true

    try {
      variants = await knex('landing_page_variants')
        .where('landing_page_id', page.id)
        .where('organization_id', auth.orgId)
        .select('id', 'name', 'status', 'view_count', 'submission_count')

      dailyRows = await knex('landing_page_daily_stats')
        .where('landing_page_id', page.id)
        .where('organization_id', auth.orgId)
        .whereRaw(`day >= current_date - interval '29 days'`)
        .orderBy('day', 'asc')
        .select('day', 'variant_id', 'views', 'submissions')

      referrers = await knex('landing_page_referrers')
        .where('landing_page_id', page.id)
        .where('organization_id', auth.orgId)
        .orderBy('count', 'desc')
        .limit(10)
        .select('host', 'count')
    } catch (err) {
      if (!isMissingRelation(err)) throw err
      provisioned = false
    }

    // Build the last-30-day series (fill missing days with zeros), one entry
    // per day per arm ('control' plus each variant id that has data).
    const dayKey = (d: Date | string) => {
      const date = d instanceof Date ? d : new Date(d)
      return date.toISOString().slice(0, 10)
    }
    const byDayArm = new Map<string, { views: number; submissions: number }>()
    for (const row of dailyRows) {
      const arm = !row.variant_id || row.variant_id === CONTROL_VARIANT_UUID ? 'control' : String(row.variant_id)
      const key = `${dayKey(row.day)}|${arm}`
      const prev = byDayArm.get(key) ?? { views: 0, submissions: 0 }
      prev.views += Number(row.views) || 0
      prev.submissions += Number(row.submissions) || 0
      byDayArm.set(key, prev)
    }
    const arms = ['control', ...variants.map((v) => String(v.id))]
    const days: Array<{ day: string; arms: Record<string, { views: number; submissions: number }> }> = []
    const today = new Date()
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      const key = dayKey(d)
      const perArm: Record<string, { views: number; submissions: number }> = {}
      for (const arm of arms) {
        perArm[arm] = byDayArm.get(`${key}|${arm}`) ?? { views: 0, submissions: 0 }
      }
      days.push({ day: key, arms: perArm })
    }

    const controlViews = Number(page.view_count) || 0
    const controlSubs = Number(page.submission_count) || 0
    const totals = {
      control: { views: controlViews, submissions: controlSubs, conversionRate: rate(controlSubs, controlViews) },
      variants: variants.map((v) => {
        const views = Number(v.view_count) || 0
        const submissions = Number(v.submission_count) || 0
        return { id: v.id, name: v.name, status: v.status, views, submissions, conversionRate: rate(submissions, views) }
      }),
    }
    const allViews = controlViews + totals.variants.reduce((a, v) => a + v.views, 0)
    const allSubs = controlSubs + totals.variants.reduce((a, v) => a + v.submissions, 0)

    return NextResponse.json({
      ok: true,
      data: {
        provisioned,
        abEnabled: !!page.ab_enabled,
        totals: { ...totals, all: { views: allViews, submissions: allSubs, conversionRate: rate(allSubs, allViews) } },
        days,
        referrers: referrers.map((r) => ({ host: r.host, count: Number(r.count) || 0 })),
      },
    })
  } catch (error) {
    console.error('[landing_pages.analytics]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load analytics' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Landing Pages',
  summary: 'Landing page analytics',
  methods: { GET: { summary: 'Get 30-day per-arm analytics, totals, and top referrers', tags: ['Landing Pages'] } },
}
