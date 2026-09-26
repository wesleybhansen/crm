import type { EntityManager } from '@mikro-orm/postgresql'
import { addInvoiceContactToPaidLists } from '../lib/list-auto-add'

/** An invoice was paid: add its contact to the "Paid an invoice" mailing lists, once per invoice. */
export const metadata = {
  event: 'payments.invoice.paid',
  persistent: true,
  id: 'email:list-auto-add-invoice-paid',
}

type Payload = { id?: string; organizationId?: string; tenantId?: string; contactId?: string | null }

export default async function handler(payload: Payload, ctx: { resolve: <T = unknown>(name: string) => T }) {
  if (!payload?.id || !payload.organizationId || !payload.tenantId) return
  try {
    const knex = ctx.resolve<EntityManager>('em').getKnex()
    await addInvoiceContactToPaidLists(
      knex,
      { organizationId: payload.organizationId, tenantId: payload.tenantId },
      { invoiceId: payload.id, contactId: payload.contactId ?? null },
    )
  } catch (err) {
    console.error('[email.list-auto-add-invoice-paid] failed', { invoiceId: payload.id, err })
  }
}
