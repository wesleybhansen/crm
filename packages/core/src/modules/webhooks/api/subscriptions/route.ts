/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from 'crypto'
import { z } from 'zod'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { subscriptionCreateSchema, subscriptionUpdateSchema } from '../../data/validators'
import { findEventByPublicId } from '../../lib/eventRegistry'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['webhooks.view'] },
  POST: { requireAuth: true, requireFeatures: ['webhooks.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['webhooks.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['webhooks.manage'] },
}

function generateSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`
}

function rowToResponse(row: any): any {
  if (!row) return row
  return {
    id: row.id,
    event: row.event,
    targetUrl: row.target_url,
    secret: row.secret,
    isActive: row.is_active,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function GET(_req: Request, ctx?: any) {
  const auth = ctx?.auth
  if (!auth?.orgId || !auth?.tenantId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const rows = await knex('webhook_subscriptions')
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .orderBy('created_at', 'desc')
    return NextResponse.json({ ok: true, data: rows.map(rowToResponse) })
  } catch (err) {
    console.error('[webhooks.subscriptions.GET]', err)
    return NextResponse.json({ ok: false, error: 'Failed to list subscriptions' }, { status: 500 })
  }
}

export async function POST(req: Request, ctx?: any) {
  const auth = ctx?.auth
  if (!auth?.orgId || !auth?.tenantId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await req.json()
    const parsed = subscriptionCreateSchema.parse(body)

    if (!findEventByPublicId(parsed.event)) {
      return NextResponse.json({ ok: false, error: `Unknown event: ${parsed.event}` }, { status: 400 })
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const id = crypto.randomUUID()
    const secret = parsed.secret && parsed.secret.trim().length > 0 ? parsed.secret.trim() : generateSecret()
    await knex('webhook_subscriptions').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      event: parsed.event,
      target_url: parsed.targetUrl,
      secret,
      is_active: parsed.isActive ?? true,
      created_at: new Date(),
      updated_at: new Date(),
    })
    const row = await knex('webhook_subscriptions').where('id', id).first()
    return NextResponse.json({ ok: true, data: rowToResponse(row) }, { status: 201 })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ ok: false, error: 'Invalid input', details: err.issues }, { status: 400 })
    }
    console.error('[webhooks.subscriptions.POST]', err)
    return NextResponse.json({ ok: false, error: 'Failed to create subscription' }, { status: 500 })
  }
}

export async function PUT(req: Request, ctx?: any) {
  const auth = ctx?.auth
  if (!auth?.orgId || !auth?.tenantId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await req.json()
    const parsed = subscriptionUpdateSchema.parse(body)
    if (parsed.event && !findEventByPublicId(parsed.event)) {
      return NextResponse.json({ ok: false, error: `Unknown event: ${parsed.event}` }, { status: 400 })
    }
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (parsed.event !== undefined) updates.event = parsed.event
    if (parsed.targetUrl !== undefined) updates.target_url = parsed.targetUrl
    if (parsed.secret !== undefined) updates.secret = parsed.secret
    if (parsed.isActive !== undefined) updates.is_active = parsed.isActive

    const updated = await knex('webhook_subscriptions')
      .where('id', parsed.id)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .update(updates)
    if (!updated) return NextResponse.json({ ok: false, error: 'Subscription not found' }, { status: 404 })
    const row = await knex('webhook_subscriptions').where('id', parsed.id).first()
    return NextResponse.json({ ok: true, data: rowToResponse(row) })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ ok: false, error: 'Invalid input', details: err.issues }, { status: 400 })
    }
    console.error('[webhooks.subscriptions.PUT]', err)
    return NextResponse.json({ ok: false, error: 'Failed to update subscription' }, { status: 500 })
  }
}

export async function DELETE(req: Request, ctx?: any) {
  const auth = ctx?.auth
  if (!auth?.orgId || !auth?.tenantId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const url = new URL(req.url)
    let id = url.searchParams.get('id')
    if (!id) {
      try { const body = await req.json(); id = body?.id } catch { /* no body */ }
    }
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const deleted = await knex('webhook_subscriptions')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .del()
    if (!deleted) return NextResponse.json({ ok: false, error: 'Subscription not found' }, { status: 404 })
    await knex('webhook_deliveries').where('subscription_id', id).del()
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[webhooks.subscriptions.DELETE]', err)
    return NextResponse.json({ ok: false, error: 'Failed to delete subscription' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Webhooks',
  summary: 'Manage outbound webhook subscriptions',
  methods: {
    GET: { summary: 'List webhook subscriptions', tags: ['Webhooks'] },
    POST: { summary: 'Create webhook subscription', tags: ['Webhooks'] },
    PUT: { summary: 'Update webhook subscription', tags: ['Webhooks'] },
    DELETE: { summary: 'Delete webhook subscription', tags: ['Webhooks'] },
  },
}
