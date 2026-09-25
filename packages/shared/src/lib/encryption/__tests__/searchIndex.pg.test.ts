/**
 * The blind search index against a real Postgres: the migration SQL (table,
 * indexes, triggers, purge), the search statement, and the backfill.
 *
 * Runs only when CUSTOMER_SEARCH_TEST_DATABASE_URL points at a disposable
 * database (each run works in its own schema and drops it). Skipped otherwise,
 * so CI without a database stays green; searchIndex.test.ts covers the same
 * behaviour against an in-memory stand-in.
 *
 *   CUSTOMER_SEARCH_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/crmtest yarn jest searchIndex.pg
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals'
import crypto from 'crypto'
import { Pool, type PoolClient } from 'pg'
import {
  SEARCH_INDEX_SCHEMA_SQL,
  searchIndexLeakCountSql,
  searchIndexPurgeSql,
} from '@open-mercato/core/modules/customers/lib/searchIndexSchema'
import { resetSearchTokensTableCacheForTests, searchBlindIndex, searchSqlFromKnex, searchTokensTableExists, type SearchSql } from '../searchIndex'
import { deriveSearchKey } from '../searchTokens'
import { resetSearchKeyCacheForTests } from '../searchKey'
import { runSearchIndexJob, searchIndexDrift, type SearchBackfillDb } from '../searchIndexBackfill'
import { fakeService } from './helpers/fakeSearchDb'

const URL = process.env.CUSTOMER_SEARCH_TEST_DATABASE_URL
const d = URL ? describe : describe.skip

const T1 = '11111111-1111-4111-8111-111111111111'
const T2 = '22222222-2222-4222-8222-222222222222'
const O1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const O2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const service = fakeService()

const toPg = (sql: string) => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`) }

d('customer_search_tokens on Postgres', () => {
  let pool: Pool
  let schema: string
  let db: SearchBackfillDb

  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows

  beforeAll(async () => {
    schema = `cst_${crypto.randomBytes(4).toString('hex')}`
    const bootstrap = new Pool({ connectionString: URL, max: 1 })
    await bootstrap.query(`create schema ${schema}`)
    await bootstrap.end()
    // Every connection works inside the throwaway schema.
    pool = new Pool({ connectionString: URL, max: 2, options: `-c search_path=${schema}` })
    const ddl = [
      `create table customer_entities (id uuid primary key, tenant_id uuid not null, organization_id uuid not null, kind text not null,
         display_name text, primary_email text, primary_phone text, deleted_at timestamptz)`,
      `create table customer_people (id uuid primary key, entity_id uuid not null, tenant_id uuid not null, organization_id uuid not null,
         first_name text, last_name text, preferred_name text, job_title text)`,
      `create table customer_companies (id uuid primary key, entity_id uuid not null, tenant_id uuid not null, organization_id uuid not null,
         legal_name text, brand_name text, domain text, website_url text)`,
      `create table customer_deals (id uuid primary key, tenant_id uuid not null, organization_id uuid not null, title text, deleted_at timestamptz)`,
      `create table search_tokens (id uuid primary key default gen_random_uuid(), entity_type text not null, entity_id text not null,
         organization_id uuid, tenant_id uuid, field text not null, token_hash text not null, token text, created_at timestamptz not null default now())`,
      `create table entity_indexes (id uuid primary key default gen_random_uuid(), entity_type text not null, entity_id text not null,
         organization_id uuid, tenant_id uuid, doc jsonb not null, updated_at timestamptz)`,
      `create table custom_field_defs (id uuid primary key default gen_random_uuid(), entity_id text not null, key text not null,
         config_json json, tenant_id uuid, deleted_at timestamptz)`,
      `create table vector_search (id uuid primary key default gen_random_uuid(), entity_id text not null, record_id text not null,
         tenant_id uuid not null, organization_id uuid, result_title text)`,
    ]
    for (const sql of ddl) await pool.query(sql)
    const run = (client: Pool | PoolClient): SearchSql => ({
      async query<T>(sql: string, params: unknown[]): Promise<T[]> {
        return (await client.query(toPg(sql), params as unknown[])).rows as T[]
      },
    })
    db = {
      ...run(pool),
      async transaction(fn) {
        const client = await pool.connect()
        try {
          await client.query('begin')
          const out = await fn(run(client))
          await client.query('commit')
          return out
        } catch (err) {
          await client.query('rollback')
          throw err
        } finally {
          client.release()
        }
      },
    }
  })

  afterAll(async () => {
    if (!pool) return
    await pool.query(`drop schema if exists ${schema} cascade`)
    await pool.end()
    resetSearchKeyCacheForTests()
    resetSearchTokensTableCacheForTests()
  })

  const exec = async (sqls: string[]) => { for (const sql of sqls) await pool.query(sql) }

  it('purges plaintext-equivalent copies and keeps unrelated data (idempotent migration)', async () => {
    await exec([
      `insert into search_tokens (entity_type, entity_id, organization_id, tenant_id, field, token_hash, token) values
        ('customers:customer_entity', '${id(1)}', '${O1}', '${T1}', 'display_name', 'h1', 'john'),
        ('customers:customer_person_profile', '${id(2)}', '${O1}', '${T1}', 'primary_email', 'h2', null),
        ('customers:customer_deal', '${id(3)}', '${O1}', '${T1}', 'search_text', 'h3', null),
        ('customers:customer_entity', '${id(1)}', '${O1}', '${T1}', 'cf:secret_note', 'h4', null),
        ('customers:customer_entity', '${id(1)}', '${O1}', '${T1}', 'status', 'h5', 'active'),
        ('catalog:product', '${id(4)}', '${O1}', '${T1}', 'title', 'h6', null)`,
      `insert into custom_field_defs (entity_id, key, config_json) values ('customers:customer_entity', 'secret_note', '{"encrypted": true}'), ('customers:customer_entity', 'plain', '{}')`,
      `insert into entity_indexes (entity_type, entity_id, organization_id, tenant_id, doc) values
        ('customers:customer_entity', '${id(1)}', '${O1}', '${T1}', '{"display_name": "John", "search_text": "John\\njohn@x.io", "status": "active"}'),
        ('catalog:product', '${id(4)}', '${O1}', '${T1}', '{"title": "Chair", "search_text": "Chair"}')`,
      `insert into vector_search (entity_id, record_id, tenant_id, organization_id, result_title) values
        ('customers:customer_person_profile', '${id(2)}', '${T1}', '${O1}', 'John Smith'), ('catalog:product', '${id(4)}', '${T1}', '${O1}', 'Chair')`,
    ])
    const counts = async () => {
      const out: number[] = []
      for (const item of searchIndexLeakCountSql()) out.push(Number((await q(item.sql))[0]?.n ?? 0))
      return out
    }
    expect((await counts()).reduce((a, b) => a + b, 0)).toBeGreaterThan(0)

    await exec(SEARCH_INDEX_SCHEMA_SQL)
    await exec(searchIndexPurgeSql())
    await exec(SEARCH_INDEX_SCHEMA_SQL)
    await exec(searchIndexPurgeSql())

    expect((await counts()).every((n) => n === 0)).toBe(true)
    const left = await q(`select entity_type, field, token from search_tokens order by field`)
    expect(left).toEqual([
      { entity_type: 'customers:customer_entity', field: 'status', token: null },
      { entity_type: 'catalog:product', field: 'title', token: null },
    ])
    const docs = await q(`select entity_type, doc from entity_indexes order by entity_type`)
    expect(docs[0].doc.search_text).toBe('Chair')
    expect(docs[1].doc.search_text).toBeUndefined()
    expect(docs[1].doc.status).toBe('active')
    expect((await q(`select entity_id from vector_search`)).map((r: any) => r.entity_id)).toEqual(['catalog:product'])
  })

  it('backfills, searches with AND + org scoping, and a second run writes nothing', async () => {
    await exec([
      `insert into customer_entities values
        ('${id(10)}', '${T1}', '${O1}', 'person', 'John Smith', 'john.smith@acme.io', '+1 555 123 4567', null),
        ('${id(11)}', '${T1}', '${O1}', 'person', 'Joanna Smythe', 'jo@other.org', null, null),
        ('${id(12)}', '${T1}', '${O2}', 'person', 'John Smith', 'john@elsewhere.com', null, null),
        ('${id(13)}', '${T2}', '${O1}', 'company', 'Acme', 'info@acme.io', null, null)`,
      `insert into customer_people values ('${id(20)}', '${id(10)}', '${T1}', '${O1}', 'John', 'Smith', null, 'Chief Technology Officer')`,
      `insert into customer_companies values ('${id(21)}', '${id(13)}', '${T2}', '${O1}', 'Acme Incorporated', null, 'acme.io', 'https://www.acme.io')`,
      `insert into customer_deals values ('${id(30)}', '${T1}', '${O1}', 'Acme renewal 2026', null)`,
    ])
    const first = await runSearchIndexJob(db, service, { mode: 'backfill', dryRun: false, batchSize: 2 })
    expect(searchIndexDrift(first)).toBe(0)
    const n = Number((await q(`select count(*)::int as n from customer_search_tokens`))[0].n)
    expect(n).toBeGreaterThan(0)

    const key1 = deriveSearchKey((await service.getDek(T1))!.key)
    const key2 = deriveSearchKey((await service.getDek(T2))!.key)
    const find = async (key: Buffer, tenant: string, orgs: string[], query: string, extra: Record<string, unknown> = {}) =>
      (await searchBlindIndex(db, key, { tenantId: tenant, organizationIds: orgs, query, ...extra })).hits.map((h) => h.entityId)

    expect(await find(key1, T1, [O1], 'john smith')).toEqual([id(10)])
    expect(await find(key1, T1, [O1], 'chief officer')).toEqual([id(10)])
    expect(await find(key1, T1, [O1], '4567')).toEqual([id(10)])
    expect(await find(key1, T1, [O1], 'john.smith@acme.io')).toEqual([id(10)])
    expect(await find(key1, T1, [O2], 'john smith')).toEqual([id(12)])
    expect(await find(key1, T1, [O1], 'john smythe')).toEqual([])
    expect(await find(key1, T1, [O1], 'renewal', { entityTypes: ['deal'] })).toEqual([id(30)])
    expect(await find(key2, T2, [O1], 'acme.io')).toEqual([id(13)])
    expect(await find(key1, T1, [O1], 'acme.io')).toEqual([id(10)]) // tenant 1's own contact only

    const second = await runSearchIndexJob(db, service, { mode: 'backfill', dryRun: false, batchSize: 2 })
    for (const c of Object.values(second.sources)) expect(c.entitiesWritten).toBe(0)
    expect(Number((await q(`select count(*)::int as n from customer_search_tokens`))[0].n)).toBe(n)
  })

  it('runs the same statements through knex raw bindings (the app path)', async () => {
    const { default: knexFactory } = await import('knex')
    const knex = knexFactory({ client: 'pg', connection: { connectionString: URL, options: `-c search_path=${schema}` } as any, pool: { min: 0, max: 1 } })
    try {
      const key1 = deriveSearchKey((await service.getDek(T1))!.key)
      const res = await searchBlindIndex(searchSqlFromKnex(knex), key1, { tenantId: T1, organizationIds: [O1], query: 'john smith', fields: ['display_name'] })
      expect(res.hits.map((h) => h.entityId)).toEqual([id(10)])
      expect(await searchTokensTableExists(searchSqlFromKnex(knex))).toBe(true)
    } finally {
      await knex.destroy()
    }
  })

  it('triggers drop tokens on soft delete, hard delete and profile delete', async () => {
    const count = async (entityId: string, extra = '') =>
      Number((await q(`select count(*)::int as n from customer_search_tokens where entity_id = $1 ${extra}`, [entityId]))[0].n)
    expect(await count(id(10), `and field = 'job_title'`)).toBeGreaterThan(0)
    await q(`delete from customer_people where id = $1`, [id(20)])
    expect(await count(id(10), `and field in ('first_name', 'last_name', 'job_title')`)).toBe(0)
    expect(await count(id(10))).toBeGreaterThan(0)
    await q(`update customer_entities set deleted_at = now() where id = $1`, [id(10)])
    expect(await count(id(10))).toBe(0)
    expect(await count(id(30))).toBeGreaterThan(0)
    await q(`delete from customer_deals where id = $1`, [id(30)])
    expect(await count(id(30))).toBe(0)
    await q(`delete from customer_entities where id = $1`, [id(12)])
    expect(await count(id(12))).toBe(0)
  })

  it('check mode finds orphans and repairs them', async () => {
    await q(`insert into customer_search_tokens (tenant_id, organization_id, entity_type, entity_id, field, token_hash)
             values ($1, $2, 'deal', $3, 'title', $4)`, [T1, O1, id(99), 'f'.repeat(64)])
    const check = await runSearchIndexJob(db, service, { mode: 'check', dryRun: true })
    expect(check.orphanTokens).toBe(1)
    await runSearchIndexJob(db, service, { mode: 'check', dryRun: false })
    expect(searchIndexDrift(await runSearchIndexJob(db, service, { mode: 'check', dryRun: true }))).toBe(0)
  })
})
