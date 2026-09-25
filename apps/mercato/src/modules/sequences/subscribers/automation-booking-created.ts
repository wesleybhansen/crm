import type { EntityManager } from '@mikro-orm/postgresql'
import { dispatchAutomationTrigger, loadBookingContext } from '../lib/automation-dispatch'

/** Someone booked an appointment: run `booking_created` rules and sequences, once per booking. */
export const metadata = {
  event: 'calendar.booking.created',
  persistent: true,
  id: 'sequences:automation-booking-created',
}

type Payload = { id?: string; organizationId?: string; tenantId?: string; createdAt?: string; bookingPageId?: string | null; contactId?: string | null }

export default async function handler(payload: Payload, ctx: { resolve: <T = unknown>(name: string) => T }) {
  if (!payload?.id || !payload.organizationId || !payload.tenantId) return
  try {
    const knex = ctx.resolve<EntityManager>('em').getKnex()
    const scope = { organizationId: payload.organizationId, tenantId: payload.tenantId }
    const booking = await loadBookingContext(knex, scope, payload.id)
    if (!booking) return
    await dispatchAutomationTrigger(knex, {
      ...scope,
      triggerType: 'booking_created',
      eventKey: `booking:${payload.id}`,
      context: {
        bookingId: booking.bookingId,
        contactId: booking.contactId ?? payload.contactId ?? null,
        bookingPageId: booking.bookingPageId ?? payload.bookingPageId ?? null,
        startTime: booking.startTime,
      },
      sequenceTrigger: { type: 'booking_created' },
    })
  } catch (err) {
    console.error('[sequences.automation-booking-created] dispatch failed', { bookingId: payload.id, err })
  }
}
