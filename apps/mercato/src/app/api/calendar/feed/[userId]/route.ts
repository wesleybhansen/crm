import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

// Public .ics calendar feed — subscribe from Apple Calendar, Outlook, etc.
export async function GET(req: Request, { params }: { params: { userId: string } }) {
  try {
    const userId = params.userId?.replace('.ics', '')
    if (!userId) return new NextResponse('Not found', { status: 404 })

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Get user's org
    const user = await knex('users').where('id', userId).first()
    if (!user) return new NextResponse('Not found', { status: 404 })

    // Get upcoming bookings for this user's org
    const bookings = await knex('bookings')
      .where('organization_id', user.organization_id)
      .where('status', 'confirmed')
      .where('start_time', '>=', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)) // last 30 days + future
      .orderBy('start_time')
      .limit(200)

    // Generate iCalendar format
    const events = bookings.map((b: any) => {
      const start = formatICSDate(new Date(b.start_time))
      const end = formatICSDate(new Date(b.end_time))
      const created = formatICSDate(new Date(b.created_at))
      return [
        'BEGIN:VEVENT',
        `UID:${b.id}@crm`,
        `DTSTART:${start}`,
        `DTEND:${end}`,
        `CREATED:${created}`,
        `SUMMARY:${escapeICS(b.guest_name || 'Booking')}`,
        `DESCRIPTION:${escapeICS(`${b.guest_email || ''}${b.notes ? '\\n' + b.notes : ''}`)}`,
        `STATUS:CONFIRMED`,
        'END:VEVENT',
      ].join('\r\n')
    })

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//CRM//Bookings//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:CRM Bookings',
      ...events,
      'END:VCALENDAR',
    ].join('\r\n')

    return new NextResponse(ics, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="bookings.ics"',
        'Cache-Control': 'public, max-age=300', // 5 min cache
      },
    })
  } catch (error) {
    console.error('[calendar.feed]', error)
    return new NextResponse('Server error', { status: 500 })
  }
}

function formatICSDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function escapeICS(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
}
