/** @jest-environment node */
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import { createFakeKnex } from '@/modules/customers/lib/__tests__/support/fake-knex'

/**
 * Duplicate detection groups on the email lookup hash across the whole
 * organization. It used to decrypt the organization's first 2,000 contacts and
 * group in memory, so a duplicate of an older contact was never found.
 */
let knex: ReturnType<typeof createFakeKnex>
const em = { getKnex: () => knex }
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({ resolve: () => em }),
}))
jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromCookies: async () => ({ tenantId: 't1', orgId: 'o1' }),
}))
// Envelopes in the fake table are stand-ins: "env:<plaintext>".
jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  CONTACT_ENTITY_KEY: 'customers:customer_entity',
  decryptRowFields: jest.fn(async (_em: unknown, _k: string, rows: any[], fields: string[]) => {
    for (const row of rows) for (const f of fields) if (typeof row[f] === 'string' && row[f].startsWith('env:')) row[f] = row[f].slice(4)
    return rows
  }),
}))

import { GET } from '../route'

const row = (id: string, email: string, opts: { hashed?: boolean; org?: string; deleted?: boolean } = {}) => ({
  id, tenant_id: 't1', organization_id: opts.org ?? 'o1', display_name: `env:Name ${id}`, primary_email: `env:${email}`,
  primary_email_hash: opts.hashed === false ? null : hashForLookup(email.toLowerCase()),
  created_at: new Date(), deleted_at: opts.deleted ? new Date() : null, source: 'form', lifecycle_stage: 'lead',
})

describe('GET /contacts/duplicates', () => {
  it('finds duplicates of any contact in the org via the lookup hash', async () => {
    const rows = []
    for (let i = 0; i < 2500; i++) rows.push(row(`h${i}`, `person${i}@example.com`))
    rows.push(row('legacy-dup', 'Person7@Example.com', { hashed: false })) // duplicate of an old contact
    rows.push(row('legacy-a', 'solo@x.io', { hashed: false }))
    rows.push(row('legacy-b', 'SOLO@x.io', { hashed: false })) // two hash-less legacy rows
    rows.push(row('other-org', 'person8@example.com', { hashed: false, org: 'o2' }))
    rows.push(row('deleted', 'person9@example.com', { hashed: false, deleted: true }))
    knex = createFakeKnex({ customer_entities: rows })

    const json = await (await GET()).json()
    expect(json.ok).toBe(true)
    const byEmail = Object.fromEntries(json.data.map((g: any) => [g.email, g.contacts.map((c: any) => c.id).sort()]))
    expect(byEmail).toEqual({
      'person7@example.com': ['h7', 'legacy-dup'],
      'solo@x.io': ['legacy-a', 'legacy-b'],
    })
    expect(json.data[0].contacts[0].displayName).toMatch(/^Name /)
    expect(json.truncated).toBe(false)
  })

  it('groups hashed rows that share a hash (no unique index)', async () => {
    knex = createFakeKnex({ customer_entities: [row('a', 'dup@x.io'), row('b', 'dup@x.io'), row('c', 'other@x.io')] })
    const json = await (await GET()).json()
    expect(json.data.map((g: any) => g.contacts.map((c: any) => c.id).sort())).toEqual([['a', 'b']])
  })
})
