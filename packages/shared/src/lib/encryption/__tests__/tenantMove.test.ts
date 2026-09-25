import crypto from 'node:crypto'
import { decryptWithAesGcmStrict, encryptWithAesGcm, keyIdForDek } from '../aes'
import { parseEnvelope } from '../envelopeFormat'
import {
  buildRoleIdMap,
  classifyTables,
  countUndecryptable,
  envelopeState,
  planRoleMapping,
  rekeyColumnValue,
  rekeyJson,
  rekeyString,
  resolveKeys,
  tallyEnvelopeKeyIds,
} from '../tenantMove'

const key = () => crypto.randomBytes(32).toString('base64')
const OLD = key()
const NEW = key()
const OTHER = key()
const keys = resolveKeys({ oldKey: OLD, newKey: NEW })
const enc = (plain: string, k: string) => encryptWithAesGcm(plain, k).value as string
/** A bare v1 envelope (no key id), as written before key ids existed. */
const v1 = (plain: string, k: string) => enc(plain, k).split(':').slice(0, 3).concat('v1').join(':')

describe('tenantMove: envelope re-keying', () => {
  it('classifies envelopes by key id', () => {
    expect(envelopeState('plain text', keys)).toBe('none')
    expect(envelopeState(enc('a', OLD), keys)).toBe('old')
    expect(envelopeState(enc('a', NEW), keys)).toBe('new')
    expect(envelopeState(enc('a', OTHER), keys)).toBe('foreign')
    expect(envelopeState(v1('a', OLD), keys)).toBe('v1')
  })

  it('re-keys an old-key envelope so it opens only with the new key', () => {
    const stored = enc('ada@example.com', OLD)
    const r = rekeyString(stored, keys)
    expect(r.changed).toBe(true)
    expect(r.counts.rekeyed).toBe(1)
    expect(parseEnvelope(r.value)?.keyId).toBe(keyIdForDek(NEW))
    expect(decryptWithAesGcmStrict(r.value, NEW)).toBe('ada@example.com')
    expect(() => decryptWithAesGcmStrict(r.value, OLD)).toThrow()
  })

  it('keeps the empty string encrypted (zero-length ciphertext)', () => {
    const r = rekeyString(enc('', OLD), keys)
    expect(r.changed).toBe(true)
    expect(decryptWithAesGcmStrict(r.value, NEW)).toBe('')
  })

  it('re-keys a bare v1 envelope that opens with the old key, reports one that does not', () => {
    const ok = rekeyString(v1('legacy', OLD), keys)
    expect(ok.counts.rekeyed).toBe(1)
    expect(decryptWithAesGcmStrict(ok.value, NEW)).toBe('legacy')

    const foreignV1 = v1('vault era', OTHER)
    const bad = rekeyString(foreignV1, keys)
    expect(bad.changed).toBe(false)
    expect(bad.value).toBe(foreignV1)
    expect(bad.counts.unreadable).toBe(1)
  })

  it('leaves new-key and foreign envelopes untouched (resume-safe)', () => {
    const already = enc('x', NEW)
    expect(rekeyString(already, keys)).toMatchObject({ value: already, changed: false, counts: { alreadyNew: 1 } })
    const foreign = enc('x', OTHER)
    expect(rekeyString(foreign, keys)).toMatchObject({ value: foreign, changed: false, counts: { foreign: 1 } })
  })

  it('refuses an old-key-stamped envelope that does not authenticate (corruption)', () => {
    const stored = enc('x', OLD)
    const parts = stored.split(':')
    parts[1] = Buffer.from('tampered!').toString('base64')
    expect(() => rekeyString(parts.join(':'), keys)).toThrow(/did not open/)
  })

  it('never returns plaintext in counts or leaves it in the value', () => {
    const r = rekeyString(enc('secret-value', OLD), keys)
    expect(JSON.stringify(r)).not.toContain('secret-value')
  })

  it('walks jsonb recursively: nested envelopes, arrays, untouched keys and scalars', () => {
    const doc = {
      display_name: enc('Grace', OLD),
      cf: { note: enc('private', OLD), tags: [enc('a', OLD), 'plain', 3, null] },
      [enc('k', OLD)]: true,
      count: 7,
    }
    const r = rekeyJson(doc, keys)
    expect(r.changed).toBe(true)
    expect(r.counts.rekeyed).toBe(3)
    const out = r.value as any
    expect(decryptWithAesGcmStrict(out.display_name, NEW)).toBe('Grace')
    expect(decryptWithAesGcmStrict(out.cf.note, NEW)).toBe('private')
    expect(decryptWithAesGcmStrict(out.cf.tags[0], NEW)).toBe('a')
    expect(out.cf.tags.slice(1)).toEqual(['plain', 3, null])
    expect(out.count).toBe(7)
    // Object keys are not data values: left as they were.
    expect(Object.keys(out)).toEqual(Object.keys(doc))
    const tally = tallyEnvelopeKeyIds(out)
    expect(tally.byKeyId.get(keyIdForDek(OLD)) ?? 0).toBe(0)
    expect(tally.byKeyId.get(keyIdForDek(NEW))).toBe(3)
    expect(countUndecryptable(out, NEW)).toEqual({ checked: 3, failed: 0 })
  })

  it('returns the original object when nothing changed', () => {
    const doc = { a: 'plain', b: [1, 2] }
    const r = rekeyJson(doc, keys)
    expect(r.changed).toBe(false)
    expect(r.value).toBe(doc)
  })

  it('rewrites literals only in plain strings: exact ids and tenant-id substrings', () => {
    const oldTenant = '22560ecc-ac23-466a-b047-0b8f23a259ff'
    const newTenant = '99999999-0000-4000-8000-000000000001'
    const oldRole = '11111111-0000-4000-8000-00000000000a'
    const newRole = '11111111-0000-4000-8000-00000000000b'
    const replacements = {
      exact: new Map([[oldRole, newRole]]),
      substring: new Map([[oldTenant, newTenant]]),
    }
    const r = rekeyJson(
      { roles: [oldRole, 'other'], cacheKey: `crud:${oldTenant}:x`, secret: enc(oldTenant, OLD), mention: `role ${oldRole}` },
      keys,
      replacements,
    )
    const out = r.value as any
    expect(out.roles).toEqual([newRole, 'other'])
    expect(out.cacheKey).toBe(`crud:${newTenant}:x`)
    // exact match only: an id inside a longer string is not a role reference
    expect(out.mention).toBe(`role ${oldRole}`)
    // an envelope is re-keyed, never literal-edited; its plaintext keeps the old id
    expect(decryptWithAesGcmStrict(out.secret, NEW)).toBe(oldTenant)
    expect(r.counts.literalsReplaced).toBe(2)
  })

  it('rekeyColumnValue: text vs json columns, nulls, non-strings', () => {
    expect(rekeyColumnValue(null, false, keys).changed).toBe(false)
    expect(rekeyColumnValue(42, false, keys).changed).toBe(false)
    expect(rekeyColumnValue(enc('x', OLD), false, keys).counts.rekeyed).toBe(1)
    expect(rekeyColumnValue([enc('x', OLD)], true, keys).counts.rekeyed).toBe(1)
    // a JSON document stored in a text column: whole-value envelopes only
    const text = JSON.stringify({ v: enc('x', OLD) })
    expect(rekeyColumnValue(text, false, keys).changed).toBe(false)
  })
})

