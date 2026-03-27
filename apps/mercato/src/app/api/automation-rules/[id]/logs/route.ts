import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Verify the rule belongs to this org
    const rule = await knex('automation_rules')
      .where('id', params.id)
      .where('organization_id', auth.orgId)
      .first()
    if (!rule) return NextResponse.json({ ok: false, error: 'Rule not found' }, { status: 404 })

    const logs = await knex('automation_rule_logs')
      .where('rule_id', params.id)
      .orderBy('created_at', 'desc')
      .limit(50)

    return NextResponse.json({ ok: true, data: logs })
  } catch (error) {
    console.error('[automation-rules.logs] GET error', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Automation Rules',
  summary: 'Automation rule execution logs',
  methods: {
    GET: { summary: 'List last 50 execution logs for a rule', tags: ['Automation Rules'] },
  },
}
