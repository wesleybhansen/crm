export const metadata = { path: '/webhooks/[id]/deliveries', GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { WebhookSubscription, WebhookDelivery } from '../../../../data/schema'

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const sub = await em.findOne(WebhookSubscription, { id: params.id, organizationId: auth.orgId, tenantId: auth.tenantId })
    if (!sub) return NextResponse.json({ ok: false, error: 'Subscription not found' }, { status: 404 })

    const deliveries = await em.find(WebhookDelivery, { subscriptionId: params.id }, { orderBy: { createdAt: 'desc' }, limit: 50 })

    return NextResponse.json({ ok: true, data: deliveries.map(d => ({
      id: d.id, subscription_id: d.subscriptionId, event: d.event, payload: d.payload,
      status_code: d.statusCode, response_body: d.responseBody, attempt: d.attempt,
      delivered_at: d.deliveredAt, failed_at: d.failedAt, created_at: d.createdAt,
    })) })
  } catch (error) {
    console.error('[webhooks.deliveries] GET failed', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Webhooks', summary: 'Webhook delivery logs',
  methods: { GET: { summary: 'List delivery logs for a webhook subscription', tags: ['Webhooks'] } },
}
