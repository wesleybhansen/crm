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
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret || !connection.refresh_token) {
    throw new Error('Cannot refresh Google token — missing credentials')
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: connection.refresh_token,
      grant_type: 'refresh_token',
    }),
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
 */
export async function createGoogleCalendarEvent(
  userId: string,
  event: {
    summary: string
    description?: string
    startTime: Date
    endTime: Date
    attendeeEmail?: string
  },
): Promise<string | null> {
  const container = await createRequestContainer()
  const knex = (container.resolve('em') as EntityManager).getKnex()

  const connection = await knex('google_calendar_connections')
    .where('user_id', userId)
    .where('is_active', true)
    .first() as CalendarConnection | undefined

  if (!connection) return null

  try {
    const accessToken = await refreshTokenIfNeeded(connection)

    const calendarEvent: any = {
      summary: event.summary,
      description: event.description || '',
      start: { dateTime: event.startTime.toISOString() },
      end: { dateTime: event.endTime.toISOString() },
    }

    if (event.attendeeEmail) {
      calendarEvent.attendees = [{ email: event.attendeeEmail }]
    }

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${connection.calendar_id}/events`,
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
    return data.id || null
  } catch (error) {
    console.error('[google-calendar] Failed to create event:', error)
    return null
  }
}
