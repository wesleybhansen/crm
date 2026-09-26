import type { Knex } from 'knex'
import { decryptRowFields, CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'

/*
 * Has this person opted out of the business's email (email_unsubscribes: the
 * preferences page "unsubscribe from all", a hard bounce or a spam
 * complaint)? One store, one matching rule, used by every marketing and
 * automation email path:
 *
 * - at SEND time, by sendEmailByPurpose for the 'marketing' and 'automations'
 *   purposes (the definitive gate: sequences, automation emails and surveys,
 *   review requests, event broadcasts, campaigns), and by the sequence email
 *   step before it writes anything;
 * - at ENROLLMENT, by every way into a sequence (manual, triggers, the
 *   automation "Enroll in sequence" action, the inbox suggestion).
 *
 * Transactional purposes ('transactional', 'invoices', 'inbox') are never
 * checked: a person who unsubscribed from marketing still gets their receipt,
 * booking confirmation or course sign-in link.
 *
 * Matched by contact id, or by address, case-insensitively: the address being
 * sent to, the contact's decrypted primary email, and the stored value as
 * written (older rows hold ciphertext). Every query is scoped to the
 * organization and tenant, so one business's unsubscribes never touch another.
 *
 * Relative imports and packages only: reachable from worker-bundled subscribers.
 */

type Scope = { organizationId: string; tenantId?: string | null }

export const UNSUBSCRIBED_CODE = 'unsubscribed'
/** A send the gate refused (the router's error, the timeline, an automation run). */
export const UNSUBSCRIBED_SEND_REASON = 'Not sent: this person unsubscribed from your emails.'
/** An enrollment the gate refused (manual enroll, triggers, automation action). */
export const UNSUBSCRIBED_ENROLL_REASON = 'Not enrolled: this person unsubscribed from your emails.'
/** A sequence stopped at an email step (shown on the enrollment). */
export const UNSUBSCRIBED_STOP_REASON =
  'Stopped: this person unsubscribed from your emails, so this sequence sends them nothing more.'

/** The purposes the unsubscribe gate applies to. Everything else is transactional. */
export const UNSUBSCRIBE_GATED_PURPOSES = ['marketing', 'automations'] as const

export function isUnsubscribeGatedPurpose(purpose: string): boolean {
  return (UNSUBSCRIBE_GATED_PURPOSES as readonly string[]).includes(purpose)
}

function normalized(values: Array<string | null | undefined>): string[] {
  const out = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim().toLowerCase()
    if (trimmed) out.add(trimmed)
  }
  return Array.from(out)
}

/**
 * One query against email_unsubscribes: a row for this contact, or for any of
 * these addresses (compared lowercased), in this organization and tenant.
 */
export async function isRecipientUnsubscribed(
  knex: Knex,
  scope: Scope,
  recipient: { contactId?: string | null; emails?: Array<string | null | undefined> },
): Promise<boolean> {
  if (!scope.organizationId) throw new Error('isRecipientUnsubscribed: organizationId is required')
  const contactId = typeof recipient.contactId === 'string' && recipient.contactId ? recipient.contactId : null
  const emails = normalized(recipient.emails ?? [])
  if (!contactId && !emails.length) return false

  let query = knex('email_unsubscribes').where('organization_id', scope.organizationId)
  if (scope.tenantId) query = query.where('tenant_id', scope.tenantId)
  const row = await query
    .where(function (this: Knex.QueryBuilder) {
      if (contactId) this.where('contact_id', contactId)
      if (emails.length) this.orWhereRaw(`lower(email) in (${emails.map(() => '?').join(', ')})`, emails)
    })
    .first('id')
  return !!row
}

/**
 * Has this contact unsubscribed? Reads the contact (in this organization and
 * tenant) for its address, decrypted and as stored, and checks it with the
 * contact id and any addresses the caller carries (a registration or checkout
 * email). Used before an enrollment, where no address is at hand yet.
 */
export async function isContactUnsubscribed(
  knex: Knex,
  scope: { organizationId: string; tenantId: string },
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
    if (typeof decrypted === 'string' && !isEncryptedEnvelope(decrypted)) plain = decrypted
  }
  return isRecipientUnsubscribed(knex, scope, { contactId, emails: [plain, stored, ...extraEmails] })
}
