jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  ...jest.requireActual('@open-mercato/shared/lib/encryption/decryptRows'),
  // Stored addresses are "enc(<address>)"; decrypting takes the wrapper off.
  decryptRowFields: jest.fn(async (_em: unknown, _key: string, rows: Array<Record<string, unknown>>) => {
    for (const row of rows) {
      const m = /^enc\((.*)\)$/.exec(String(row.primary_email ?? ''))
      if (m) row.primary_email = m[1]
    }
    return rows
  }),
}))

import { createFakeDb } from '../../../../lib/__tests__/support/fake-db'
import { addInvoiceContactToPaidLists } from '../list-auto-add'
import handler from '../../subscribers/list-auto-add-invoice-paid'

/**
 * "Paid an invoice" mailing lists never filled: nothing handled the
 * invoice_paid auto-add. A paid invoice now adds its contact to those lists,
 * once per invoice, never someone who unsubscribed.
 */

const ORG = 'org-1'
const TENANT = 'ten-1'
const scope = { organizationId: ORG, tenantId: TENANT }

function world(overrides: Record<string, Array<Record<string, unknown>>> = {}) {
  const knex = createFakeDb(
    {
      email_lists: [
        { id: 'list-paid', organization_id: ORG, tenant_id: TENANT, source_type: 'invoice_paid', member_count: 0, deleted_at: null },
        { id: 'list-booked', organization_id: ORG, tenant_id: TENANT, source_type: 'booking_created', member_count: 0, deleted_at: null },
        { id: 'list-other-org', organization_id: 'org-2', tenant_id: 'ten-2', source_type: 'invoice_paid', member_count: 0, deleted_at: null },
      ],
      email_list_members: [],
      email_unsubscribes: [],
      automation_trigger_dispatches: [],
      invoices: [
        { id: 'inv-1', organization_id: ORG, tenant_id: TENANT, contact_id: 'c-1' },
        { id: 'inv-2', organization_id: ORG, tenant_id: TENANT, contact_id: 'c-1' },
        { id: 'inv-3', organization_id: ORG, tenant_id: TENANT, contact_id: 'c-2' },
      ],
      customer_entities: [
        { id: 'c-1', organization_id: ORG, tenant_id: TENANT, primary_email: 'enc(dana@example.test)', deleted_at: null },
        { id: 'c-2', organization_id: ORG, tenant_id: TENANT, primary_email: 'enc(sam@example.test)', deleted_at: null },
      ],
      ...overrides,
    },
    {
      automation_trigger_dispatches: [['organization_id', 'trigger_type', 'event_key']],
      email_list_members: [['list_id', 'contact_id']],
    },
  )
  const ctx = { resolve: <T,>() => ({ getKnex: () => knex }) as T }
  return { knex, ctx }
}

describe('"Paid an invoice" mailing lists', () => {
  it('adds the invoice’s contact to that list once, and only that org’s invoice_paid lists', async () => {
    const { knex, ctx } = world()
    await handler({ id: 'inv-1', ...scope }, ctx)
    await handler({ id: 'inv-1', ...scope }, ctx)
    expect(knex.db.tables.email_list_members).toEqual([
      expect.objectContaining({ list_id: 'list-paid', contact_id: 'c-1', organization_id: ORG, tenant_id: TENANT }),
    ])
    expect(knex.db.tables.email_lists.find((l: { id: string }) => l.id === 'list-paid')).toMatchObject({ member_count: 1 })
    expect(knex.db.tables.email_lists.find((l: { id: string }) => l.id === 'list-other-org')).toMatchObject({ member_count: 0 })
  })

  it('a replay never re-adds someone the owner took off the list', async () => {
    const { knex } = world()
    await addInvoiceContactToPaidLists(knex as never, scope, { invoiceId: 'inv-1' })
    knex.db.tables.email_list_members = []
    await expect(addInvoiceContactToPaidLists(knex as never, scope, { invoiceId: 'inv-1' })).resolves.toEqual({ skipped: 'already_done' })
    expect(knex.db.tables.email_list_members).toHaveLength(0)
  })

  it('never adds someone who unsubscribed, by contact or by address', async () => {
    const byAddress = world({ email_unsubscribes: [{ id: 'u-1', organization_id: ORG, email: 'sam@example.test', contact_id: null }] })
    await expect(addInvoiceContactToPaidLists(byAddress.knex as never, scope, { invoiceId: 'inv-3' })).resolves.toEqual({ skipped: 'unsubscribed' })
    const byContact = world({ email_unsubscribes: [{ id: 'u-2', organization_id: ORG, email: 'old@example.test', contact_id: 'c-1' }] })
    await expect(addInvoiceContactToPaidLists(byContact.knex as never, scope, { invoiceId: 'inv-1' })).resolves.toEqual({ skipped: 'unsubscribed' })
    const otherOrg = world({ email_unsubscribes: [{ id: 'u-3', organization_id: 'org-2', email: 'dana@example.test', contact_id: null }] })
    await expect(addInvoiceContactToPaidLists(otherOrg.knex as never, scope, { invoiceId: 'inv-1' })).resolves.toEqual({ added: ['list-paid'] })
    expect(byAddress.knex.db.tables.email_list_members).toHaveLength(0)
    expect(byContact.knex.db.tables.email_list_members).toHaveLength(0)
  })

  it('does nothing for an invoice in another organization or without a contact', async () => {
    const { knex } = world({ invoices: [{ id: 'inv-9', organization_id: ORG, tenant_id: TENANT, contact_id: null }] })
    await expect(addInvoiceContactToPaidLists(knex as never, scope, { invoiceId: 'inv-9' })).resolves.toEqual({ skipped: 'no_contact' })
    await expect(addInvoiceContactToPaidLists(knex as never, { organizationId: 'org-2', tenantId: 'ten-2' }, { invoiceId: 'inv-9' })).resolves.toEqual({ skipped: 'no_invoice' })
    expect(knex.db.tables.email_list_members).toHaveLength(0)
  })
})
