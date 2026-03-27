import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const { id } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const funnel = await knex('funnels').where('id', id).where('organization_id', auth.orgId).first()
    if (!funnel) return NextResponse.json({ ok: false, error: 'Funnel not found' }, { status: 404 })

    const steps = await knex('funnel_steps')
      .select('funnel_steps.*')
      .where('funnel_steps.funnel_id', id)
      .orderBy('funnel_steps.step_order', 'asc')

    const visitCounts = await knex('funnel_visits')
      .select('step_id')
      .count('* as visits')
      .where('funnel_id', id)
      .groupBy('step_id')

    const visitMap = new Map<string, number>()
    for (const row of visitCounts) {
      visitMap.set(row.step_id, parseInt(String(row.visits), 10))
    }

    // Fetch page titles for page-type steps
    const pageIds = steps
      .filter((s: { step_type: string; page_id: string | null }) => s.step_type === 'page' && s.page_id)
      .map((s: { page_id: string }) => s.page_id)
    const pageTitleMap = new Map<string, string>()
    if (pageIds.length > 0) {
      const pages = await knex('landing_pages').select('id', 'title').whereIn('id', pageIds)
      for (const page of pages) {
        pageTitleMap.set(page.id, page.title)
      }
    }

    let previousVisits = 0
    const analytics = steps.map((step: { id: string; step_order: number; step_type: string; page_id: string | null }, index: number) => {
      const visits = visitMap.get(step.id) || 0
      let pageTitle: string | null = null
      if (step.step_type === 'page' && step.page_id) {
        pageTitle = pageTitleMap.get(step.page_id) || null
      }

      let dropOffRate = 0
      if (index > 0 && previousVisits > 0) {
        dropOffRate = Math.round(((previousVisits - visits) / previousVisits) * 100 * 10) / 10
      }

      previousVisits = visits

      return {
        stepOrder: step.step_order,
        stepType: step.step_type,
        pageTitle,
        visits,
        dropOffRate,
      }
    })

    return NextResponse.json({ ok: true, data: analytics })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to load analytics' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Funnels', summary: 'Funnel analytics',
  methods: {
    GET: { summary: 'Get per-step conversion analytics for a funnel', tags: ['Funnels'] },
  },
}
