import type { EntityManager } from '@mikro-orm/postgresql'
import { dispatchAutomationTrigger, loadCreatedPersonContext } from '../lib/automation-dispatch'

/**
 * A contact was edited through the customers update command (the contact
 * form, the lifecycle stage picker, the people API, the AI assistant): run
 * `contact_updated` rules, once per save. The command stamps each save's
 * event with its own eventId, so the in-process delivery and the queued one
 * of the same save share a key and the next save gets a new one. An event
 * without an eventId (an older emitter) falls back to the contact's
 * updated_at, which both deliveries of one save also share.
 */
export const metadata = {
  event: 'customers.person.updated',
  persistent: true,
  id: 'sequences:automation-contact-updated',
}

type Payload = { id?: string; organizationId?: string | null; tenantId?: string | null; eventId?: string | null }

export default async function handler(payload: Payload, ctx: { resolve: <T = unknown>(name: string) => T }) {
  if (!payload?.id || !payload.organizationId || !payload.tenantId) return
  try {
    const knex = ctx.resolve<EntityManager>('em').getKnex()
    const scope = { organizationId: payload.organizationId, tenantId: payload.tenantId }
    const person = await loadCreatedPersonContext(knex, scope, payload.id)
    if (!person) return
    const occurrence = typeof payload.eventId === 'string' && payload.eventId ? payload.eventId : person.updatedAt
    if (!occurrence) return
    await dispatchAutomationTrigger(knex, {
      ...scope,
      triggerType: 'contact_updated',
      eventKey: `person:${person.contactId}:update:${occurrence}`,
      context: { contactId: person.contactId, source: person.source },
    })
  } catch (err) {
    console.error('[sequences.automation-contact-updated] dispatch failed', { personId: payload.id, err })
  }
}
