/**
 * The CRM's business moments, emitted once each, for every listener at once:
 * automation rules and sequences (sequences/subscribers/automation-*.ts) and,
 * for a closed deal, the marketing app handoff (integrations_api outbox).
 *
 *   deal closed (won)  customers.deal.closed        core customers/lib/dealClosed.ts
 *   deal stage change  customers.deal.stage_changed the deal command, board and automations
 *   invoice paid       payments.invoice.paid        emitInvoicePaid (below)
 *   booking created    calendar.booking.created     emitBookingCreated (below)
 *
 * Emitting never throws: a listener's failure must not fail the write that
 * caused the event. Pure; safe for worker bundles.
 */
export { emitDealClosedIfTransitioned, DEAL_CLOSED_EVENT_ID } from '@open-mercato/core/modules/customers/lib/dealClosed'

export const INVOICE_PAID_EVENT_ID = 'payments.invoice.paid' as const
export const BOOKING_CREATED_EVENT_ID = 'calendar.booking.created' as const

type EventBusLike = {
  emitEvent?: (event: string, payload: Record<string, unknown>, options?: { persistent?: boolean }) => Promise<unknown> | unknown
} | null | undefined

export type InvoicePaidPayload = {
  id: string
  organizationId: string
  tenantId: string
  paidAt: string
  contactId?: string | null
}

export type BookingCreatedPayload = {
  id: string
  organizationId: string
  tenantId: string
  createdAt: string
  bookingPageId?: string | null
  contactId?: string | null
}

async function emitSafely(bus: EventBusLike, event: string, payload: Record<string, unknown>): Promise<boolean> {
  if (!bus?.emitEvent) return false
  try {
    await bus.emitEvent(event, payload, { persistent: true })
    return true
  } catch (err) {
    console.error(`[crm-business-events] ${event} emit failed`, err)
    return false
  }
}

export function emitInvoicePaid(bus: EventBusLike, payload: InvoicePaidPayload): Promise<boolean> {
  return emitSafely(bus, INVOICE_PAID_EVENT_ID, payload)
}

export function emitBookingCreated(bus: EventBusLike, payload: BookingCreatedPayload): Promise<boolean> {
  return emitSafely(bus, BOOKING_CREATED_EVENT_ID, payload)
}
