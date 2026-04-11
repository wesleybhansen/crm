// ORM-SKIP: needs entity definition — Phase 2 conversion
export const metadata = { path: '/inbox/ai-settings', GET: { requireAuth: true }, PUT: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'

// GET: Load AI draft settings for this org
export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const settings = await knex('inbox_ai_settings').where('organization_id', auth.orgId).first()
    return NextResponse.json({ ok: true, data: settings || null })
  } catch (error) {
    console.error('[inbox.ai-settings.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

// PUT: Save AI draft settings
export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()

    const existing = await knex('inbox_ai_settings').where('organization_id', auth.orgId).first()

    const fields = {
      enabled: body.enabled ?? existing?.enabled ?? false,
      knowledge_base: body.knowledgeBase ?? existing?.knowledge_base ?? '',
      tone: body.tone ?? existing?.tone ?? 'professional',
      instructions: body.instructions ?? existing?.instructions ?? '',
      business_name: body.businessName ?? existing?.business_name ?? '',
      business_description: body.businessDescription ?? existing?.business_description ?? '',
      updated_at: new Date(),
    }

    if (existing) {
      await knex('inbox_ai_settings').where('id', existing.id).update(fields)
    } else {
      await knex('inbox_ai_settings').insert({
        id: crypto.randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        ...fields,
        created_at: new Date(),
      })
    }

    const updated = await knex('inbox_ai_settings').where('organization_id', auth.orgId).first()
    return NextResponse.json({ ok: true, data: updated })
  } catch (error) {
    console.error('[inbox.ai-settings.save]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
