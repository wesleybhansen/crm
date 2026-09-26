import type { EntityManager } from '@mikro-orm/postgresql'
import { dispatchAutomationTrigger, loadInvoiceContext } from '../lib/automation-dispatch'

/** An invoice was paid: run `invoice_paid` rules and sequences, once per invoice. */
export const metadata = {
  event: 'payments.invoice.paid',
  persistent: true,
  id: 'sequences:automation-invoice-paid',
}

type Payload = { id?: string; organizationId?: string; tenantId?: string; paidAt?: string; contactId?: string | null }

export default async function handler(payload: Payload, ctx: { resolve: <T = unknown>(name: string) => T }) {
  if (!payload?.id || !payload.organizationId || !payload.tenantId) return
  try {
    const knex = ctx.resolve<EntityManager>('em').getKnex()
    const scope = { organizationId: payload.organizationId, tenantId: payload.tenantId }
    const invoice = await loadInvoiceContext(knex, scope, payload.id)
    if (!invoice) return
    await dispatchAutomationTrigger(knex, {
      ...scope,
      triggerType: 'invoice_paid',
      eventKey: `invoice:${payload.id}`,
      context: {
        invoiceId: invoice.invoiceId,
        contactId: invoice.contactId ?? payload.contactId ?? null,
        reference: invoice.reference,
        amount: invoice.amount,
        paidAt: payload.paidAt ?? null,
      },
      sequenceTrigger: { type: 'invoice_paid' },
    })
  } catch (err) {
    console.error('[sequences.automation-invoice-paid] dispatch failed', { invoiceId: payload.id, err })
  }
}
