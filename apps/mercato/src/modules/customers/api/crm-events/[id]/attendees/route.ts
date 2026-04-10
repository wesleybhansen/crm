export const metadata = { GET: { requireAuth: true }, DELETE: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'


export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const { id: eventId } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const attendees = await knex('event_attendees')
      .where('event_id', eventId)
      .where('organization_id', auth.orgId)
      .orderBy('registered_at', 'desc')
      .limit(500)

    return NextResponse.json({ ok: true, data: attendees })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const { id: eventId } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const attendeeId = url.searchParams.get('attendeeId')
    if (!attendeeId) return NextResponse.json({ ok: false, error: 'attendeeId required' }, { status: 400 })

    const attendee = await knex('event_attendees').where('id', attendeeId).where('event_id', eventId).where('organization_id', auth.orgId).first()
    if (!attendee) return NextResponse.json({ ok: false, error: 'Attendee not found' }, { status: 404 })
    await knex('event_attendees').where('id', attendeeId).delete()
    await knex('events').where('id', eventId).decrement('attendee_count', attendee.ticket_quantity || 1)
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
