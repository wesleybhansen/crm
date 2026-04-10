export const metadata = { GET: { requireAuth: true } }

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
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    // Verify the subscription belongs to this org
    const subscription = await knex('webhook_subscriptions')
      .where('id', params.id)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .first()

    if (!subscription) {
      return NextResponse.json({ ok: false, error: 'Subscription not found' }, { status: 404 })
    }

    const deliveries = await knex('webhook_deliveries')
      .where('subscription_id', params.id)
      .orderBy('created_at', 'desc')
      .limit(50)

    return NextResponse.json({ ok: true, data: deliveries })
  } catch (error) {
    console.error('[webhooks.deliveries] GET failed', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Webhooks',
  summary: 'Webhook delivery logs',
  methods: {
    GET: { summary: 'List delivery logs for a webhook subscription', tags: ['Webhooks'] },
  },
}
