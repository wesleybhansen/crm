/** @jest-environment node */
import crypto from 'crypto'
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import { contactLookupHasher } from '@open-mercato/shared/lib/encryption/lookupKey'
import { createFakeKnex } from '@/modules/customers/lib/__tests__/support/fake-knex'

/**
 * Bounce and complaint suppression. primary_email is encrypted at rest, so the
 * old `where('primary_email', email)` never matched an encrypted contact and
 * bounced / complaining addresses kept being mailed. The contact must be found
 * by the lookup hash (and legacy hash-less plaintext rows still by value).
 */
let knex: ReturnType<typeof createFakeKnex>
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({ resolve: () => ({ getKnex: () => knex }) }),
}))
jest.mock('@/modules/customers/lib/engagement-score', () => ({ trackEngagement: jest.fn(async () => {}) }))
jest.mock('@/modules/customers/api/webhooks/dispatch', () => ({ dispatchWebhook: jest.fn(async () => {}) }))

import { POST } from '../route'
import { dispatchWebhook } from '@/modules/customers/api/webhooks/dispatch'

const SECRET_BYTES = crypto.randomBytes(24)
process.env.RESEND_WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString('base64')}`

function signed(body: unknown): Request {
  const raw = JSON.stringify(body)
  const id = 'msg_1'
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = crypto.createHmac('sha256', SECRET_BYTES).update(`${id}.${ts}.${raw}`).digest('base64')
  return new Request('http://x/api/email/webhook', {
    method: 'POST',
    body: raw,
    headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` },
  })
}

const ADDRESS = 'Ada@Example.com'
const CIPHERTEXT = 'aXY=:Y3Q=:dGFn:v2:0011aabb'

let KEYED_T4 = ''
beforeAll(async () => {
  KEYED_T4 = (await contactLookupHasher('t4')).write('ada@example.com') as string
})

function seed() {
  knex = createFakeKnex({
    customer_entities: [
      // Written through the encrypting path: ciphertext + lookup hash.
      { id: 'enc', tenant_id: 't1', organization_id: 'o1', primary_email: CIPHERTEXT, primary_email_hash: hashForLookup('ada@example.com'), email_status: null },
      // Legacy plaintext row, no hash yet.
      { id: 'legacy', tenant_id: 't2', organization_id: 'o2', primary_email: 'ada@example.com', primary_email_hash: null, email_status: null },
      // Someone else.
      { id: 'other', tenant_id: 't1', organization_id: 'o1', primary_email: CIPHERTEXT, primary_email_hash: hashForLookup('bob@example.com'), email_status: null },
      // Written after the keyed-hash rollout (M10): per-tenant HMAC.
      { id: 'keyed', tenant_id: 't4', organization_id: 'o4', primary_email: CIPHERTEXT, primary_email_hash: KEYED_T4, email_status: null },
      // Already hard bounced: a soft bounce must not downgrade it.
      { id: 'hard', tenant_id: 't3', organization_id: 'o3', primary_email: CIPHERTEXT, primary_email_hash: hashForLookup('ada@example.com'), email_status: 'hard_bounced' },
    ],
    email_unsubscribes: [],
    email_messages: [],
    // Lookup hashes are keyed per tenant: the webhook asks each tenant.
    tenants: [
      { id: 't1', deleted_at: null },
      { id: 't2', deleted_at: null },
      { id: 't3', deleted_at: null },
      { id: 't4', deleted_at: null },
    ],
  })
}

const status = (id: string) => knex.db.tables.customer_entities!.find((r) => r.id === id)!.email_status

describe('email webhook suppression', () => {
  beforeEach(() => { seed(); jest.clearAllMocks() })

  it('hard bounce suppresses encrypted and legacy contacts found by the lookup hash', async () => {
    const res = await POST(signed({ type: 'email.bounced', data: { to: [ADDRESS], bounce: { type: 'hard' } } }))
    expect(res.status).toBe(200)
    expect(status('enc')).toBe('hard_bounced')
    expect(status('legacy')).toBe('hard_bounced')
    expect(status('other')).toBeNull()
    const unsubs = knex.db.tables.email_unsubscribes!
    expect(status('keyed')).toBe('hard_bounced')
    expect(unsubs.map((u) => u.contact_id).sort()).toEqual(['enc', 'hard', 'keyed', 'legacy'])
    expect(unsubs.every((u) => u.reason === 'hard_bounce')).toBe(true)
    expect((dispatchWebhook as jest.Mock).mock.calls.map((c) => c[1]).sort()).toEqual(['o1', 'o2', 'o3', 'o4'])
  })

  it('soft bounce marks matches but never downgrades a hard bounce', async () => {
    await POST(signed({ type: 'email.bounced', data: { to: [ADDRESS], bounce: { type: 'soft' } } }))
    expect(status('enc')).toBe('soft_bounced')
    expect(status('legacy')).toBe('soft_bounced')
    expect(status('hard')).toBe('hard_bounced')
    expect(status('other')).toBeNull()
    expect(knex.db.tables.email_unsubscribes).toHaveLength(0)
  })

  it('spam complaint unsubscribes every matching contact once', async () => {
    await POST(signed({ type: 'email.complained', data: { to: [ADDRESS] } }))
    await POST(signed({ type: 'email.complained', data: { to: [ADDRESS] } }))
    expect(status('enc')).toBe('complained')
    expect(status('legacy')).toBe('complained')
    expect(status('other')).toBeNull()
    expect(knex.db.tables.email_unsubscribes!.map((u) => u.contact_id).sort()).toEqual(['enc', 'hard', 'keyed', 'legacy'])
  })

  it('an event with no address touches nothing', async () => {
    await POST(signed({ type: 'email.bounced', data: { bounce: { type: 'hard' } } }))
    expect(knex.db.log.filter((l) => l.table === 'customer_entities')).toEqual([])
  })
})
