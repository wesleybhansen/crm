export const metadata = { path: '/ai/usage', GET: { requireAuth: true }, PUT: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const month = new Date().toISOString().substring(0, 7)

    const usage = await knex('ai_usage')
      .where('organization_id', auth.orgId)
      .where('month', month).first()

    const capSetting = await knex('ai_settings')
      .where('setting_key', 'monthly_ai_cap').first()

    const userKey = await knex('ai_settings')
      .where('setting_key', 'user_ai_key')
      .where('user_id', auth.sub).first()

    return NextResponse.json({
      ok: true,
      data: {
        callsUsed: usage?.call_count || 0,
        callsCap: capSetting ? parseInt(capSetting.setting_value) : 500,
        month,
        hasUserKey: !!userKey?.setting_value,
      },
    })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()

    if (body.userKey !== undefined) {
      // Save or clear BYOK key
      const existing = await knex('ai_settings')
        .where('setting_key', 'user_ai_key')
        .where('user_id', auth.sub).first()

      if (existing) {
        await knex('ai_settings').where('id', existing.id).update({
          setting_value: body.userKey || '',
          updated_at: new Date(),
        })
      } else if (body.userKey) {
        await knex('ai_settings').insert({
          id: require('crypto').randomUUID(),
          tenant_id: auth.tenantId,
          organization_id: auth.orgId,
          user_id: auth.sub,
          setting_key: 'user_ai_key',
          setting_value: body.userKey,
          created_at: new Date(),
          updated_at: new Date(),
        })
      }

      return NextResponse.json({ ok: true })
    }

    // Save OpenAI key
    if (body.openaiKey !== undefined) {
      const existing = await knex('ai_settings')
        .where('setting_key', 'user_openai_key')
        .where('user_id', auth.sub).first()

      if (existing) {
        await knex('ai_settings').where('id', existing.id).update({
          setting_value: body.openaiKey || '',
          updated_at: new Date(),
        })
      } else if (body.openaiKey) {
        await knex('ai_settings').insert({
          id: require('crypto').randomUUID(),
          tenant_id: auth.tenantId,
          organization_id: auth.orgId,
          user_id: auth.sub,
          setting_key: 'user_openai_key',
          setting_value: body.openaiKey,
          created_at: new Date(),
          updated_at: new Date(),
        })
      }

      return NextResponse.json({ ok: true })
    }

    // Admin: update cap
    if (body.cap !== undefined) {
      const existing = await knex('ai_settings').where('setting_key', 'monthly_ai_cap').first()
      if (existing) {
        await knex('ai_settings').where('id', existing.id).update({
          setting_value: String(body.cap), updated_at: new Date(),
        })
      }
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ ok: false, error: 'No changes' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
