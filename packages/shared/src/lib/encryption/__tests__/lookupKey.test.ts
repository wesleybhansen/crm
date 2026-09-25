import crypto from 'crypto'
import { hashForLookup } from '../aes'
import { contactLookupHasher, deriveLookupKey, isKeyedLookupHash, keyedLookupHash, resetLookupKeyCacheForTests } from '../lookupKey'

/* 2026-09-25 review, M10: contact lookup hashes were unkeyed sha256
 * (brute-forceable, identical across tenants). */

const dekFor = (tenantId: string) => crypto.createHash('sha256').update(`lookup-test:${tenantId}`).digest('base64')
const source = { getDek: async (tenantId: string | null | undefined) => (tenantId ? { tenantId, key: dekFor(tenantId), fetchedAt: 0 } : null) }

describe('contact lookup hasher', () => {
  const saved = process.env.LOOKUP_HASH_LEGACY_READ
  afterEach(() => {
    resetLookupKeyCacheForTests()
    if (saved === undefined) delete process.env.LOOKUP_HASH_LEGACY_READ
    else process.env.LOOKUP_HASH_LEGACY_READ = saved
  })

  it('writes an HMAC under a key derived from the tenant key, prefixed k1:', async () => {
    const a = await contactLookupHasher('tenant-a', source)
    const b = await contactLookupHasher('tenant-b', source)
    const ha = a.write('15550100100')!
    expect(ha).toBe(keyedLookupHash(deriveLookupKey(dekFor('tenant-a')), '15550100100'))
    expect(isKeyedLookupHash(ha)).toBe(true)
    expect(ha).not.toBe(b.write('15550100100'))
    expect(ha).not.toContain(hashForLookup('15550100100'))
    expect(a.write('')).toBeNull()
  })

  it('reads keyed first, then the legacy hash while the rollout runs; legacy off drops it', async () => {
    const a = await contactLookupHasher('tenant-a', source)
    expect(a.candidates('ada@example.com')).toEqual([a.write('ada@example.com'), hashForLookup('ada@example.com')])
    process.env.LOOKUP_HASH_LEGACY_READ = '0'
    const strict = await contactLookupHasher('tenant-a', source)
    expect(strict.candidates('ada@example.com')).toEqual([strict.write('ada@example.com')])
  })

  it('without a tenant key (encryption on, no DEK) falls back to the legacy hash, never nothing', async () => {
    const saved = process.env.TENANT_DATA_ENCRYPTION
    delete process.env.TENANT_DATA_ENCRYPTION
    try {
      const none = await contactLookupHasher('tenant-x', { getDek: async () => null })
      if (none.keyed) return // encryption switched off in this environment: fixed per-tenant key
      expect(none.write('ada@example.com')).toBe(hashForLookup('ada@example.com'))
      expect(none.candidates('ada@example.com')).toEqual([hashForLookup('ada@example.com')])
    } finally {
      if (saved === undefined) delete process.env.TENANT_DATA_ENCRYPTION
      else process.env.TENANT_DATA_ENCRYPTION = saved
    }
  })
})
