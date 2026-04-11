export const metadata = { path: '/webhooks', GET: { requireAuth: true }, POST: { requireAuth: true }, DELETE: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

const VALID_EVENTS = [
  'contact.created',
  'contact.updated',
  'deal.created',
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
  'email.opened',
  'email.bounced',
  'invoice.paid',
  'form.submitted',
  'booking.created',
] as const

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const subscriptions = await knex('webhook_subscriptions')
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .orderBy('created_at', 'desc')

    return NextResponse.json({ ok: true, data: subscriptions })
  } catch (error) {
    console.error('[webhooks] GET failed', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()
    const { event, targetUrl, secret } = body

    if (!event || !targetUrl) {
      return NextResponse.json({ ok: false, error: 'event and targetUrl are required' }, { status: 400 })
    }

    if (!VALID_EVENTS.includes(event)) {
      return NextResponse.json({ ok: false, error: `Invalid event. Valid events: ${VALID_EVENTS.join(', ')}` }, { status: 400 })
    }

    try {
      new URL(targetUrl)
    } catch {
      return NextResponse.json({ ok: false, error: 'targetUrl must be a valid URL' }, { status: 400 })
    }

    const id = require('crypto').randomUUID()
    await knex('webhook_subscriptions').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      event,
      target_url: targetUrl,
      secret: secret || null,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    })

    const subscription = await knex('webhook_subscriptions').where('id', id).first()
    return NextResponse.json({ ok: true, data: subscription })
  } catch (error) {
    console.error('[webhooks] POST failed', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')

    if (!id) {
      return NextResponse.json({ ok: false, error: 'id query param is required' }, { status: 400 })
    }

    const deleted = await knex('webhook_subscriptions')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .del()

    if (!deleted) {
      return NextResponse.json({ ok: false, error: 'Subscription not found' }, { status: 404 })
    }

    // Clean up delivery logs
    await knex('webhook_deliveries').where('subscription_id', id).del()

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[webhooks] DELETE failed', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Webhooks',
  summary: 'Manage outbound webhook subscriptions',
  methods: {
    GET: { summary: 'List webhook subscriptions', tags: ['Webhooks'] },
    POST: { summary: 'Create webhook subscription', tags: ['Webhooks'] },
    DELETE: { summary: 'Delete webhook subscription', tags: ['Webhooks'] },
  },
}
