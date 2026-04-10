/**
 * Google Calendar Service
 * Handles token refresh, busy time fetching, and event creation.
 */

import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

interface CalendarConnection {
  id: string
  access_token: string
  refresh_token: string
  token_expiry: string
  calendar_id: string
  google_email: string
}

async function refreshTokenIfNeeded(connection: CalendarConnection): Promise<string> {
  const expiry = new Date(connection.token_expiry)
  if (expiry > new Date(Date.now() + 5 * 60 * 1000)) {
    return connection.access_token // Still valid
  }

  // Refresh the token
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  if (!clientId || !connection.refresh_token) {
    throw new Error('Cannot refresh Google token — missing credentials')
  }

  const body: Record<string, string> = {
    client_id: clientId,
    refresh_token: connection.refresh_token,
    grant_type: 'refresh_token',
  }
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (clientSecret) body.client_secret = clientSecret

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  const tokens = await res.json()

  if (!tokens.access_token) {
    throw new Error('Token refresh failed')
  }

  // Update in database
  const container = await createRequestContainer()
  const knex = (container.resolve('em') as EntityManager).getKnex()
  await knex('google_calendar_connections').where('id', connection.id).update({
    access_token: tokens.access_token,
    token_expiry: new Date(Date.now() + (tokens.expires_in || 3600) * 1000),
    updated_at: new Date(),
  })

  return tokens.access_token
}

/**
 * Get busy times from Google Calendar for a date range.
 */
export async function getGoogleBusyTimes(
  userId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<Array<{ start: string; end: string }>> {
  const container = await createRequestContainer()
  const knex = (container.resolve('em') as EntityManager).getKnex()

  const connection = await knex('google_calendar_connections')
    .where('user_id', userId)
    .where('is_active', true)
    .first() as CalendarConnection | undefined

  if (!connection) return []

  try {
    const accessToken = await refreshTokenIfNeeded(connection)

    const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        items: [{ id: connection.calendar_id }],
      }),
    })

    const data = await res.json()
    const busy = data.calendars?.[connection.calendar_id]?.busy || []
    return busy.map((b: any) => ({ start: b.start, end: b.end }))
  } catch (error) {
    console.error('[google-calendar] Failed to get busy times:', error)
    return []
  }
}

/**
 * Create an event on the user's Google Calendar.
 * Supports automatic Google Meet link generation when meetingType is 'google_meet'.
 */
export async function createGoogleCalendarEvent(
  userId: string,
  event: {
    summary: string
    description?: string
    startTime: Date
    endTime: Date
    attendeeEmail?: string
    meetingType?: 'google_meet' | 'zoom' | 'phone' | 'in_person'
    meetingLocation?: string
    meetingLink?: string
  },
): Promise<{ eventId: string | null; meetLink: string | null; htmlLink: string | null } | null> {
  const container = await createRequestContainer()
  const knex = (container.resolve('em') as EntityManager).getKnex()

  const connection = await knex('google_calendar_connections')
    .where('user_id', userId)
    .where('is_active', true)
    .first() as CalendarConnection | undefined

  if (!connection) return null

  try {
    const accessToken = await refreshTokenIfNeeded(connection)

    // Build description with meeting details
    let description = event.description || ''
    if (event.meetingType === 'zoom' && event.meetingLink) {
      description += `\n\nJoin via Zoom: ${event.meetingLink}`
    } else if (event.meetingType === 'phone' && event.meetingLocation) {
      description += `\n\nPhone: ${event.meetingLocation}`
    } else if (event.meetingType === 'in_person' && event.meetingLocation) {
      description += `\n\nLocation: ${event.meetingLocation}`
    } else if (event.meetingType === 'google_meet') {
      description += '\n\nGoogle Meet link will be generated automatically.'
    }

    const calendarEvent: any = {
      summary: event.summary,
      description,
      start: { dateTime: event.startTime.toISOString() },
      end: { dateTime: event.endTime.toISOString() },
    }

    if (event.attendeeEmail) {
      calendarEvent.attendees = [{ email: event.attendeeEmail }]
    }

    // Set location for in-person meetings
    if (event.meetingType === 'in_person' && event.meetingLocation) {
      calendarEvent.location = event.meetingLocation
    }

    // Add conference data for Google Meet
    if (event.meetingType === 'google_meet') {
      calendarEvent.conferenceData = {
        createRequest: {
          requestId: require('crypto').randomUUID(),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      }
    }

    // Add conferenceDataVersion=1 when creating a Meet link
    // sendUpdates=none prevents Google from sending its own invitation email (we send our own)
    const queryParams = new URLSearchParams({ sendUpdates: 'none' })
    if (event.meetingType === 'google_meet') queryParams.set('conferenceDataVersion', '1')
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${connection.calendar_id}/events?${queryParams}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(calendarEvent),
      }
    )

    const data = await res.json()
    const meetLink = data.conferenceData?.entryPoints?.[0]?.uri || data.hangoutLink || null
    return { eventId: data.id || null, meetLink, htmlLink: data.htmlLink || null }
  } catch (error) {
    console.error('[google-calendar] Failed to create event:', error)
    return null
  }
}

/**
 * Delete an event from Google Calendar.
 */
export async function deleteGoogleCalendarEvent(
  userId: string,
  eventId: string,
): Promise<boolean> {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const connection = await knex('google_calendar_connections')
      .where('user_id', userId).where('is_active', true).first()
    if (!connection) return false

    const accessToken = await refreshTokenIfNeeded(connection)
    if (!accessToken) return false

    const calendarId = encodeURIComponent(connection.calendar_id || 'primary')
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${eventId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
    )
    return res.ok || res.status === 404 // 404 = already deleted
  } catch {
    return false
  }
}

/**
 * List events from the user's Google Calendar for a date range.
 */
export async function listGoogleCalendarEvents(
  userId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<Array<{
  id: string; summary: string; start: string; end: string
  description: string | null; meetLink: string | null
  attendees: string[]; location: string | null; htmlLink: string | null
}>> {
  const container = await createRequestContainer()
  const knex = (container.resolve('em') as EntityManager).getKnex()

  const connections = await knex('google_calendar_connections')
    .where('user_id', userId)
    .where('is_active', true) as CalendarConnection[]

  if (!connections.length) return []

  const allEvents: Array<{
    id: string; summary: string; start: string; end: string
    description: string | null; meetLink: string | null
    attendees: string[]; location: string | null; htmlLink: string | null
  }> = []

  for (const connection of connections) {
    try {
      const accessToken = await refreshTokenIfNeeded(connection)

      const params = new URLSearchParams({
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
      })

      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(connection.calendar_id)}/events?${params}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      )

      const data = await res.json()
      const items = data.items || []

      for (const item of items) {
        const startDateTime = item.start?.dateTime || item.start?.date || ''
        const endDateTime = item.end?.dateTime || item.end?.date || ''
        if (!startDateTime || !endDateTime) continue

        const meetLink =
          item.hangoutLink ||
          item.conferenceData?.entryPoints?.[0]?.uri ||
          null

        const attendees = (item.attendees || []).map((a: any) => a.email).filter(Boolean)

        allEvents.push({
          id: item.id || '',
          summary: item.summary || '(No title)',
          start: startDateTime,
          end: endDateTime,
          description: item.description || null,
          meetLink,
          attendees,
          location: item.location || null,
          htmlLink: item.htmlLink || null,
        })
      }
    } catch (error) {
      console.error('[google-calendar] Failed to list events for calendar:', connection.calendar_id, error)
    }
  }

  return allEvents
}
