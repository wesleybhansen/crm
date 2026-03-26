import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['calendar.view'] },
  POST: { requireAuth: true, requireFeatures: ['calendar.manage'] },
}

export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const pages = await knex('booking_pages').where('organization_id', auth.orgId).orderBy('created_at', 'desc')
    return NextResponse.json({ ok: true, data: pages })
  } catch { return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 }) }
}

export async function POST(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { title, slug, description, durationMinutes } = body
    if (!title || !slug) return NextResponse.json({ ok: false, error: 'title and slug required' }, { status: 400 })

    const id = require('crypto').randomUUID()
    await knex('booking_pages').insert({
      id, tenant_id: auth.tenantId, organization_id: auth.orgId,
      title, slug, description: description || null,
      duration_minutes: durationMinutes || 30,
      owner_user_id: auth.sub,
      created_at: new Date(), updated_at: new Date(),
    })
    const page = await knex('booking_pages').where('id', id).first()
    return NextResponse.json({ ok: true, data: page }, { status: 201 })
  } catch { return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 }) }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Calendar', summary: 'Booking pages',
  methods: { GET: { summary: 'List booking pages', tags: ['Calendar'] }, POST: { summary: 'Create booking page', tags: ['Calendar'] } },
}
