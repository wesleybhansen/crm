import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  // Emitted once when an invoice becomes paid (marked paid, or paid by Stripe
  // checkout). Automation rules and sequences with an invoice_paid trigger run on it.
  { id: 'payments.invoice.paid', label: 'Invoice Paid', entity: 'invoice', category: 'lifecycle' as const },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'payments', events })
export default eventsConfig
