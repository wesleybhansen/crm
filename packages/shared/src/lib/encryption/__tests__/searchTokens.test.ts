import { afterEach, describe, expect, it } from '@jest/globals'
import crypto from 'crypto'
import {
  MAX_PREFIX_LENGTH,
  compileSearchQuery,
  deriveSearchKey,
  edgePrefixes,
  foldText,
  hashSearchTerms,
  hashSearchToken,
  normalizeDomainForSearch,
  normalizeEmailForSearch,
  splitWords,
  tokensForField,
} from '../searchTokens'
import { resetSearchKeyCacheForTests, resolveSearchKey } from '../searchKey'

const dek = (seed: string) => crypto.createHash('sha256').update(seed).digest('base64')

describe('normalization', () => {
  it('lowercases and folds diacritics', () => {
    expect(foldText('Zoë Ångström-Müller')).toBe('zoe angstrom-muller')
    expect(splitWords("Zoë O'Brien-Smith")).toEqual(['zoe', 'brien', 'smith'])
  })

  it('keeps non-latin letters as words', () => {
    expect(splitWords('Иван Петров')).toEqual(['иван', 'петров'])
  })

  it('makes edge prefixes from 2 chars up to the cap', () => {
    expect(edgePrefixes('john')).toEqual(['jo', 'joh', 'john'])
    expect(edgePrefixes('j')).toEqual([])
    const long = edgePrefixes('christophersonian')
    expect(long[long.length - 1]).toBe('christophers')
    expect(long[long.length - 1]!.length).toBe(MAX_PREFIX_LENGTH)
  })

  it('normalizes emails and domains', () => {
    expect(normalizeEmailForSearch('  Ada.Lovelace@Example.COM ')).toBe('ada.lovelace@example.com')
    expect(normalizeEmailForSearch('not an email')).toBeNull()
    expect(normalizeDomainForSearch('https://www.Acme.com/about?x=1')).toBe('acme.com')
    expect(normalizeDomainForSearch('acme')).toBeNull()
  })
})

describe('tokensForField', () => {
  it('text: word edge prefixes', () => {
    expect(tokensForField('text', 'John Smith')).toEqual(['w:jo', 'w:joh', 'w:john', 'w:sm', 'w:smi', 'w:smit', 'w:smith'])
    expect(tokensForField('text', '')).toEqual([])
    expect(tokensForField('text', null)).toEqual([])
  })

  it('email: full address, domain, local-part words and prefixes', () => {
    const t = tokensForField('email', 'John.Smith@Acme.io')
    expect(t).toContain('e:john.smith@acme.io')
    expect(t).toContain('d:acme.io')
    expect(t).toContain('w:jo')
    expect(t).toContain('w:smith')
    expect(t).toContain('w:acme')
    expect(t).toContain('lp:john.s')
    expect(t).toContain('lp:john.smith')
  })

  it('phone: digits, and last 4 / 7 / 10 digits', () => {
    expect(tokensForField('phone', '+1 (555) 123-4567')).toEqual(['p:15551234567', 'p:4567', 'p:1234567', 'p:5551234567'])
    expect(tokensForField('phone', '12')).toEqual([])
  })

  it('domain: host and its labels', () => {
    expect(tokensForField('domain', 'https://www.acme.com')).toEqual(expect.arrayContaining(['d:acme.com', 'w:acme', 'w:com']))
  })
})

describe('compileSearchQuery', () => {
  const cands = (q: string) => compileSearchQuery(q).map((t) => t.candidates)

  it('splits words into AND-ed terms, capped prefixes, drops 1-char terms', () => {
    expect(cands('John Smith')).toEqual([['w:john'], ['w:smith']])
    expect(cands('j')).toEqual([])
    expect(cands('christophersonian')).toEqual([['w:christophers']])
  })

  it('treats a full email as one exact term, and @domain as a domain term', () => {
    expect(cands('Ada@Example.com')).toEqual([['e:ada@example.com']])
    expect(cands('@example.com')).toEqual([['d:example.com']])
    expect(cands('john@ac')).toEqual([['w:john'], ['w:ac']])
  })

  it('treats a dotted word as a domain or a dotted local part', () => {
    expect(cands('acme.com')).toEqual([['d:acme.com', 'lp:acme.com']])
    expect(cands('john.smith')).toEqual([['d:john.smith', 'lp:john.smith']])
  })

  it('treats a phone-looking query as one phone term', () => {
    expect(cands('+1 (555) 123-4567')).toEqual([['p:15551234567', 'p:5551234567', 'w:15551234567']])
    expect(cands('4567')).toEqual([['p:4567', 'w:4567']])
    expect(cands('Deal 2024')).toEqual([['w:deal'], ['w:2024', 'p:2024']])
  })

  it('dedupes repeated terms', () => {
    expect(cands('john JOHN')).toEqual([['w:john']])
  })
})

describe('keyed hashing', () => {
  it('HMACs with the tenant search key: same word, different tenants, different hashes', () => {
    const a = deriveSearchKey(dek('tenant-a'))
    const b = deriveSearchKey(dek('tenant-b'))
    expect(hashSearchToken(a, 'w:john')).toBe(hashSearchToken(a, 'w:john'))
    expect(hashSearchToken(a, 'w:john')).not.toBe(hashSearchToken(b, 'w:john'))
    expect(hashSearchToken(a, 'w:john')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never uses the data key itself, and is not an unkeyed hash', () => {
    const raw = dek('tenant-a')
    const key = deriveSearchKey(raw)
    expect(key.equals(Buffer.from(raw, 'base64'))).toBe(false)
    expect(hashSearchToken(key, 'w:john')).not.toBe(crypto.createHash('sha256').update('w:john').digest('hex'))
  })

  it('hashes query terms with the same key as stored tokens', () => {
    const key = deriveSearchKey(dek('t'))
    const [term] = hashSearchTerms(key, compileSearchQuery('John'))
    const stored = tokensForField('text', 'John').map((t) => hashSearchToken(key, t))
    expect(stored).toContain(term![0])
  })
})

describe('resolveSearchKey', () => {
  afterEach(() => { resetSearchKeyCacheForTests(); delete process.env.TENANT_DATA_ENCRYPTION })

  it('derives per tenant from the tenant DEK', async () => {
    const source = { getDek: async (t: string | null | undefined) => ({ tenantId: String(t), key: dek(String(t)), fetchedAt: 0 }) }
    const a = await resolveSearchKey('11111111-1111-4111-8111-111111111111', source)
    const b = await resolveSearchKey('22222222-2222-4222-8222-222222222222', source)
    expect(a).not.toBeNull()
    expect(a!.equals(b!)).toBe(false)
    expect(a!.equals(deriveSearchKey(dek('11111111-1111-4111-8111-111111111111')))).toBe(true)
  })

  it('fails closed (null) when encryption is on and no key is available', async () => {
    const source = { getDek: async () => null }
    expect(await resolveSearchKey('11111111-1111-4111-8111-111111111111', source)).toBeNull()
  })

  it('uses a fixed per-tenant key when tenant data encryption is off', async () => {
    process.env.TENANT_DATA_ENCRYPTION = 'false'
    const source = { getDek: async () => null }
    const a = await resolveSearchKey('11111111-1111-4111-8111-111111111111', source)
    const b = await resolveSearchKey('22222222-2222-4222-8222-222222222222', source)
    expect(a).not.toBeNull()
    expect(a!.equals(b!)).toBe(false)
  })
})
