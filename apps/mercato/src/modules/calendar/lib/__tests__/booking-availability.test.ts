/** @jest-environment node */
import {
  crmBusyIntervals,
  entryHoldsSlot,
  findBusyConflict,
  isSlotAvailable,
  loadCrmBusyIntervals,
  type CalendarEntryRow,
} from '../booking-availability'

const PAGE = 'page-1'
const SAME_OWNER_PAGE = 'page-2'
const TEAMMATE_PAGE = 'page-9'
const scope = { pageId: PAGE, samePersonPageIds: [PAGE, SAME_OWNER_PAGE] }

const now = new Date('2026-10-05T08:00:00.000Z')
const at = (hhmm: string) => new Date(`2026-10-05T${hhmm}:00.000Z`)
const slot = (hhmm: string, minutes = 30) => ({ start: at(hhmm), end: new Date(at(hhmm).getTime() + minutes * 60000) })
const row = (over: Partial<CalendarEntryRow>): CalendarEntryRow => ({
  booking_page_id: PAGE,
  status: 'confirmed',
  start_time: at('09:00'),
  end_time: at('09:30'),
  ...over,
})

describe('public booking slot filter without Google Calendar', () => {
  // No Google busy times at all: only the CRM's own calendar entries.
  const rows: CalendarEntryRow[] = [
    // Blocked time: no booking page, status blocked (POST /api/calendar/events/block).
    row({ booking_page_id: null, status: 'blocked', start_time: at('10:00'), end_time: at('11:00') }),
    // A pending booking on this page, waiting for the owner to confirm.
    row({ status: 'pending', start_time: at('12:00'), end_time: at('12:30') }),
    // A confirmed booking made through the owner's other booking page.
    row({ booking_page_id: SAME_OWNER_PAGE, status: 'confirmed', start_time: at('13:00'), end_time: at('13:30') }),
    // A manual event on the org calendar (POST /api/calendar/events/create).
    row({ booking_page_id: null, status: 'confirmed', start_time: at('14:00'), end_time: at('14:30') }),
    // These must NOT hide a slot:
    row({ status: 'cancelled', start_time: at('15:00'), end_time: at('15:30') }),
    row({ booking_page_id: TEAMMATE_PAGE, status: 'confirmed', start_time: at('16:00'), end_time: at('16:30') }),
  ]
  const busy = crmBusyIntervals(rows, scope)

  it('hides slots covered by blocked time', () => {
    expect(isSlotAvailable(slot('10:00'), busy, now)).toBe(false)
    expect(isSlotAvailable(slot('10:30'), busy, now)).toBe(false)
  })

  it('hides slots held by a pending booking', () => {
    expect(isSlotAvailable(slot('12:00'), busy, now)).toBe(false)
  })

  it("hides slots booked through the owner's other booking page", () => {
    expect(isSlotAvailable(slot('13:00'), busy, now)).toBe(false)
  })

  it('hides slots covered by a manual calendar event', () => {
    expect(isSlotAvailable(slot('14:00'), busy, now)).toBe(false)
  })

  it("keeps slots whose only entry is cancelled or on a teammate's page", () => {
    expect(isSlotAvailable(slot('15:00'), busy, now)).toBe(true)
    expect(isSlotAvailable(slot('16:00'), busy, now)).toBe(true)
  })

  it('keeps back-to-back slots around a busy block open', () => {
    expect(isSlotAvailable(slot('09:30'), busy, now)).toBe(true)
    expect(isSlotAvailable(slot('11:00'), busy, now)).toBe(true)
  })

  it('hides a partial overlap', () => {
    expect(isSlotAvailable(slot('11:45', 30), busy, now)).toBe(false)
  })

  it('hides slots that already started', () => {
    expect(isSlotAvailable(slot('07:30'), [], now)).toBe(false)
    expect(isSlotAvailable(slot('08:00'), [], now)).toBe(false)
  })
})

describe('entryHoldsSlot', () => {
  it('only confirmed, pending and blocked entries hold a slot', () => {
    expect(entryHoldsSlot(row({ status: 'confirmed' }), scope)).toBe(true)
    expect(entryHoldsSlot(row({ status: 'pending' }), scope)).toBe(true)
    expect(entryHoldsSlot(row({ status: 'blocked', booking_page_id: null }), scope)).toBe(true)
    expect(entryHoldsSlot(row({ status: 'cancelled' }), scope)).toBe(false)
    expect(entryHoldsSlot(row({ status: null }), scope)).toBe(false)
  })

  it('a page with no owner still counts its own bookings and the org calendar', () => {
    const ownerless = { pageId: PAGE, samePersonPageIds: [] }
    expect(entryHoldsSlot(row({}), ownerless)).toBe(true)
    expect(entryHoldsSlot(row({ booking_page_id: null, status: 'blocked' }), ownerless)).toBe(true)
    expect(entryHoldsSlot(row({ booking_page_id: SAME_OWNER_PAGE }), ownerless)).toBe(false)
  })
})

describe('findBusyConflict (booking create re-check)', () => {
  it('returns the overlapping interval, or null', () => {
    const busy = [{ start: at('10:00').toISOString(), end: at('11:00').toISOString() }]
    expect(findBusyConflict(busy, at('10:30'), at('11:00'))).toEqual(busy[0])
    expect(findBusyConflict(busy, at('11:00'), at('11:30'))).toBeNull()
  })
})

describe('loadCrmBusyIntervals', () => {
  it('scopes both queries to the tenant and organization and filters statuses in SQL', async () => {
    const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = []
    const db: any = (table: string) => {
      const ops: Array<[string, unknown[]]> = []
      calls.push({ table, ops })
      const q: any = {}
      for (const op of ['where', 'whereIn']) q[op] = (...args: unknown[]) => { ops.push([op, args]); return q }
      q.select = async () => {
        if (table === 'booking_pages') return [{ id: PAGE }, { id: SAME_OWNER_PAGE }]
        return [
          row({ booking_page_id: null, status: 'blocked', start_time: at('10:00'), end_time: at('11:00') }),
          row({ booking_page_id: TEAMMATE_PAGE }),
        ]
      }
      return q
    }
    const page = { id: PAGE, tenant_id: 't-1', organization_id: 'o-1', owner_user_id: 'u-1' }
    const busy = await loadCrmBusyIntervals(db, page, at('08:00'), at('18:00'))

    expect(busy).toEqual([{ start: at('10:00').toISOString(), end: at('11:00').toISOString() }])
    for (const call of calls) {
      expect(call.ops).toEqual(expect.arrayContaining([
        ['where', ['tenant_id', 't-1']],
        ['where', ['organization_id', 'o-1']],
      ]))
    }
    const bookingsCall = calls.find((c) => c.table === 'bookings')!
    expect(bookingsCall.ops).toEqual(expect.arrayContaining([
      ['whereIn', ['status', ['confirmed', 'pending', 'blocked']]],
      ['where', ['end_time', '>', at('08:00')]],
      ['where', ['start_time', '<', at('18:00')]],
    ]))
  })
})
