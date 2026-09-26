import { randomUUID } from 'crypto'
import type { Knex } from 'knex'
import { decryptRowFields, CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'

/*
 * Mailing lists whose auto-add criteria is "Paid an invoice"
 * (email_lists.source_type = 'invoice_paid'). The Lists tab offered it, but no
 * code ever added anyone, so those lists stayed empty. A paid invoice
 * (payments.invoice.paid: marked paid, or paid through Stripe checkout) now
 * adds the invoice's contact to every such list, once per invoice:
 *
 * - once: the invoice is claimed in automation_trigger_dispatches (the same
 *   exactly-once ledger the automation triggers use, under its own trigger
 *   type), so the event's second delivery (the queued copy of an in-process
 *   event) or a retry never re-adds someone the owner took off the list;
 * - unsubscribes: a contact in email_unsubscribes for this organization (by
 *   contact id, or by their address, decrypted or as stored) is never added;
 * - every query is scoped to the invoice's organization and tenant.
 *
 * Relative imports and packages only: this runs from a worker-bundled subscriber.
 */

export const LIST_AUTO_ADD_LEDGER_TRIGGER = 'list_auto_add_invoice_paid'

export type InvoicePaidListResult =
  | { added: string[] }
  | { skipped: 'no_lists' | 'no_invoice' | 'no_contact' | 'unsubscribed' | 'already_done' }

type Scope = { organizationId: string; tenantId: string }

async function isUnsubscribed(knex: Knex, scope: Scope, contact: { id: string; primary_email?: unknown }): Promise<boolean> {
  const stored = typeof contact.primary_email === 'string' ? contact.primary_email : ''
  const readable: { primary_email: unknown } = { primary_email: contact.primary_email }
  try {
    await decryptRowFields(null, CONTACT_ENTITY_KEY, [readable], ['primary_email'], scope.tenantId, scope.organizationId)
  } catch {
    // Fall back to the id and the stored value below.
  }
  // String(): isEncryptedEnvelope is a type guard, so TS types this branch never.
  const decrypted = readable.primary_email
  const plain = typeof decrypted === 'string' && !isEncryptedEnvelope(decrypted)
    ? String(decrypted).trim().toLowerCase()
    : ''
  const emails = Array.from(new Set([plain, stored, stored.toLowerCase()].filter(Boolean)))
  const row = await knex('email_unsubscribes')
    .where('organization_id', scope.organizationId)
    .where(function (this: Knex.QueryBuilder) {
      this.where('contact_id', contact.id)
      if (emails.length) this.orWhereIn('email', emails)
    })
    .first('id')
  return !!row
}

export async function addInvoiceContactToPaidLists(
  knex: Knex,
  scope: Scope,
  input: { invoiceId: string; contactId?: string | null },
  now: Date = new Date(),
): Promise<InvoicePaidListResult> {
  const lists = await knex('email_lists')
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .where('source_type', 'invoice_paid')
    .whereNull('deleted_at')
    .select('id')
  if (!lists.length) return { skipped: 'no_lists' }

  const invoice = await knex('invoices')
    .where('id', input.invoiceId)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .first('id', 'contact_id')
  if (!invoice) return { skipped: 'no_invoice' }
  const contactId = invoice.contact_id ?? input.contactId ?? null
  if (!contactId) return { skipped: 'no_contact' }

  const contact = await knex('customer_entities')
    .where('id', contactId)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .whereNull('deleted_at')
    .first('id', 'primary_email')
  if (!contact) return { skipped: 'no_contact' }
  if (await isUnsubscribed(knex, scope, contact)) return { skipped: 'unsubscribed' }

  const claimed = await knex('automation_trigger_dispatches')
    .insert({
      id: randomUUID(),
      organization_id: scope.organizationId,
      tenant_id: scope.tenantId,
      trigger_type: LIST_AUTO_ADD_LEDGER_TRIGGER,
      event_key: `invoice:${input.invoiceId}`,
      created_at: now,
    })
    .onConflict(['organization_id', 'trigger_type', 'event_key'])
    .ignore()
    .returning('id')
  if (!Array.isArray(claimed) || claimed.length === 0) return { skipped: 'already_done' }

  const added: string[] = []
  for (const list of lists as Array<{ id: string }>) {
    await knex('email_list_members')
      .insert({
        id: randomUUID(),
        list_id: list.id,
        contact_id: contact.id,
        added_at: now,
        tenant_id: scope.tenantId,
        organization_id: scope.organizationId,
      })
      .onConflict(['list_id', 'contact_id'])
      .ignore()
    const [{ count }] = await knex('email_list_members')
      .where('list_id', list.id)
      .where('organization_id', scope.organizationId)
      .whereNull('deleted_at')
      .count('* as count')
    await knex('email_lists')
      .where('id', list.id)
      .where('organization_id', scope.organizationId)
      .where('tenant_id', scope.tenantId)
      .update({ member_count: Number(count), updated_at: now })
    added.push(list.id)
  }
  return { added }
}
