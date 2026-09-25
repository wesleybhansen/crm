import { afterEach, beforeEach, describe, expect, it } from '@jest/globals'
import {
  SEARCH_SOURCES_BY_ENTITY_ID,
  buildSearchTokenRows,
  deleteSearchTokensForEntities,
  replaceSearchTokens,
  resetSearchTokensTableCacheForTests,
  searchBlindIndex,
  type SearchTokenScope,
} from '../searchIndex'
import { deriveSearchKey } from '../searchTokens'
import { SearchIndexTracker, refreshSearchTokensForIds, syncSearchTokensForValues } from '../searchIndexSync'
import { runSearchIndexJob, searchIndexDrift } from '../searchIndexBackfill'
import { resetSearchKeyCacheForTests } from '../searchKey'
import { FakeSearchDb, UNREADABLE, fakeService } from './helpers/fakeSearchDb'

const T1 = '11111111-1111-4111-8111-111111111111'
const T2 = '22222222-2222-4222-8222-222222222222'
const O1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const O2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const O3 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const service = fakeService()
const keyFor = async (tenant: string) => deriveSearchKey((await service.getDek(tenant))!.key)

const contactSource = SEARCH_SOURCES_BY_ENTITY_ID['customers:customer_entity']!

async function indexContact(db: FakeSearchDb, row: { id: string; tenant: string; org: string; kind?: 'person' | 'company'; name?: string; email?: string; phone?: string }) {
  const kind = row.kind ?? 'person'
  db.tables.customer_entities.push({
    id: row.id, tenant_id: row.tenant, organization_id: row.org, kind, deleted_at: null,
    display_name: row.name ?? null, primary_email: row.email ?? null, primary_phone: row.phone ?? null,
  })
  const scope: SearchTokenScope = { tenantId: row.tenant, organizationId: row.org, entityType: kind, entityId: row.id }
  const values = { display_name: row.name ?? null, primary_email: row.email ?? null, primary_phone: row.phone ?? null }
  await replaceSearchTokens(db, scope, Object.keys(values), buildSearchTokenRows(await keyFor(row.tenant), contactSource, scope, values))
}

async function search(db: FakeSearchDb, tenant: string, orgs: string[], query: string, extra: Record<string, unknown> = {}) {
  const res = await searchBlindIndex(db, await keyFor(tenant), { tenantId: tenant, organizationIds: orgs, query, ...extra })
  return res.hits.map((h) => h.entityId)
}

beforeEach(() => { resetSearchKeyCacheForTests(); resetSearchTokensTableCacheForTests() })
afterEach(() => { resetSearchKeyCacheForTests(); resetSearchTokensTableCacheForTests() })

