// ORM-SKIP: raw upsert into customer_service_settings (single row per org)
export const metadata = {
  path: '/customer-service/settings',
  GET: { requireAuth: true, requireFeatures: ['email.view'] },
  PUT: { requireAuth: true, requireFeatures: ['email.send'] },
}

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

function serialize(row: any) {
  if (!row) {
    return { enabled: false, watchedConnectionIds: null, replyMode: 'draft', signature: null }
  }
  return {
    id: row.id,
    enabled: !!row.enabled,
    watchedConnectionIds: row.watched_connection_ids ?? null,
    replyMode: row.reply_mode || 'draft',
    signature: row.signature ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// GET: load the org's customer service config (returns defaults if no row yet)
export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const row = await knex('customer_service_settings').where('organization_id', auth.orgId).first()
    return NextResponse.json({ ok: true, data: serialize(row) })
  } catch (error) {
    console.error('[customer-service.settings.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load settings' }, { status: 500 })
  }
}

// PUT: upsert the single org row. Self-scoped by auth.orgId; client org is ignored.
export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json().catch(() => ({}))

    const existing = await knex('customer_service_settings').where('organization_id', auth.orgId).first()

    // Normalize watchedConnectionIds to a string[] or null (null = all active).
    let watched: string[] | null = existing?.watched_connection_ids ?? null
    if (body.watchedConnectionIds !== undefined) {
      if (Array.isArray(body.watchedConnectionIds)) {
        const cleaned = body.watchedConnectionIds.filter((v: unknown) => typeof v === 'string' && v.length > 0)
        watched = cleaned.length > 0 ? cleaned : null
      } else {
        watched = null
      }
    }

    const replyModeIn = typeof body.replyMode === 'string' ? body.replyMode : undefined
    // Phase 1 is draft-only. Reject any attempt to set auto-send.
    const replyMode = replyModeIn === 'draft' ? 'draft' : (existing?.reply_mode || 'draft')

    const fields = {
      enabled: typeof body.enabled === 'boolean' ? body.enabled : (existing?.enabled ?? false),
      watched_connection_ids: watched ? JSON.stringify(watched) : null,
      reply_mode: replyMode,
      signature: body.signature !== undefined ? (body.signature || null) : (existing?.signature ?? null),
      updated_at: new Date(),
    }

    if (existing) {
      await knex('customer_service_settings').where('id', existing.id).update(fields)
    } else {
      await knex('customer_service_settings').insert({
        id: crypto.randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        ...fields,
        created_at: new Date(),
      })
    }

    const updated = await knex('customer_service_settings').where('organization_id', auth.orgId).first()
    return NextResponse.json({ ok: true, data: serialize(updated) })
  } catch (error) {
    console.error('[customer-service.settings.put]', error)
    return NextResponse.json({ ok: false, error: 'Failed to save settings' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Customer Service',
  summary: 'Customer Service settings',
  methods: {
    GET: { summary: 'Get customer service settings for the current org', tags: ['Customer Service'] },
    PUT: { summary: 'Update customer service settings for the current org', tags: ['Customer Service'] },
  },
}
