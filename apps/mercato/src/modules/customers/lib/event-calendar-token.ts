import crypto from 'crypto'

/**
 * Signed token for the public "Add to calendar" link in event registration
 * emails (/api/crm-events/{id}/calendar?t=...).
 *
 * The route is public (attendees are signed out), so an event id alone used to
 * return the event's details, including the private join link, for any event
 * in any org (security sweep 2026-09-25, medium 4). The route now serves only
 * published events, and includes the join link only when the request carries
 * this token, which only a registration email has. Same key chain as the
 * email-preference token (lib/email-token.ts).
 */

function signingKey(): string | null {
  return (
    process.env.OAUTH_STATE_SECRET ||
    process.env.NOLI_INTERNAL_SERVICE_SECRET ||
    process.env.JWT_SECRET ||
    null
  )
}

function mac(eventId: string, key: string): string {
  return crypto.createHmac('sha256', key).update(`crm-event-calendar:${eventId}`).digest('base64url')
}

/** Token for an event's calendar link, or null when no secret is configured. */
export function signEventCalendarToken(eventId: string): string | null {
  const key = signingKey()
  return key ? mac(eventId, key) : null
}

export function verifyEventCalendarToken(eventId: string, token: string | null | undefined): boolean {
  const key = signingKey()
  if (!key || !token) return false
  const expected = Buffer.from(mac(eventId, key))
  const given = Buffer.from(token)
  return expected.length === given.length && crypto.timingSafeEqual(expected, given)
}
