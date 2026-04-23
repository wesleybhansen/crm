import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { sendTestDelivery } from '../../../../lib/dispatch'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['webhooks.manage'] },
}

export async function POST(_req: Request, ctx?: any) {
  const auth = ctx?.auth
  if (!auth?.orgId || !auth?.tenantId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  const params = ctx?.params ? await ctx.params : undefined
  const id = (params as { id?: string })?.id
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const sub = await knex('webhook_subscriptions')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .first()
    if (!sub) return NextResponse.json({ ok: false, error: 'Subscription not found' }, { status: 404 })

    const payload = {
      message: 'This is a test delivery from LaunchCRM Webhooks.',
      subscriptionId: sub.id,
      event: sub.event,
      triggeredAt: new Date().toISOString(),
    }

    const result = await sendTestDelivery(knex, sub, 'webhooks.test', payload)
    return NextResponse.json({ ok: true, data: result })
  } catch (err) {
    console.error('[webhooks.test]', err)
    return NextResponse.json({ ok: false, error: 'Failed to send test delivery' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Webhooks',
  summary: 'Send a test delivery to a subscription',
  methods: { POST: { summary: 'POST a webhooks.test event to the subscription target_url', tags: ['Webhooks'] } },
}
