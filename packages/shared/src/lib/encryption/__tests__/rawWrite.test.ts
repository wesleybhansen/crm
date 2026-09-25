import { afterAll, beforeAll, describe, expect, it } from '@jest/globals'
import crypto from 'crypto'
import { hashForLookup, isEncryptedEnvelope } from '../aes'
import { encryptRowForRawWrite } from '../rawWrite'
import { TenantDataEncryptionService } from '../tenantDataEncryptionService'
import { createKmsService } from '../kms'
import { decryptRowFields } from '../decryptRows'

const MAPS = [
  { entity_id: 'customers:customer_activity', fields_json: [{ field: 'subject' }, { field: 'body' }] },
  { entity_id: 'customers:customer_entity', fields_json: [{ field: 'display_name' }, { field: 'primary_email' }, { field: 'primary_phone' }] },
]

/** Global maps (tenant/org null), read the way the service reads them. */
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
beforeAll(() => {
  process.env.TENANT_DATA_ENCRYPTION_KEY = 'raw-write-test-key'
  delete process.env.TENANT_DATA_ENCRYPTION
})
afterAll(() => { process.env = saved })

describe('encryptRowForRawWrite', () => {
  const tenant = crypto.randomUUID()
  const org = crypto.randomUUID()

  it('encrypts mapped columns of a raw activity row and leaves the rest alone', async () => {
    const row = { id: 'a1', tenant_id: tenant, organization_id: org, activity_type: 'form_submission', subject: 'Form submitted', body: '{"email":"ada@example.com"}' }
    const out = await encryptRowForRawWrite('customers:customer_activity', row, tenant, org, em)
    expect(isEncryptedEnvelope(out.subject)).toBe(true)
    expect(isEncryptedEnvelope(out.body)).toBe(true)
    expect(out).toMatchObject({ id: 'a1', activity_type: 'form_submission', tenant_id: tenant })
    expect(row.subject).toBe('Form submitted')

    const svc = new TenantDataEncryptionService(em as any, { kms: createKmsService() })
    const back = await svc.decryptEntityPayload('customers:customer_activity', out, tenant, org)
    expect(back).toMatchObject({ subject: 'Form submitted', body: { email: 'ada@example.com' } })
  })

  it('fills the contact lookup hashes the way the ORM subscriber does', async () => {
    const out = await encryptRowForRawWrite('customers:customer_entity', { primary_phone: '+1 (555) 010-0100' }, tenant, org, em)
    expect(isEncryptedEnvelope(out.primary_phone)).toBe(true)
    expect(out.primary_phone_hash).toBe(hashForLookup('15550100100'))
  })

  it('never encrypts an envelope twice', async () => {
    const once = await encryptRowForRawWrite('customers:customer_activity', { subject: 's' }, tenant, org, em)
    const twice = await encryptRowForRawWrite('customers:customer_activity', { ...once }, tenant, org, em)
    expect(twice.subject).toBe(once.subject)
  })

  it('fails closed without a tenant instead of returning plaintext', async () => {
    await expect(encryptRowForRawWrite('customers:customer_activity', { subject: 's' }, null, org, em)).rejects.toThrow(/refusing to write plaintext/)
  })

  it('passes rows through untouched when tenant encryption is switched off', async () => {
    process.env.TENANT_DATA_ENCRYPTION = 'false'
    try {
      const out = await encryptRowForRawWrite('customers:customer_activity', { subject: 's' }, tenant, org, em)
      expect(out.subject).toBe('s')
    } finally {
      delete process.env.TENANT_DATA_ENCRYPTION
    }
  })
})

describe('decryptRowFields on raw-written rows', () => {
  const tenant = crypto.randomUUID()
  const org = crypto.randomUUID()

  it('hands back the column text for JSON bodies and digits-only values, never the ciphertext', async () => {
    const written = await encryptRowForRawWrite('customers:customer_activity', {
      subject: '12345',
      body: '{"email":"ada@example.com"}',
    }, tenant, org, em)
    const rows = [{ ...written }]
    await decryptRowFields(em, 'customers:customer_activity', rows, ['subject', 'body'], tenant, org)
    expect(rows[0]!.subject).toBe('12345')
    expect(JSON.parse(String(rows[0]!.body))).toEqual({ email: 'ada@example.com' })
    expect(isEncryptedEnvelope(rows[0]!.body)).toBe(false)
  })
})
