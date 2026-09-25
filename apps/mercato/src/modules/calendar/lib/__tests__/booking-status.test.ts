import { canTransitionBookingStatus, isBlockedCalendarEntry } from '../booking-status'

describe('canTransitionBookingStatus', () => {
  it('allows the guest booking lifecycle', () => {
    expect(canTransitionBookingStatus('pending', 'confirmed')).toBe(true)
    expect(canTransitionBookingStatus('pending', 'cancelled')).toBe(true)
    expect(canTransitionBookingStatus('confirmed', 'cancelled')).toBe(true)
  })

  it('lets a focus-time block be cancelled', () => {
    expect(canTransitionBookingStatus('blocked', 'cancelled')).toBe(true)
  })

  it('treats an unchanged status as allowed', () => {
    expect(canTransitionBookingStatus('blocked', 'blocked')).toBe(true)
  })

  it('rejects everything else', () => {
    expect(canTransitionBookingStatus('cancelled', 'confirmed')).toBe(false)
    expect(canTransitionBookingStatus('confirmed', 'pending')).toBe(false)
    expect(canTransitionBookingStatus('blocked', 'confirmed')).toBe(false)
    expect(canTransitionBookingStatus('confirmed', 'blocked')).toBe(false)
    expect(canTransitionBookingStatus(null, 'cancelled')).toBe(false)
  })
})

describe('isBlockedCalendarEntry', () => {
  it('recognises blocks by type, status or the internal guest address', () => {
    expect(isBlockedCalendarEntry({ type: 'blocked' })).toBe(true)
    expect(isBlockedCalendarEntry({ type: 'booking', status: 'blocked' })).toBe(true)
    expect(isBlockedCalendarEntry({ type: 'booking', guestEmail: 'blocked@internal.local' })).toBe(true)
  })

  it('does not treat guest bookings as blocks', () => {
    expect(isBlockedCalendarEntry({ type: 'booking', status: 'confirmed', guestEmail: 'a@b.com' })).toBe(false)
    expect(isBlockedCalendarEntry(null)).toBe(false)
  })
})
