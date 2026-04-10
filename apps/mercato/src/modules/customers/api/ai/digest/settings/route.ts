export const metadata = { GET: { requireAuth: true }, PUT: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

// ── GET — Return digest settings ─────────────────────────────────────────────

export async function GET() {
  try {
    const auth = await getAuthFromCookies()
    if (!auth?.tenantId || !auth?.orgId) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const profile = await knex('business_profiles')
      .where('organization_id', auth.orgId)
      .select('digest_frequency', 'digest_day')
      .first()

    return NextResponse.json({
      ok: true,
      data: {
        frequency: profile?.digest_frequency || 'weekly',
        dayOfWeek: profile?.digest_day ?? 1,
        enabled: (profile?.digest_frequency || 'weekly') !== 'off',
      },
    })
  } catch (error) {
    console.error('[ai.digest.settings] GET error:', error)
    return NextResponse.json({ ok: false, error: 'Failed to load digest settings' }, { status: 500 })
  }
}

// ── PUT — Update digest settings ─────────────────────────────────────────────

export async function PUT(req: Request) {
  try {
    const auth = await getAuthFromCookies()
    if (!auth?.tenantId || !auth?.orgId) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const { frequency, dayOfWeek } = body as { frequency?: string; dayOfWeek?: number }

    const validFrequencies = ['daily', 'weekly', 'off']
    if (frequency && !validFrequencies.includes(frequency)) {
      return NextResponse.json({ ok: false, error: `Invalid frequency. Must be one of: ${validFrequencies.join(', ')}` }, { status: 400 })
    }

    if (dayOfWeek !== undefined && (dayOfWeek < 0 || dayOfWeek > 6)) {
      return NextResponse.json({ ok: false, error: 'dayOfWeek must be 0-6 (Sunday-Saturday)' }, { status: 400 })
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (frequency) updates.digest_frequency = frequency
    if (dayOfWeek !== undefined) updates.digest_day = dayOfWeek

    const existing = await knex('business_profiles').where('organization_id', auth.orgId).first()

    if (existing) {
      await knex('business_profiles').where('organization_id', auth.orgId).update(updates)
    } else {
      await knex('business_profiles').insert({
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        digest_frequency: frequency || 'weekly',
        digest_day: dayOfWeek ?? 1,
      })
    }

    return NextResponse.json({
      ok: true,
      data: {
        frequency: frequency || existing?.digest_frequency || 'weekly',
        dayOfWeek: dayOfWeek ?? existing?.digest_day ?? 1,
        enabled: (frequency || existing?.digest_frequency || 'weekly') !== 'off',
      },
    })
  } catch (error) {
    console.error('[ai.digest.settings] PUT error:', error)
    return NextResponse.json({ ok: false, error: 'Failed to update digest settings' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'AI',
  summary: 'Digest settings',
  methods: {
    GET: { summary: 'Get digest frequency settings for the current org', tags: ['AI'] },
    PUT: { summary: 'Update digest frequency and day settings', tags: ['AI'] },
  },
}
