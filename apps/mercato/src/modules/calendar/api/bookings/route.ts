import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['calendar.view'] },
  POST: { requireAuth: false }, // Public — guests book appointments
}

export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const upcoming = url.searchParams.get('upcoming') !== 'false'

    let query = knex('bookings').where('organization_id', auth.orgId)
    if (upcoming) query = query.where('start_time', '>=', new Date()).where('status', 'confirmed')
    query = query.orderBy('start_time', 'asc').limit(50)

    const bookings = await query
    return NextResponse.json({ ok: true, data: bookings })
  } catch { return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 }) }
}

export async function POST(req: Request) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { bookingPageId, guestName, guestEmail, guestPhone, startTime, notes } = body

    if (!bookingPageId || !guestName || !guestEmail || !startTime) {
      return NextResponse.json({ ok: false, error: 'bookingPageId, guestName, guestEmail, startTime required' }, { status: 400 })
    }

    const page = await knex('booking_pages').where('id', bookingPageId).where('is_active', true).first()
    if (!page) return NextResponse.json({ ok: false, error: 'Booking page not found' }, { status: 404 })

    const start = new Date(startTime)
    const end = new Date(start.getTime() + (page.duration_minutes || 30) * 60000)

    // Check for conflicts
    const conflict = await knex('bookings')
      .where('booking_page_id', bookingPageId)
      .where('status', 'confirmed')
      .where(function() {
        this.where('start_time', '<', end).andWhere('end_time', '>', start)
      }).first()

    if (conflict) {
      return NextResponse.json({ ok: false, error: 'This time slot is no longer available' }, { status: 409 })
    }

    const id = require('crypto').randomUUID()
    await knex('bookings').insert({
      id, tenant_id: page.tenant_id, organization_id: page.organization_id,
      booking_page_id: bookingPageId,
      guest_name: guestName, guest_email: guestEmail, guest_phone: guestPhone || null,
      start_time: start, end_time: end,
      status: 'confirmed', notes: notes || null, created_at: new Date(),
    })

    // Auto-create contact
    const existingContact = await knex('customer_entities')
      .where('primary_email', guestEmail).where('organization_id', page.organization_id)
      .whereNull('deleted_at').first()

    if (!existingContact) {
      await knex('customer_entities').insert({
        id: require('crypto').randomUUID(),
        tenant_id: page.tenant_id, organization_id: page.organization_id,
        kind: 'person', display_name: guestName, primary_email: guestEmail,
        primary_phone: guestPhone || null, source: 'booking',
        status: 'active', lifecycle_stage: 'prospect',
        created_at: new Date(), updated_at: new Date(),
      }).catch(() => {})
    }

    return NextResponse.json({ ok: true, data: { id, startTime: start, endTime: end } }, { status: 201 })
  } catch (error) {
    console.error('[calendar.bookings.create]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Calendar', summary: 'Bookings',
  methods: { GET: { summary: 'List bookings', tags: ['Calendar'] }, POST: { summary: 'Create booking (public)', tags: ['Calendar'] } },
}
