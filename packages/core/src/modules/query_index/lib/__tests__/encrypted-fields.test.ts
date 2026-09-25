import { buildSearchTokenRows } from '../search-tokens'
import { attachAggregateSearchField, buildIndexDocument } from '../document'
import { fieldsEncryptedInDoc, hasEncryptedIndexFields, resolveIndexExclusions, staticEncryptedIndexFields } from '../encrypted-fields'
import { SEARCH_INDEX_SCHEMA_SQL, searchIndexLeakCountSql, searchIndexPurgeSql } from '../../../customers/lib/searchIndexSchema'

/**
 * The query index must never derive searchable data from encrypted-by-design
 * fields: search_tokens held unkeyed SHA-256 of every word of the decrypted
 * contact name / email / deal title (reversible with a word list), and
 * doc.search_text aggregated them. Contacts and deals are searched on the
 * keyed blind index instead.
 */
const ENVELOPE = 'aGVsbG8gd29ybGQh:Y2lwaGVy:dGFnMTIzNDU2Nzg5MDEy:v2:0011aabb'
const config = { enabled: true, minTokenLength: 3, enablePartials: true, hashAlgorithm: 'sha256' as const, storeRawTokens: false, blocklistedFields: [] }

describe('encrypted fields in the query index', () => {
  it('knows the mapped fields, profiles including their parent contact fields', () => {
    expect(staticEncryptedIndexFields('customers:customer_entity').has('display_name')).toBe(true)
    expect(staticEncryptedIndexFields('customers:customer_person_profile').has('primary_email')).toBe(true)
    expect(staticEncryptedIndexFields('customers:customer_person_profile').has('first_name')).toBe(true)
    expect(staticEncryptedIndexFields('customers:customer_deal').has('title')).toBe(true)
    expect(hasEncryptedIndexFields('customers:customer_todo_link')).toBe(false)
  })

  it('does not tokenize encrypted fields, their aggregate, or envelopes', () => {
    const rows = buildSearchTokenRows({
      entityType: 'customers:customer_person_profile',
      recordId: 'r1',
      tenantId: 't1',
      organizationId: 'o1',
      config,
      doc: {
        display_name: 'John Smith',
        primary_email: 'john@acme.io',
        first_name: 'John',
        search_text: 'John Smith john@acme.io',
        seniority: ENVELOPE,
        status: 'active',
        'cf:secret': 'launch codes',
      },
      excludeFields: ['cf:secret'],
    })
    expect(new Set(rows.map((r) => r.field))).toEqual(new Set(['status']))
  })

  it('keeps tokenizing entities without encrypted fields, including search_text', () => {
    const rows = buildSearchTokenRows({
      entityType: 'customers:customer_todo_link',
      recordId: 'r1',
      config,
      doc: { title: 'Call back', search_text: 'Call back' },
    })
    expect(new Set(rows.map((r) => r.field))).toEqual(new Set(['title', 'search_text']))
  })

  it('keeps encrypted fields and envelopes out of search_text', () => {
    const doc = attachAggregateSearchField(
      { display_name: 'John Smith', status: 'active', description: ENVELOPE, source: 'form' },
      staticEncryptedIndexFields('customers:customer_entity'),
    )
    expect(doc.search_text).toBe('active\nform')
    const built = buildIndexDocument({ display_name: 'Jane', primary_email: 'j@x.io' }, [], {}, staticEncryptedIndexFields('customers:customer_entity'))
    expect(built.search_text).toBeUndefined()
  })

  it('treats any envelope in the stored document as encrypted (tenant maps, encrypted custom fields)', async () => {
    expect(fieldsEncryptedInDoc({ a: ENVELOPE, b: 'plain', c: [ENVELOPE, 'x'] })).toEqual(new Set(['a', 'c']))
    const out = await resolveIndexExclusions(null, 'customers:customer_deal', 't1', { 'cf:note': ENVELOPE })
    expect(out.has('title')).toBe(true)
    expect(out.has('cf:note')).toBe(true)
  })
})

describe('Migration20260925120000 SQL', () => {
  const all = [...SEARCH_INDEX_SCHEMA_SQL, ...searchIndexPurgeSql(), ...searchIndexLeakCountSql().map((i) => i.sql)]

  it('has no `?` (knex would bind it) and is idempotent', () => {
    for (const sql of all) expect(sql).not.toContain('?')
    for (const sql of SEARCH_INDEX_SCHEMA_SQL) {
      expect(/^(create table if not exists|create index if not exists|create unique index if not exists|create or replace function|drop trigger if exists|create trigger)/.test(sql.trim())).toBe(true)
    }
  })

  it('indexes (tenant_id, organization_id, token_hash) and entity_id', () => {
    const sql = SEARCH_INDEX_SCHEMA_SQL.join('\n')
    expect(sql).toContain('("tenant_id", "organization_id", "token_hash")')
    expect(sql).toContain('("entity_id", "entity_type", "field", "token_hash")')
  })

  it('purges every encrypted field of every mapped entity from search_tokens', () => {
    const purge = searchIndexPurgeSql().join('\n')
    expect(purge).toContain(`('customers:customer_entity', 'display_name')`)
    expect(purge).toContain(`('customers:customer_person_profile', 'primary_email')`)
    expect(purge).toContain(`('customers:customer_deal', 'title')`)
    expect(purge).toContain(`"doc" - 'search_text'`)
    expect(purge).toContain(`delete from "vector_search"`)
  })
})
