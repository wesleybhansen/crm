/** @jest-environment node */
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import { createFakeKnex } from '@/modules/customers/lib/__tests__/support/fake-knex'

/**
 * POST /ext/contacts dedupes on the email. primary_email is ciphertext for
 * every contact written through the encrypting path, so the old plaintext
 * equality never matched and each retry from the AMS created a duplicate.
 */
let knex: ReturnType<typeof createFakeKnex>
const em = { getKnex: () => knex }
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({ resolve: () => em }),
}))
const createPersonContact = jest.fn(async () => 'new-id')
jest.mock('@/modules/customers/lib/contact-write', () => ({ createPersonContact: (...a: unknown[]) => (createPersonContact as any)(...a) }))
jest.mock('@open-mercato/core/modules/customers/lib/sourceTagging', () => ({ tagContactSource: jest.fn(async () => {}) }))
const PLAINTEXT: Record<string, string> = {
  'env-email': 'ada@example.com',
  'env-name': 'Ada Lovelace',
}
jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  CONTACT_ENTITY_KEY: 'customers:customer_entity',
  decryptRowFields: jest.fn(async (_em: unknown, _k: string, rows: any[], fields: string[]) => {
    for (const row of rows) for (const f of fields) if (row[f] in PLAINTEXT) row[f] = PLAINTEXT[row[f]]
    return rows
  }),
}))

import { POST } from '../route'

const ctx = { auth: { tenantId: 't1', orgId: 'o1', sub: 'u1', keyName: 'ams' } }
const post = (body: unknown) =>
  POST(new Request('http://x/api/ext/contacts', { method: 'POST', body: JSON.stringify(body) }), ctx)

function seed() {
  knex = createFakeKnex({
    customer_entities: [
      { id: 'enc', tenant_id: 't1', organization_id: 'o1', display_name: 'env-name', primary_email: 'env-email', primary_email_hash: hashForLookup('ada@example.com'), deleted_at: null },
      { id: 'other-org', tenant_id: 't2', organization_id: 'o2', display_name: 'x', primary_email: 'env-email', primary_email_hash: hashForLookup('grace@example.com'), deleted_at: null },
      { id: 'legacy', tenant_id: 't1', organization_id: 'o1', display_name: 'Legacy', primary_email: 'legacy@example.com', primary_email_hash: null, deleted_at: null },
      { id: 'gone', tenant_id: 't1', organization_id: 'o1', display_name: 'Gone', primary_email: 'env-email', primary_email_hash: hashForLookup('gone@example.com'), deleted_at: '2026-01-01' },
      { id: 'new-id', tenant_id: 't1', organization_id: 'o1', display_name: 'env-name', primary_email: 'env-email', primary_email_hash: 'h', deleted_at: null },
    ],
  })
}

describe('POST /ext/contacts dedupe', () => {
  beforeEach(() => { seed(); createPersonContact.mockClear() })

  it('finds an encrypted contact by lookup hash (any case) and returns it decrypted', async () => {
    const res = await post({ email: 'ADA@example.com ', displayName: 'Ada' })
    const json = await res.json()
    expect(json.existed).toBe(true)
    expect(json.data.id).toBe('enc')
    expect(json.data.primary_email).toBe('ada@example.com')
    expect(json.data.display_name).toBe('Ada Lovelace')
    expect(createPersonContact).not.toHaveBeenCalled()
  })

  it('still finds a legacy plaintext row that has no hash yet', async () => {
    const json = await (await post({ email: 'legacy@example.com' })).json()
    expect(json.existed).toBe(true)
    expect(json.data.id).toBe('legacy')
  })

  it('does not match another org or a deleted contact, and creates instead', async () => {
    for (const email of ['grace@example.com', 'gone@example.com']) {
      const res = await post({ email })
      expect(res.status).toBe(201)
      const json = await res.json()
      expect(json.existed).toBe(false)
      expect(json.data.primary_email).toBe('ada@example.com') // the created row, decrypted
    }
    expect(createPersonContact).toHaveBeenCalledTimes(2)
  })
})