describe('searchBlindIndex', () => {
  let db: FakeSearchDb
  beforeEach(async () => {
    db = new FakeSearchDb()
    await indexContact(db, { id: id(1), tenant: T1, org: O1, name: 'John Smith', email: 'john.smith@acme.io', phone: '+1 (555) 123-4567' })
    await indexContact(db, { id: id(2), tenant: T1, org: O1, name: 'Joanna Smythe', email: 'jo@other.org', phone: '555 000 9999' })
    await indexContact(db, { id: id(3), tenant: T1, org: O1, name: 'Acme Corp', kind: 'company', email: 'info@acme.io' })
    await indexContact(db, { id: id(4), tenant: T1, org: O2, name: 'John Smith', email: 'john@elsewhere.com' })
    await indexContact(db, { id: id(5), tenant: T2, org: O3, name: 'John Smith', email: 'john.smith@acme.io' })
  })

  it('matches every term (AND), by word prefix', async () => {
    expect(await search(db, T1, [O1], 'john smith')).toEqual([id(1)])
    expect(await search(db, T1, [O1], 'jo sm')).toEqual(expect.arrayContaining([id(1), id(2)]))
    expect(await search(db, T1, [O1], 'john smythe')).toEqual([])
    expect(await search(db, T1, [O1], 'zzz')).toEqual([])
  })

  it('matches email: full address, local part, domain', async () => {
    expect(await search(db, T1, [O1], 'john.smith@acme.io')).toEqual([id(1)])
    expect(await search(db, T1, [O1], 'JOHN.SMITH@ACME.IO')).toEqual([id(1)])
    expect(await search(db, T1, [O1], 'john.smith')).toEqual([id(1)])
    expect((await search(db, T1, [O1], '@acme.io')).sort()).toEqual([id(1), id(3)])
    expect((await search(db, T1, [O1], 'acme')).sort()).toEqual([id(1), id(3)])
  })

  it('matches phone by full digits and by last 4 / 7 / 10 digits', async () => {
    expect(await search(db, T1, [O1], '+1 555 123 4567')).toEqual([id(1)])
    expect(await search(db, T1, [O1], '(555) 123-4567')).toEqual([id(1)])
    expect(await search(db, T1, [O1], '123-4567')).toEqual([id(1)])
    expect(await search(db, T1, [O1], '4567')).toEqual([id(1)])
    expect(await search(db, T1, [O1], '9999')).toEqual([id(2)])
  })

  it('never crosses organizations: the org filter is always applied', async () => {
    expect(await search(db, T1, [O1], 'john smith')).toEqual([id(1)])
    expect(await search(db, T1, [O2], 'john smith')).toEqual([id(4)])
    expect((await search(db, T1, [O1, O2], 'john smith')).sort()).toEqual([id(1), id(4)])
    expect(await search(db, T1, [], 'john smith')).toEqual([])
  })

  it('never crosses tenants: the same word hashes differently per tenant', async () => {
    expect(await search(db, T2, [O3], 'john smith')).toEqual([id(5)])
    // Searching tenant 2's org with tenant 1's key and tenant id finds nothing.
    const res = await searchBlindIndex(db, await keyFor(T1), { tenantId: T1, organizationIds: [O3], query: 'john smith' })
    expect(res.hits).toEqual([])
    const t1 = db.tokens.filter((t) => t.entity_id === id(1) && t.field === 'display_name').map((t) => t.token_hash)
    const t2 = db.tokens.filter((t) => t.entity_id === id(5) && t.field === 'display_name').map((t) => t.token_hash)
    expect(t1.some((h) => t2.includes(h))).toBe(false)
  })

  it('ranks by the number of matched fields and paginates', async () => {
    // "acme" hits id(1) in email only and id(3) in name + email.
    const res = await searchBlindIndex(db, await keyFor(T1), { tenantId: T1, organizationIds: [O1], query: 'acme' })
    expect(res.hits.map((h) => h.entityId)).toEqual([id(3), id(1)])
    expect(res.hits[0]!.rank).toBe(2)
    expect(res.total).toBe(2)
    const page2 = await searchBlindIndex(db, await keyFor(T1), { tenantId: T1, organizationIds: [O1], query: 'acme', limit: 1, offset: 1 })
    expect(page2.hits.map((h) => h.entityId)).toEqual([id(1)])
    expect(page2.total).toBe(2)
  })

  it('filters by entity type and by field', async () => {
    expect(await search(db, T1, [O1], 'acme', { entityTypes: ['company'] })).toEqual([id(3)])
    expect(await search(db, T1, [O1], 'acme', { fields: ['display_name'] })).toEqual([id(3)])
  })

  it('drops deleted rows from results', async () => {
    db.tables.customer_entities.find((r) => r.id === id(1))!.deleted_at = new Date()
    expect(await search(db, T1, [O1], 'john smith')).toEqual([])
  })

  it('stores no plaintext: only 64-hex hashes and field names', () => {
    for (const t of db.tokens) {
      expect(t.token_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(t)).not.toMatch(/john|smith|acme|4567/i)
    }
  })
})

