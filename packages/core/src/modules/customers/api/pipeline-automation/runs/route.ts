/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['pipeline_automation.view_history'] },
}

function rowToDto(row: any) {
  return {
    id: row.id,
    ruleId: row.rule_id,
    triggerEventId: row.trigger_event_id,
    triggerEventKey: row.trigger_event_key,
    entityType: row.entity_type,
    entityId: row.entity_id,
    fromStage: row.from_stage,
    toStage: row.to_stage,
    outcome: row.outcome,
    error: row.error,
    ranAt: row.ran_at,
  }
}

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const url = new URL(req.url)
  const ruleId = url.searchParams.get('rule_id')
  const entityId = url.searchParams.get('entity_id')
  const outcome = url.searchParams.get('outcome')
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10))
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '50', 10)))

  const container = await createRequestContainer()
  const knex = (container.resolve('em') as EntityManager).getKnex()

  let q = knex('customer_pipeline_automation_runs')
    .where('organization_id', auth.orgId)
    .where('tenant_id', auth.tenantId)
    .orderBy('ran_at', 'desc')
  if (ruleId) q = q.where('rule_id', ruleId)
  if (entityId) q = q.where('entity_id', entityId)
  if (outcome) q = q.where('outcome', outcome)

  const totalRow = await q.clone().clearOrder().count<{ count: string }>('id as count').first()
  const total = Number(totalRow?.count ?? 0)

  const rows = await q.limit(pageSize).offset((page - 1) * pageSize)

  return NextResponse.json({
    items: rows.map(rowToDto),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  })
}

export const openApi = {
  tags: ['Customers'],
  paths: {
    list: { summary: 'List pipeline automation run history', description: 'Audit trail of automation runs.' },
  },
}
