import type { Knex } from 'knex'
import { decryptRowFields, CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'

/*
 * Has this contact opted out of the business's email (email_unsubscribes: the
 * preferences page "unsubscribe from all", a bounce or a complaint)? Used
 * before an automatic enrollment into a sequence, so a contact who opted out
 * is never put back on an email schedule by a later registration or purchase.
 *
 * Matched by contact id, or by address: the decrypted primary email, and the
 * stored value as written (older rows hold ciphertext or mixed case). Every
 * query is scoped to the organization and tenant.
 *
 * Relative imports and packages only: reachable from worker-bundled subscribers.
 */

type Scope = { organizationId: string; tenantId: string }

export async function isContactUnsubscribed(
  knex: Knex,
  scope: Scope,
  contactId: string,
  extraEmails: Array<string | null | undefined> = [],
): Promise<boolean> {
  const contact = await knex('customer_entities')
    .where('id', contactId)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .first('id', 'primary_email')

  const stored = typeof contact?.primary_email === 'string' ? contact.primary_email : ''
  let plain = ''
  if (stored) {
    const readable: { primary_email: unknown } = { primary_email: stored }
    try {
      await decryptRowFields(null, CONTACT_ENTITY_KEY, [readable], ['primary_email'], scope.tenantId, scope.organizationId)
    } catch {
      // Fall back to the id, the stored value and the caller's addresses.
    }
    const decrypted = readable.primary_email
    if (typeof decrypted === 'string' && !isEncryptedEnvelope(decrypted)) plain = String(decrypted).trim().toLowerCase()
  }
  const extras = extraEmails
    .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
    .filter(Boolean)
  const emails = Array.from(new Set([plain, stored, stored.toLowerCase(), ...extras].filter(Boolean)))

  const row = await knex('email_unsubscribes')
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .where(function (this: Knex.QueryBuilder) {
      this.where('contact_id', contactId)
      if (emails.length) this.orWhereIn('email', emails)
    })
    .first('id')
  return !!row
}
