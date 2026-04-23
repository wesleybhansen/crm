import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

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
    const existing = await knex('webhook_subscriptions')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .first()
    if (!existing) return NextResponse.json({ ok: false, error: 'Subscription not found' }, { status: 404 })

    const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`
    await knex('webhook_subscriptions')
      .where('id', id)
      .update({ secret, updated_at: new Date() })
    return NextResponse.json({ ok: true, data: { id, secret } })
  } catch (err) {
    console.error('[webhooks.rotate-secret]', err)
    return NextResponse.json({ ok: false, error: 'Failed to rotate secret' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Webhooks',
  summary: 'Rotate a subscription signing secret',
  methods: { POST: { summary: 'Generate a new signing secret', tags: ['Webhooks'] } },
}
