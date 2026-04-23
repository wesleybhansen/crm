import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['webhooks.view'] },
}

type DeliveryRow = {
  id: string
  subscription_id: string
  event: string
  payload: unknown
  status_code: number | null
  response_body: string | null
  attempt: number
  delivered_at: Date | null
  failed_at: Date | null
  created_at: Date
}

function rowToResponse(row: DeliveryRow) {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    event: row.event,
    payload: typeof row.payload === 'string' ? safeJsonParse(row.payload) : row.payload,
    statusCode: row.status_code,
    responseBody: row.response_body,
    attempt: row.attempt,
    deliveredAt: row.delivered_at,
    failedAt: row.failed_at,
    status: row.delivered_at ? 'delivered' : row.failed_at ? 'failed' : 'pending',
    createdAt: row.created_at,
  }
}

function safeJsonParse(value: string): unknown {
  try { return JSON.parse(value) } catch { return value }
}

export async function GET(req: Request, ctx?: any) {
  const auth = ctx?.auth
  if (!auth?.orgId || !auth?.tenantId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const url = new URL(req.url)
    const subscriptionId = url.searchParams.get('subscriptionId')
    const status = url.searchParams.get('status') // 'delivered' | 'failed'
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10))
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') || '50', 10)))

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    // Tenant scope comes via the subscription join: only list deliveries whose
    // subscription belongs to the caller's org+tenant.
    let q = knex('webhook_deliveries as wd')
      .innerJoin('webhook_subscriptions as ws', 'ws.id', 'wd.subscription_id')
      .where('ws.organization_id', auth.orgId)
      .where('ws.tenant_id', auth.tenantId)
    if (subscriptionId) q = q.where('wd.subscription_id', subscriptionId)
    if (status === 'delivered') q = q.whereNotNull('wd.delivered_at')
    else if (status === 'failed') q = q.whereNotNull('wd.failed_at')

    const [{ count }] = await q.clone().count('wd.id as count')
    const total = Number(count)
    const items: DeliveryRow[] = await q
      .clone()
      .orderBy('wd.created_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .select('wd.*')

    return NextResponse.json({
      ok: true,
      data: items.map(rowToResponse),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    })
  } catch (err) {
    console.error('[webhooks.deliveries.GET]', err)
    return NextResponse.json({ ok: false, error: 'Failed to list deliveries' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Webhooks',
  summary: 'List webhook delivery logs',
  methods: { GET: { summary: 'Paginated delivery log scoped to caller org', tags: ['Webhooks'] } },
}
