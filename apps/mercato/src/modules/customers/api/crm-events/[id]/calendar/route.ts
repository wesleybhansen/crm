// ORM-SKIP: events/event_attendees are raw-knex tables (no mercato entity), created by customers Migration20260925161500

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { verifyEventCalendarToken } from '../../../../lib/event-calendar-token'

export const metadata = { path: '/crm-events/[id]/calendar', GET: { requireAuth: false } }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Public: attendees open this from their registration email, signed out.
// Only a PUBLISHED event is served (a draft or unpublished event's details
// stay private), and the private join link is included only with the signed
// `t` token that registration emails carry (security sweep 2026-09-25,
// medium 4: this used to serve any event of any org by id alone).
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!UUID_PATTERN.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const event = await knex('events')
      .where('id', id)
      .where('status', 'published')
      .whereNull('deleted_at')
      .first()
    if (!event) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const token = new URL(req.url).searchParams.get('t')
    const includeJoinLink = verifyEventCalendarToken(event.id, token)

    const start = new Date(event.start_time)
    const end = event.end_time ? new Date(event.end_time) : new Date(start.getTime() + 60 * 60 * 1000)

    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    const location = event.event_type === 'virtual'
      ? ((includeJoinLink && event.virtual_link) || 'Online event')
      : (event.location_name || '')

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//CRM//Events//EN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${event.id}@crm`,
      `DTSTART:${fmt(start)}`,
      `DTEND:${fmt(end)}`,
      `SUMMARY:${event.title.replace(/[\\;,]/g, '')}`,
      location ? `LOCATION:${location.replace(/[\\;,]/g, '')}` : '',
      event.description ? `DESCRIPTION:${event.description.replace(/\n/g, '\\n').replace(/[\\;,]/g, '').substring(0, 300)}` : '',
      'STATUS:CONFIRMED',
      'END:VEVENT',
      'END:VCALENDAR',
    ].filter(Boolean).join('\r\n')

    return new NextResponse(ics, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${event.title.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 50).trim()}.ics"`,
      },
    })
  } catch (error) {
    console.error('[crm-events.calendar]', error)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
