/* Booking status transitions allowed through PUT /api/calendar/bookings.
 *
 * 'blocked' is a focus-time / personal-time block the owner put on their own
 * calendar (no guest). Cancelling one is allowed so that Cancel from the
 * Upcoming list and Scout's manage_booking cancel both work on blocks
 * instead of failing with a 400. */
export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'blocked'

const VALID_TRANSITIONS: ReadonlyArray<{ from: string; to: string }> = [
  { from: 'confirmed', to: 'cancelled' },
  { from: 'pending', to: 'confirmed' },
  { from: 'pending', to: 'cancelled' },
  { from: 'blocked', to: 'cancelled' },
]

export function canTransitionBookingStatus(from: string | null | undefined, to: string): boolean {
  if (!from) return false
  if (from === to) return true
  return VALID_TRANSITIONS.some((t) => t.from === from && t.to === to)
}

/** A calendar entry the owner blocked for themselves: no attendees to notify. */
export function isBlockedCalendarEntry(entry: { type?: string | null; status?: string | null; guestEmail?: string | null } | null | undefined): boolean {
  if (!entry) return false
  return entry.type === 'blocked' || entry.status === 'blocked' || entry.guestEmail === 'blocked@internal.local'
}