describe('write-path maintenance (SearchIndexTracker)', () => {
  function fakeEm(db: FakeSearchDb) {
    const uow = {}
    return {
      uow,
      getUnitOfWork: () => uow,
      getTransactionContext: () => undefined,
      getConnection: () => ({ execute: (sql: string, params: unknown[]) => db.query(sql, params) }),
    }
  }

  it('indexes on create, re-indexes on update, removes on delete', async () => {
    const db = new FakeSearchDb()
    const em = fakeEm(db)
    const tracker = new SearchIndexTracker(service)
    const entity: Record<string, unknown> = {
      id: id(10), tenantId: T1, organizationId: O1, kind: 'person',
      displayName: 'Grace Hopper', primaryEmail: 'grace@navy.mil', primaryPhone: null, deletedAt: null,
    }
    db.tables.customer_entities.push({ id: id(10), tenant_id: T1, organization_id: O1, kind: 'person', deleted_at: null })

    tracker.track(em, 'customers:customer_entity', entity, 'upsert')
    await tracker.flush(em, em.uow)
    expect(await search(db, T1, [O1], 'grace')).toEqual([id(10)])

    entity.displayName = 'Grace Brewster'
    tracker.track(em, 'customers:customer_entity', entity, 'upsert')
    await tracker.flush(em, em.uow)
    expect(await search(db, T1, [O1], 'hopper')).toEqual([])
    expect(await search(db, T1, [O1], 'brewster')).toEqual([id(10)])

    // A person profile's fields are indexed under the parent contact.
    const profile = { id: id(11), tenantId: T1, organizationId: O1, entity: { id: id(10) }, firstName: 'Grace', lastName: 'Brewster', jobTitle: 'Rear Admiral' }
    db.tables.customer_people.push({ id: id(11), entity_id: id(10), tenant_id: T1, organization_id: O1 })
    tracker.track(em, 'customers:customer_person_profile', profile, 'upsert')
    await tracker.flush(em, em.uow)
    expect(await search(db, T1, [O1], 'admiral')).toEqual([id(10)])

    // Soft delete (deletedAt set) removes every token of the contact.
    entity.deletedAt = new Date()
    tracker.track(em, 'customers:customer_entity', entity, 'upsert')
    await tracker.flush(em, em.uow)
    expect(db.tokens.filter((t) => t.entity_id === id(10) && ['display_name', 'primary_email'].includes(t.field))).toEqual([])
  })

  it('leaves tokens of an unloaded or unreadable field alone', async () => {
    const db = new FakeSearchDb()
    const em = fakeEm(db)
    const tracker = new SearchIndexTracker(service)
    db.tables.customer_entities.push({ id: id(20), tenant_id: T1, organization_id: O1, kind: 'person', deleted_at: null })
    tracker.track(em, 'customers:customer_entity', { id: id(20), tenantId: T1, organizationId: O1, kind: 'person', displayName: 'Ada Lovelace', primaryEmail: 'ada@x.io' }, 'upsert')
    await tracker.flush(em, em.uow)
    // Partial load (email undefined) and a failed decrypt (placeholder) keep the old tokens.
    tracker.track(em, 'customers:customer_entity', {
      id: id(20), tenantId: T1, organizationId: O1, kind: 'person',
      displayName: 'This record could not be decrypted. Contact support.',
    }, 'upsert')
    await tracker.flush(em, em.uow)
    expect(await search(db, T1, [O1], 'lovelace')).toEqual([id(20)])
    expect(await search(db, T1, [O1], 'ada@x.io')).toEqual([id(20)])
  })

  it('drops pending work when the flush fails (beforeFlush reset)', async () => {
    const db = new FakeSearchDb()
    const em = fakeEm(db)
    const tracker = new SearchIndexTracker(service)
    tracker.track(em, 'customers:customer_deal', { id: id(30), tenantId: T1, organizationId: O1, title: 'Big renewal' }, 'upsert')
    tracker.reset(em.uow) // next flush starts clean
    await tracker.flush(em, em.uow)
    expect(db.tokens).toEqual([])
  })

  it('skips silently while the table does not exist yet', async () => {
    const db = new FakeSearchDb()
    db.tableExists = false
    const em = fakeEm(db)
    const tracker = new SearchIndexTracker(service)
    tracker.track(em, 'customers:customer_deal', { id: id(31), tenantId: T1, organizationId: O1, title: 'Big renewal' }, 'upsert')
    await expect(tracker.flush(em, em.uow)).resolves.toBeUndefined()
    expect(db.tokens).toEqual([])
  })

  it('merge: the merged-away contact loses its tokens, the survivor keeps its own', async () => {
    const db = new FakeSearchDb()
    await indexContact(db, { id: id(40), tenant: T1, org: O1, name: 'Sam Carter', email: 'sam@a.io' })
    await indexContact(db, { id: id(41), tenant: T1, org: O1, name: 'Samantha Carter', email: 'sam@b.io' })
    await deleteSearchTokensForEntities(db, [id(41)], { entityTypes: ['person', 'company'] })
    expect(await search(db, T1, [O1], 'carter')).toEqual([id(40)])
  })

  it('raw writers: syncSearchTokensForValues replaces just the written field', async () => {
    const db = new FakeSearchDb()
    await indexContact(db, { id: id(50), tenant: T1, org: O1, name: 'Alan Turing' })
    await syncSearchTokensForValues(db, 'customers:customer_entity', { tenantId: T1, organizationId: O1, entityType: 'person', entityId: id(50) }, { primary_phone: '+44 20 7946 0001' }, service)
    expect(await search(db, T1, [O1], '0001')).toEqual([id(50)])
    expect(await search(db, T1, [O1], 'turing')).toEqual([id(50)])
  })

  it('refreshSearchTokensForIds rebuilds from the stored rows', async () => {
    const db = new FakeSearchDb()
    db.tables.customer_deals.push({ id: id(60), tenant_id: T1, organization_id: O1, title: 'Warehouse expansion', deleted_at: null })
    await refreshSearchTokensForIds(db, service, 'customers:customer_deal', [id(60)])
    const res = await searchBlindIndex(db, await keyFor(T1), { tenantId: T1, organizationIds: [O1], query: 'warehouse', entityTypes: ['deal'] })
    expect(res.hits.map((h) => h.entityId)).toEqual([id(60)])
  })
})

