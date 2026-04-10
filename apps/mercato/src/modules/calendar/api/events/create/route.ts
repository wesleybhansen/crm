import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'


export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['calendar.manage'] },
}

export async function POST(req: Request, ctx: any) {
  const auth = ctx?.auth || await getAuthFromCookies()
  if (!auth?.orgId || !auth?.tenantId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { title, date, startTime, durationMinutes, meetingType, meetingLocation, attendees, notes } = body

    if (!title || !date || !startTime) {
      return NextResponse.json({ ok: false, error: 'title, date, and startTime required' }, { status: 400 })
    }

    const start = new Date(`${date}T${startTime}`)
    if (isNaN(start.getTime())) {
      return NextResponse.json({ ok: false, error: 'Invalid date/time format' }, { status: 400 })
    }

    const duration = parseInt(durationMinutes) || 30
    const end = new Date(start.getTime() + duration * 60000)

    const id = require('crypto').randomUUID()
    const guestName = attendees?.[0]?.name || title
    const guestEmail = attendees?.[0]?.email || 'manual@event.local'
    const guestPhone = attendees?.[0]?.phone || null

    await knex('bookings').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      booking_page_id: null,
      guest_name: guestName,
      guest_email: guestEmail,
      guest_phone: guestPhone,
      start_time: start,
      end_time: end,
      status: 'confirmed',
      meeting_type: meetingType || 'in_person',
      meeting_location: meetingLocation || null,
      meeting_link: null,
      notes: notes || null,
      confirmed_at: new Date(),
      created_at: new Date(),
    })

    // Create Google Calendar event if connected
    try {
      const { createGoogleCalendarEvent } = await import('@/modules/calendar/lib/google-calendar-service')
      const result = await createGoogleCalendarEvent(auth.sub, {
        summary: title,
        description: notes || undefined,
        startTime: start,
        endTime: end,
        attendeeEmail: guestEmail !== 'manual@event.local' ? guestEmail : undefined,
        meetingType: meetingType || 'in_person',
        meetingLocation: meetingLocation || undefined,
      })
      if (result?.meetLink || result?.eventId || result?.htmlLink) {
        await knex('bookings').where('id', id).update({
          meeting_link: result.meetLink || null,
          google_calendar_event_id: result.eventId || null,
          google_calendar_html_link: result.htmlLink || null,
        })
      }
    } catch {
      // Google Calendar integration not available
    }

    return NextResponse.json({ ok: true, data: { id, start: start.toISOString(), end: end.toISOString() } }, { status: 201 })
  } catch (error) {
    console.error('[calendar.events.create]', error)
    return NextResponse.json({ ok: false, error: 'Failed to create event' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Calendar', summary: 'Create calendar event',
  methods: {
    POST: { summary: 'Create a new calendar event (manual)', tags: ['Calendar'] },
  },
}
