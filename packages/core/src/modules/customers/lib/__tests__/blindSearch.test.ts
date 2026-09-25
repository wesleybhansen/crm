import {
  NO_MATCH_ID,
  applyContactSearchFilters,
  blindSearchIds,
  crudSearchOrganizationIds,
  restrictFiltersToIds,
} from '../blindSearch'
import {
  SEARCH_SOURCES_BY_ENTITY_ID,
  buildSearchTokenRows,
  replaceSearchTokens,
  type SearchTokenScope,
} from '@open-mercato/shared/lib/encryption/searchIndex'
import { resolveSearchKey } from '@open-mercato/shared/lib/encryption/searchKey'
import { FakeSearchDb } from '@open-mercato/shared/lib/encryption/__tests__/helpers/fakeSearchDb'

/**
 * The contact list, deals, todos, inbox, ext API and AI search all narrow
 * their query through these helpers. The org filter is taken from the request
 * scope and never widened: no organization means no match.
 */
const T1 = '11111111-1111-4111-8111-111111111111'
const O1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const O2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const P1 = '00000000-0000-4000-8000-000000000001'
const P2 = '00000000-0000-4000-8000-000000000002'

async function seed() {
  const db = new FakeSearchDb()
  const key = (await resolveSearchKey(T1))!
  const source = SEARCH_SOURCES_BY_ENTITY_ID['customers:customer_entity']!
  for (const [id, org, name, email] of [[P1, O1, 'Ada Lovelace', 'ada@engine.org'], [P2, O2, 'Ada Byron', 'ada@byron.org']] as const) {
    db.tables.customer_entities.push({ id, tenant_id: T1, organization_id: org, kind: 'person', deleted_at: null })
    const scope: SearchTokenScope = { tenantId: T1, organizationId: org, entityType: 'person', entityId: id }
    const values = { display_name: name, primary_email: email }
    await replaceSearchTokens(db, scope, Object.keys(values), buildSearchTokenRows(key, source, scope, values))
  }
  const knex = { raw: async (sql: string, params: unknown[]) => ({ rows: await db.query(sql, params) }) }
  const em = { getKnex: () => knex }
  return { db, em }
}

describe('restrictFiltersToIds', () => {
  it('sets an id filter, intersects with one that is there, and never widens', () => {
    const f: Record<string, any> = {}
    restrictFiltersToIds(f, ['a', 'b'])
    expect(f.id).toEqual({ $in: ['a', 'b'] })
    restrictFiltersToIds(f, ['b', 'c'])
    expect(f.id).toEqual({ $in: ['b'] })
    const g: Record<string, any> = { id: { $eq: 'x' } }
    restrictFiltersToIds(g, ['a'])
    expect(g.id).toEqual({ $eq: NO_MATCH_ID })
    const h: Record<string, any> = {}
    restrictFiltersToIds(h, [])
    expect(h.id).toEqual({ $eq: NO_MATCH_ID })
  })
})

describe('crudSearchOrganizationIds', () => {
  it('uses the request scope, falling back to the caller org, never "all"', () => {
    expect(crudSearchOrganizationIds({ organizationIds: [O1, O2], selectedOrganizationId: O1 })).toEqual([O1, O2])
    expect(crudSearchOrganizationIds({ organizationIds: null, selectedOrganizationId: O2 })).toEqual([O2])
    expect(crudSearchOrganizationIds({ auth: { orgId: O1 } })).toEqual([O1])
    expect(crudSearchOrganizationIds({})).toEqual([])
  })
})

describe('blind contact search', () => {
  it('matches by name, email and prefix within the caller org only', async () => {
    const { em } = await seed()
    expect((await blindSearchIds(em, { tenantId: T1, organizationIds: [O1], entityTypes: ['person'], query: 'ada' })).ids).toEqual([P1])
    expect((await blindSearchIds(em, { tenantId: T1, organizationIds: [O2], entityTypes: ['person'], query: 'ada' })).ids).toEqual([P2])
    expect((await blindSearchIds(em, { tenantId: T1, organizationIds: [], entityTypes: ['person'], query: 'ada' })).ids).toEqual([])
    expect((await blindSearchIds(em, { tenantId: T1, organizationIds: [O1], entityTypes: ['person'], query: 'love' })).ids).toEqual([P1])
    expect((await blindSearchIds(em, { tenantId: T1, organizationIds: [O1], entityTypes: ['person'], query: 'ada lovelace' })).ids).toEqual([P1])
    expect((await blindSearchIds(em, { tenantId: T1, organizationIds: [O1], entityTypes: ['person'], query: 'ada byron' })).ids).toEqual([])
  })

  it('applyContactSearchFilters narrows the CRUD filter for search and email filters', async () => {
    const { em } = await seed()
    const ctx = { container: { resolve: () => em }, auth: { tenantId: T1, orgId: O1 }, organizationIds: [O1] }
    const f1: Record<string, any> = { kind: { $eq: 'person' } }
    expect(await applyContactSearchFilters(f1, { search: 'lovelace' }, ctx, 'person')).toBe(true)
    expect(f1.id).toEqual({ $in: [P1] })

    const f2: Record<string, any> = {}
    await applyContactSearchFilters(f2, { email: 'ada@engine.org' }, ctx, 'person')
    expect(f2.id).toEqual({ $in: [P1] })

    const f3: Record<string, any> = {}
    await applyContactSearchFilters(f3, { emailStartsWith: 'ada@byr' }, ctx, 'person')
    expect(f3.id).toEqual({ $eq: NO_MATCH_ID }) // the byron address is in another org

    const f4: Record<string, any> = {}
    expect(await applyContactSearchFilters(f4, {}, ctx, 'person')).toBe(false)
    expect(f4.id).toBeUndefined()
  })
})
