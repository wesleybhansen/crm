
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export const metadata = { path: '/crm-events/[id]/calendar', GET: { requireAuth: false } }

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const event = await knex('events').where('id', id).whereNull('deleted_at').first()
    if (!event) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const start = new Date(event.start_time)
    const end = event.end_time ? new Date(event.end_time) : new Date(start.getTime() + 60 * 60 * 1000)

    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    const location = event.event_type === 'virtual'
      ? (event.virtual_link || 'Virtual')
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
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
