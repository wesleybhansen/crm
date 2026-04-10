import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['calendar.view'] },
}

interface UnifiedEvent {
  id: string
  title: string
  start: string
  end: string
  source: 'crm' | 'google'
  type: 'booking' | 'blocked' | 'google_event'
  status: string | null
  meetingType: string | null
  meetLink: string | null
  guestName: string | null
  guestEmail: string | null
  guestPhone: string | null
  meetingLocation: string | null
  color: string | null
  editable: boolean
  googleHtmlLink: string | null
  recurrenceRule: unknown | null
  recurrenceParentId: string | null
}

export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth || await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const url = new URL(req.url)
    const startParam = url.searchParams.get('start')
    const endParam = url.searchParams.get('end')

    if (!startParam || !endParam) {
      return NextResponse.json({ ok: false, error: 'start and end query parameters required' }, { status: 400 })
    }

    const start = new Date(startParam)
    const end = new Date(endParam)

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return NextResponse.json({ ok: false, error: 'Invalid date format for start or end' }, { status: 400 })
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Fetch CRM bookings for the date range
    // Fetch ALL bookings (including cancelled) so we can:
    // 1. Show active ones on the calendar
    // 2. Use cancelled ones for dedup against Google Calendar ghosts
    const allBookings = await knex('bookings')
      .where('organization_id', auth.orgId)
      .where('start_time', '<=', end)
      .where('end_time', '>=', start)

    const bookings = allBookings.filter((b: any) => ['confirmed', 'pending', 'blocked'].includes(b.status))

    // Build dedup set from ALL bookings (including cancelled) to prevent Google Calendar ghosts
    const linkedGoogleEventIds = new Set<string>()
    for (const booking of allBookings) {
      if (booking.google_calendar_event_id) {
        linkedGoogleEventIds.add(booking.google_calendar_event_id)
      }
    }

    // Get Google Calendar email for constructing event links
    let googleCalEmail: string | null = null
    try {
      const gcConn = await knex('google_calendar_connections')
        .where('user_id', auth.sub).where('is_active', true).first()
      if (gcConn) googleCalEmail = gcConn.google_email || null
    } catch {}

    // Map CRM bookings to unified events
    const events: UnifiedEvent[] = bookings.map((booking: any) => {
      const isBlocked = booking.status === 'blocked'
      return {
        id: booking.id,
        title: isBlocked ? (booking.guest_name === 'Blocked' ? 'Blocked' : booking.guest_name || 'Blocked') : (booking.guest_name || 'Untitled Booking'),
        start: new Date(booking.start_time).toISOString(),
        end: new Date(booking.end_time).toISOString(),
        source: 'crm' as const,
        type: isBlocked ? 'blocked' as const : 'booking' as const,
        status: booking.status,
        meetingType: booking.meeting_type || null,
        meetLink: booking.meeting_link || null,
        guestName: booking.guest_name || null,
        guestEmail: booking.guest_email || null,
        guestPhone: booking.guest_phone || null,
        meetingLocation: booking.meeting_location || null,
        color: isBlocked ? '#94a3b8' : null,
        editable: true,
        googleHtmlLink: booking.google_calendar_html_link
          || (booking.google_calendar_event_id && googleCalEmail
            ? `https://calendar.google.com/calendar/event?eid=${Buffer.from(booking.google_calendar_event_id + ' ' + googleCalEmail).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
            : null),
        recurrenceRule: booking.recurrence_rule || null,
        recurrenceParentId: booking.recurrence_parent_id || null,
      }
    })

    // Fetch Google Calendar events
    try {
      const { listGoogleCalendarEvents } = await import('@/modules/calendar/lib/google-calendar-service')
      const googleEvents = await listGoogleCalendarEvents(auth.sub, start, end)

      for (const gEvent of googleEvents) {
        // Skip events already linked to a CRM booking
        if (linkedGoogleEventIds.has(gEvent.id)) continue

        events.push({
          id: `google_${gEvent.id}`,
          title: gEvent.summary,
          start: gEvent.start,
          end: gEvent.end,
          source: 'google',
          type: 'google_event',
          status: null,
          meetingType: gEvent.meetLink ? 'google_meet' : null,
          meetLink: gEvent.meetLink,
          guestName: null,
          guestEmail: gEvent.attendees.length > 0 ? gEvent.attendees[0] : null,
          guestPhone: null,
          meetingLocation: gEvent.location,
          color: '#e2e8f0',
          editable: false,
          googleHtmlLink: gEvent.htmlLink,
          recurrenceRule: null,
          recurrenceParentId: null,
        })
      }
    } catch {
      // Google Calendar fetch failed — return CRM events only
    }

    // Sort by start time
    events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())

    return NextResponse.json({ ok: true, data: events })
  } catch (error) {
    console.error('[calendar.events]', error)
    return NextResponse.json({ ok: false, error: 'Failed to fetch events' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Calendar', summary: 'Unified calendar events',
  methods: {
    GET: { summary: 'List unified calendar events (CRM + Google)', tags: ['Calendar'] },
  },
}
