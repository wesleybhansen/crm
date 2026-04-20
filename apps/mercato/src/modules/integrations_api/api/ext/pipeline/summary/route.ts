import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  path: '/ext/pipeline/summary',
  GET: { requireAuth: true, requireFeatures: ['integrations_api.access'] },
}

export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const stages = await knex('customer_deals')
      .where('tenant_id', auth.tenantId)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .groupBy('pipeline_stage')
      .select('pipeline_stage')
      .count('* as count')
      .sum('value_amount as total_value')

    const [totals] = await knex('customer_deals')
      .where('tenant_id', auth.tenantId)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .select(
        knex.raw('count(*) as total_deals'),
        knex.raw("count(*) filter (where status = 'open') as open_deals"),
        knex.raw("coalesce(sum(value_amount) filter (where status = 'open'), 0) as open_value"),
        knex.raw("count(*) filter (where status = 'win') as won_deals"),
        knex.raw("coalesce(sum(value_amount) filter (where status = 'win'), 0) as won_value"),
      )

    return NextResponse.json({
      ok: true,
      data: {
        stages,
        totals: {
          totalDeals: Number(totals?.total_deals || 0),
          openDeals: Number(totals?.open_deals || 0),
          openValue: Number(totals?.open_value || 0),
          wonDeals: Number(totals?.won_deals || 0),
          wonValue: Number(totals?.won_value || 0),
        },
      },
    })
  } catch (error) {
    console.error('[ext.pipeline.summary]', error)
    return NextResponse.json({ ok: false, error: 'Failed to get pipeline summary' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'External API', summary: 'Pipeline summary',
  methods: { GET: { summary: 'Pipeline summary for AI agents', tags: ['External API'] } },
}
