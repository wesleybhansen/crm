/* Which calendar entries make a public booking slot unavailable.
 *
 * The CRM's own calendar is the source of truth: confirmed bookings, pending
 * bookings (waiting for the owner to confirm) and blocked time all hold their
 * slot, whether or not Google Calendar is connected. Google busy times are an
 * extra layer added on top by the callers when the page owner connected
 * Google. Until 2026-09-25 the booking page and the booking POST only looked
 * at CONFIRMED bookings of the SAME page, so without Google a guest could book
 * over blocked time, over a pending booking, or over a booking made through
 * the owner's other booking page.
 *
 * Scope of "the owner's calendar": the bookings table has no owner column.
 *  - A booking made through a booking page belongs to that page's owner, so
 *    bookings on this page and on the owner's other pages hold the slot, and
 *    bookings on a teammate's page do not.
 *  - Blocked time and manual events have no booking page (and no owner), so
 *    they hold the slot for every booking page in the organization.
 *
 * Every query is tenant- and organization-scoped. Relative imports only. */
import type { Knex } from 'knex'

export const SLOT_HOLDING_STATUSES = ['confirmed', 'pending', 'blocked'] as const

/** How far ahead the public booking page loads the CRM's own busy times. */
export const PUBLIC_BOOKING_CRM_HORIZON_DAYS = 90

export type BusyInterval = { start: string; end: string }

export type CalendarEntryRow = {
  booking_page_id: string | null
  status: string | null
  start_time: Date | string
  end_time: Date | string
}

export type BookingPageRef = {
  id: string
  tenant_id: string
  organization_id: string
  owner_user_id?: string | null
}

/** The booking page being booked, plus the owner's other booking pages. */
export type BookingPageScope = { pageId: string; samePersonPageIds: readonly string[] }

type Db = Knex | Knex.Transaction

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

export function entryHoldsSlot(row: CalendarEntryRow, scope: BookingPageScope): boolean {
  if (!row.status || !(SLOT_HOLDING_STATUSES as readonly string[]).includes(row.status)) return false
  if (!row.booking_page_id) return true
  const pageId = String(row.booking_page_id)
  return pageId === scope.pageId || scope.samePersonPageIds.includes(pageId)
}

/** The CRM calendar entries that hold a slot for this page, as busy intervals. */
export function crmBusyIntervals(rows: readonly CalendarEntryRow[], scope: BookingPageScope): BusyInterval[] {
  const out: BusyInterval[] = []
  for (const row of rows) {
    if (!entryHoldsSlot(row, scope)) continue
    const start = toDate(row.start_time)
    const end = toDate(row.end_time)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue
    out.push({ start: start.toISOString(), end: end.toISOString() })
  }
  return out
}

/** Half-open overlap: back-to-back slots do not collide. */
export function intervalsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime()
}

export function findBusyConflict(busy: readonly BusyInterval[], start: Date, end: Date): BusyInterval | null {
  for (const interval of busy) {
    if (intervalsOverlap(start, end, new Date(interval.start), new Date(interval.end))) return interval
  }
  return null
}

/** The slot filter the booking page applies: future, and clear of every busy interval. */
export function isSlotAvailable(slot: { start: Date; end: Date }, busy: readonly BusyInterval[], now: Date): boolean {
  if (slot.start.getTime() <= now.getTime()) return false
  return findBusyConflict(busy, slot.start, slot.end) === null
}

export async function loadBookingPageScope(db: Db, page: BookingPageRef): Promise<BookingPageScope> {
  const pageId = String(page.id)
  if (!page.owner_user_id) return { pageId, samePersonPageIds: [] }
  const rows = await db('booking_pages')
    .where('tenant_id', page.tenant_id)
    .where('organization_id', page.organization_id)
    .where('owner_user_id', page.owner_user_id)
    .select('id')
  return { pageId, samePersonPageIds: rows.map((r: { id: string }) => String(r.id)) }
}

/** The CRM's own busy intervals for this page that overlap [from, to). */
export async function loadCrmBusyIntervals(db: Db, page: BookingPageRef, from: Date, to: Date): Promise<BusyInterval[]> {
  const scope = await loadBookingPageScope(db, page)
  const rows = (await db('bookings')
    .where('tenant_id', page.tenant_id)
    .where('organization_id', page.organization_id)
    .whereIn('status', [...SLOT_HOLDING_STATUSES])
    .where('end_time', '>', from)
    .where('start_time', '<', to)
    .select('booking_page_id', 'status', 'start_time', 'end_time')) as CalendarEntryRow[]
  return crmBusyIntervals(rows, scope)
}

/** Transaction-scoped lock that serializes guest bookings within one
 * organization, so two guests cannot both pass the conflict re-check for
 * overlapping slots (possibly on two of the owner's pages). */
export async function lockOrganizationBookings(trx: Knex.Transaction, organizationId: string): Promise<void> {
  await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`calendar-booking:${organizationId}`])
}
