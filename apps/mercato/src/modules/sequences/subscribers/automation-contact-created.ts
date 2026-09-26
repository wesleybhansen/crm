import type { EntityManager } from '@mikro-orm/postgresql'
import { dispatchContactCreated, loadCreatedPersonContext } from '../lib/automation-dispatch'

/**
 * A contact was added through the customers create command (the Contacts page
 * "Add contact" form, the people API, the AI assistant, inbox actions): run
 * `contact_created` rules and contact-created sequences, once per contact.
 * Only the import, form and landing page routes used to run these, so a
 * contact added by hand never triggered "Contact created".
 */
export const metadata = {
  event: 'customers.person.created',
  persistent: true,
  id: 'sequences:automation-contact-created',
}

type Payload = { id?: string; organizationId?: string | null; tenantId?: string | null }

export default async function handler(payload: Payload, ctx: { resolve: <T = unknown>(name: string) => T }) {
  if (!payload?.id || !payload.organizationId || !payload.tenantId) return
  try {
    const knex = ctx.resolve<EntityManager>('em').getKnex()
    const scope = { organizationId: payload.organizationId, tenantId: payload.tenantId }
    const person = await loadCreatedPersonContext(knex, scope, payload.id)
    if (!person) return
    await dispatchContactCreated(knex, { ...scope, contactId: person.contactId, source: person.source })
  } catch (err) {
    console.error('[sequences.automation-contact-created] dispatch failed', { personId: payload.id, err })
  }
}