describe('tenantMove: role remap', () => {
  it('maps referenced roles by name; superadmin becomes admin', () => {
    const plan = planRoleMapping(
      [
        { id: 'old-admin', name: 'admin' },
        { id: 'old-super', name: 'superadmin' },
        { id: 'old-member', name: 'member' },
      ],
      ['superadmin', 'admin', 'employee'],
    )
    expect(plan.demotedSuperadmin).toEqual(['old-super'])
    expect(new Set(plan.requiredNames)).toEqual(new Set(['superadmin', 'admin', 'employee', 'member']))
    const map = buildRoleIdMap(plan, new Map([['admin', 'new-admin'], ['member', 'new-member'], ['employee', 'new-emp'], ['superadmin', 'new-super']]))
    expect(Object.fromEntries(map)).toEqual({ 'old-admin': 'new-admin', 'old-super': 'new-admin', 'old-member': 'new-member' })
  })

  it('fails loudly when a needed role was not provisioned', () => {
    const plan = planRoleMapping([{ id: 'r', name: 'member' }], [])
    expect(() => buildRoleIdMap(plan, new Map())).toThrow(/ROLE_NOT_PROVISIONED:member/)
  })
})

describe('tenantMove: table classes', () => {
  it('classifies from the live schema columns', () => {
    const t = classifyTables([
      { table: 'customer_entities', column: 'id', dataType: 'uuid' },
      { table: 'customer_entities', column: 'tenant_id', dataType: 'uuid' },
      { table: 'customer_entities', column: 'organization_id', dataType: 'uuid' },
      { table: 'customer_entities', column: 'display_name', dataType: 'text' },
      { table: 'customer_entities', column: 'custom', dataType: 'jsonb' },
      { table: 'roles', column: 'id', dataType: 'uuid' },
      { table: 'roles', column: 'tenant_id', dataType: 'uuid' },
      { table: 'organizations', column: 'id', dataType: 'uuid' },
      { table: 'organizations', column: 'tenant_id', dataType: 'uuid' },
      { table: 'legacy_forms', column: 'organization_id', dataType: 'uuid' },
      { table: 'legacy_forms', column: 'body', dataType: 'character varying' },
      { table: 'user_roles', column: 'role_id', dataType: 'uuid' },
    ])
    expect(t.get('customer_entities')?.cls).toBe('org')
    expect(t.get('customer_entities')?.scanColumns).toEqual([
      { column: 'display_name', isJson: false },
      { column: 'custom', isJson: true },
    ])
    expect(t.get('roles')?.cls).toBe('tenant')
    expect(t.get('organizations')?.cls).toBe('tenant')
    expect(t.get('legacy_forms')?.cls).toBe('org_only')
    expect(t.get('user_roles')?.cls).toBe('child')
  })
})
