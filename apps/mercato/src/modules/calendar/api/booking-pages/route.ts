import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { normalizeAuthorUserId } from '@open-mercato/shared/lib/commands/helpers'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['calendar.view'] },
  POST: { requireAuth: true, requireFeatures: ['calendar.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['calendar.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['calendar.manage'] },
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
    const { title, slug, description, durationMinutes, meetingType, meetingLocation, zoomLink, autoConfirm, reminderConfig } = body
    if (!title || !slug) return NextResponse.json({ ok: false, error: 'title and slug required' }, { status: 400 })

    const id = require('crypto').randomUUID()
    await knex('booking_pages').insert({
      id, tenant_id: auth.tenantId, organization_id: auth.orgId,
      title, slug, description: description || null,
      duration_minutes: durationMinutes || 30,
      meeting_type: meetingType || 'in_person',
      meeting_location: meetingLocation || null,
      zoom_link: zoomLink || null,
      auto_confirm: autoConfirm !== undefined ? autoConfirm : true,
      reminder_config: JSON.stringify(reminderConfig || []),
      owner_user_id: normalizeAuthorUserId(null, auth),
      created_at: new Date(), updated_at: new Date(),
    })
    const page = await knex('booking_pages').where('id', id).first()
    return NextResponse.json({ ok: true, data: page }, { status: 201 })
  } catch (err) {
    console.error('[calendar.booking-pages.POST]', err)
    const message = err instanceof Error ? err.message : 'Failed'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export async function PUT(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { id, title, description, durationMinutes, isActive, meetingType, meetingLocation, zoomLink, autoConfirm, reminderConfig } = body
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    const existing = await knex('booking_pages').where('id', id).where('organization_id', auth.orgId).first()
    if (!existing) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (title !== undefined) updates.title = title
    if (description !== undefined) updates.description = description || null
    if (durationMinutes !== undefined) updates.duration_minutes = durationMinutes
    if (isActive !== undefined) updates.is_active = isActive
    if (meetingType !== undefined) updates.meeting_type = meetingType
    if (meetingLocation !== undefined) updates.meeting_location = meetingLocation || null
    if (zoomLink !== undefined) updates.zoom_link = zoomLink || null
    if (autoConfirm !== undefined) updates.auto_confirm = autoConfirm
    if (reminderConfig !== undefined) updates.reminder_config = JSON.stringify(reminderConfig)

    await knex('booking_pages').where('id', id).where('organization_id', auth.orgId).update(updates)
    return NextResponse.json({ ok: true })
  } catch { return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 }) }
}

export async function DELETE(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    let id = url.searchParams.get('id')
    if (!id) {
      try { const body = await req.json(); id = body.id } catch { /* no body */ }
    }
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    const existing = await knex('booking_pages').where('id', id).where('organization_id', auth.orgId).first()
    if (!existing) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

    // Unlink any bookings referencing this page before deleting
    await knex('bookings').where('booking_page_id', id).update({ booking_page_id: null })
    await knex('booking_pages').where('id', id).where('organization_id', auth.orgId).del()
    return NextResponse.json({ ok: true })
  } catch { return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 }) }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Calendar', summary: 'Booking pages',
  methods: {
    GET: { summary: 'List booking pages', tags: ['Calendar'] },
    POST: { summary: 'Create booking page', tags: ['Calendar'] },
    PUT: { summary: 'Update booking page', tags: ['Calendar'] },
    DELETE: { summary: 'Delete booking page', tags: ['Calendar'] },
  },
}
