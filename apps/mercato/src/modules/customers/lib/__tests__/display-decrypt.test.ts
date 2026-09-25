/** @jest-environment node */
import crypto from 'crypto'
import { encryptRowForRawWrite } from '@open-mercato/shared/lib/encryption/rawWrite'
import { UNDECRYPTABLE_DISPLAY_TEXT } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { decryptRowsForDisplay, isUnreadableValue } from '../display-decrypt'
import { contactMatchesSearch } from '../contact-search'
import { reminderEntityLabel } from '../reminder-entity-label'

const MAPS = [
  { entity_id: 'customers:customer_entity', fields_json: [{ field: 'display_name' }, { field: 'primary_email' }, { field: 'primary_phone' }] },
  { entity_id: 'customers:customer_deal', fields_json: [{ field: 'title' }] },
]
/** Global maps, read the way TenantDataEncryptionService reads them. */
const em = {
  getConnection: () => ({
    async execute(_sql: string, params: unknown[]) {
      const [entityId, tenantId, organizationId] = params
      if (tenantId !== null || organizationId !== null) return []
      return MAPS.filter((m) => m.entity_id === entityId)
    },
  }),
}

const saved = { ...process.env }
beforeAll(() => { process.env.TENANT_DATA_ENCRYPTION_KEY = 'display-decrypt-test-key' })
afterAll(() => { process.env = saved })

const tenant = crypto.randomUUID()
const org = crypto.randomUUID()
const otherTenant = crypto.randomUUID()

describe('decryptRowsForDisplay', () => {
  it('decrypts aliased joined columns and never returns ciphertext', async () => {
    const enc = await encryptRowForRawWrite('customers:customer_entity', { display_name: 'Ada Lovelace', primary_email: 'ada@example.com' }, tenant, org, em)
    const foreign = await encryptRowForRawWrite('customers:customer_entity', { display_name: 'Someone Else' }, otherTenant, org, em)
    const rows: any[] = [
      { id: 1, contact_name: enc.display_name, contact_email: enc.primary_email },
      { id: 2, contact_name: 'Legacy Plain', contact_email: null },
      // Written under another tenant's key: unreadable here, must not leak.
      { id: 3, contact_name: foreign.display_name, contact_email: null },
    ]
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {})
    await decryptRowsForDisplay(em, 'customers:customer_entity', rows, { contact_name: 'display_name', contact_email: 'primary_email' }, tenant, org, 'Contact')
    errors.mockRestore()
    expect(rows[0]).toMatchObject({ contact_name: 'Ada Lovelace', contact_email: 'ada@example.com' })
    expect(rows[1]).toMatchObject({ contact_name: 'Legacy Plain', contact_email: null })
    expect(rows[2].contact_name).toBe('Contact')
  })

  it('treats envelopes of every version and the failure placeholder as unreadable', () => {
    expect(isUnreadableValue('aaaa:bbbb:cccc:v1')).toBe(true)
    expect(isUnreadableValue('aaaa:bbbb:cccc:v2:0011aabb')).toBe(true)
    expect(isUnreadableValue(UNDECRYPTABLE_DISPLAY_TEXT)).toBe(true)
    expect(isUnreadableValue('Ada: notes on v2')).toBe(false)
  })
})

describe('contactMatchesSearch', () => {
  const row = { display_name: 'Ada Lovelace', primary_email: 'ADA@example.com', primary_phone: '+1 (555) 010-0100' }
  it('matches name and email case-insensitively and phone by digits', () => {
    expect(contactMatchesSearch(row, 'love')).toBe(true)
    expect(contactMatchesSearch(row, 'ada@EX')).toBe(true)
    expect(contactMatchesSearch(row, '555-010', { phone: true })).toBe(true)
    expect(contactMatchesSearch(row, '555-010')).toBe(false)
    expect(contactMatchesSearch(row, 'grace')).toBe(false)
  })
})

describe('reminderEntityLabel', () => {
  function fakeKnex(row: Record<string, unknown> | undefined) {
    const calls: any[] = []
    const builder: any = {
      where: (...a: any[]) => { calls.push(a); return builder },
      select: () => builder,
      first: async () => row,
    }
    const knex: any = (table: string) => { calls.push(['table', table]); return builder }
    return { knex, calls }
  }

  it('decrypts a deal title in the reminder org, scoped by organization', async () => {
    const enc = await encryptRowForRawWrite('customers:customer_deal', { title: 'Big renewal' }, tenant, org, em)
    const { knex, calls } = fakeKnex({ title: enc.title, tenant_id: tenant, organization_id: org })
    expect(await reminderEntityLabel(knex, 'deal', 'deal-1', org, em)).toBe('Big renewal')
    expect(calls).toContainEqual(['organization_id', org])
  })

  it('falls back to the generic label instead of ciphertext or a missing row', async () => {
    const foreign = await encryptRowForRawWrite('customers:customer_entity', { display_name: 'X' }, otherTenant, org, em)
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {})
    expect(await reminderEntityLabel(fakeKnex({ display_name: foreign.display_name, tenant_id: tenant, organization_id: org }).knex, 'contact', 'c', org, em)).toBe('Contact')
    errors.mockRestore()
    expect(await reminderEntityLabel(fakeKnex(undefined).knex, 'deal', 'd', org, em)).toBe('Deal')
  })
})