describe('backfill and consistency check', () => {
  function seed(db: FakeSearchDb) {
    db.tables.customer_entities.push(
      { id: id(1), tenant_id: T1, organization_id: O1, kind: 'person', deleted_at: null, display_name: 'John Smith', primary_email: 'john@acme.io', primary_phone: '5551234567' },
      { id: id(2), tenant_id: T1, organization_id: O1, kind: 'company', deleted_at: null, display_name: 'Acme', primary_email: null, primary_phone: null },
      { id: id(3), tenant_id: T1, organization_id: O1, kind: 'person', deleted_at: new Date(), display_name: 'Gone Person', primary_email: null, primary_phone: null },
      { id: id(4), tenant_id: T2, organization_id: O3, kind: 'person', deleted_at: null, display_name: UNREADABLE, primary_email: 'x@y.io', primary_phone: null },
    )
    db.tables.customer_people.push({ id: id(11), entity_id: id(1), tenant_id: T1, organization_id: O1, first_name: 'John', last_name: 'Smith', preferred_name: null, job_title: 'CTO' })
    db.tables.customer_companies.push({ id: id(12), entity_id: id(2), tenant_id: T1, organization_id: O1, legal_name: 'Acme Inc', brand_name: null, domain: 'acme.io', website_url: null })
    db.tables.customer_deals.push({ id: id(21), tenant_id: T1, organization_id: O1, title: 'Acme renewal', deleted_at: null })
  }

  it('dry run counts and writes nothing', async () => {
    const db = new FakeSearchDb()
    seed(db)
    const report = await runSearchIndexJob(db, service, { mode: 'backfill', dryRun: true, batchSize: 2 })
    expect(db.tokens).toEqual([])
    expect(report.sources.customer_entities!.rows).toBe(4)
    // id 1, id 2 and id 4 (email only; its name will not decrypt); id 3 is deleted and expects nothing.
    expect(report.sources.customer_entities!.entitiesDrifted).toBe(3)
    expect(report.sources.customer_entities!.unreadableFields).toBe(1)
    expect(searchIndexDrift(report)).toBeGreaterThan(0)
  })

  it('execute builds the index; a second run is a no-op (idempotent)', async () => {
    const db = new FakeSearchDb()
    seed(db)
    const first = await runSearchIndexJob(db, service, { mode: 'backfill', dryRun: false, batchSize: 2 })
    expect(searchIndexDrift(first)).toBe(0)
    const tokenCount = db.tokens.length
    expect(tokenCount).toBeGreaterThan(0)
    expect(await search(db, T1, [O1], 'cto')).toEqual([id(1)])
    expect(await search(db, T1, [O1], 'acme renewal', { entityTypes: ['deal'] })).toEqual([id(21)])
    expect(await search(db, T2, [O3], 'x@y.io')).toEqual([id(4)])

    const statementsBefore = db.statements.length
    const second = await runSearchIndexJob(db, service, { mode: 'backfill', dryRun: false, batchSize: 2 })
    expect(db.tokens.length).toBe(tokenCount)
    for (const c of Object.values(second.sources)) expect(c.entitiesWritten).toBe(0)
    const writes = db.statements.slice(statementsBefore).filter((s) => /^(insert|delete)/.test(s))
    expect(writes).toEqual([])
  })

  it('resumes after an id inside one table', async () => {
    const db = new FakeSearchDb()
    seed(db)
    const report = await runSearchIndexJob(db, service, { mode: 'backfill', dryRun: true, tables: ['customer_entities'], afterId: id(2) })
    expect(report.sources.customer_entities!.rows).toBe(2)
    expect(Object.keys(report.sources)).toEqual(['customer_entities'])
  })

  it('check finds drift and orphans; execute repairs them', async () => {
    const db = new FakeSearchDb()
    seed(db)
    await runSearchIndexJob(db, service, { mode: 'backfill', dryRun: false })
    // Drift: a token vanished, a stale one appeared, and an orphan (deleted deal).
    db.tokens = db.tokens.filter((t) => !(t.entity_id === id(1) && t.field === 'display_name'))
    db.tokens.push({ tenant_id: T1, organization_id: O1, entity_type: 'deal', entity_id: id(99), field: 'title', token_hash: 'f'.repeat(64) })
    const check = await runSearchIndexJob(db, service, { mode: 'check', dryRun: true })
    expect(check.sources.customer_entities!.entitiesDrifted).toBe(1)
    expect(check.orphanTokens).toBe(1)
    const repair = await runSearchIndexJob(db, service, { mode: 'check', dryRun: false })
    expect(repair.orphanTokensRemoved).toBe(1)
    const after = await runSearchIndexJob(db, service, { mode: 'check', dryRun: true })
    expect(searchIndexDrift(after)).toBe(0)
    expect(await search(db, T1, [O1], 'john smith')).toEqual([id(1)])
  })

  it('writes nothing for a tenant with no key', async () => {
    const db = new FakeSearchDb()
    seed(db)
    const noKey = fakeService({ noKeyFor: [T2] })
    resetSearchKeyCacheForTests()
    const report = await runSearchIndexJob(db, noKey, { mode: 'backfill', dryRun: false, tables: ['customer_entities'] })
    expect(report.sources.customer_entities!.noKey).toBe(1)
    expect(db.tokens.some((t) => t.tenant_id === T2)).toBe(false)
  })
})
