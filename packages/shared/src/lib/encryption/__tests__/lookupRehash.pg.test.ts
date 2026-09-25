/**
 * The contact lookup-hash rehash (M10) against a real Postgres, in a throwaway
 * schema with the production unique index on (organization_id,
 * primary_email_hash). Skipped without TENANT_TEST_DATABASE_URL.
 *
 *   TENANT_TEST_DATABASE_URL=postgres://localhost:5432/crmtest yarn jest lookupRehash.pg
 */
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { encryptWithAesGcm, decryptWithAesGcmStrict, hashForLookup, isEncryptedEnvelope } from '../aes'
import { contactLookupHasher, resetLookupKeyCacheForTests } from '../lookupKey'
import { runLookupRehash, rehashComplete } from '../lookupRehash'
import type { BackfillDb, BackfillQuery } from '../plaintextBackfill'

const URL = process.env.TENANT_TEST_DATABASE_URL || process.env.CUSTOMER_SEARCH_TEST_DATABASE_URL
const d = URL ? describe : describe.skip
const schema = `rehash_${crypto.randomBytes(4).toString('hex')}`

const T1 = crypto.randomUUID()
const O1 = crypto.randomUUID()
const dekFor = (tenantId: string) => crypto.createHash('sha256').update(`rehash-pg:${tenantId}`).digest('base64')
const keys = { getDek: async (tenantId: string | null | undefined) => (tenantId ? { tenantId, key: dekFor(tenantId), fetchedAt: 0 } : null) }
const enc = (v: string) => encryptWithAesGcm(v, dekFor(T1)).value
const decrypt = async (_t: string, _o: string, stored: { primary_email: unknown; primary_phone: unknown }) => {
  const open = (v: unknown) => (typeof v === 'string' && isEncryptedEnvelope(v) ? decryptWithAesGcmStrict(v, dekFor(T1)) : v)
  return { primary_email: open(stored.primary_email), primary_phone: open(stored.primary_phone) }
}

let pool: Pool

function db(): BackfillDb {
  const run = (client: Pool | PoolClient): BackfillQuery => ({
    async query(sql, params) {
      const r = await client.query(sql, params as unknown[] | undefined)
      return { rows: r.rows as any[], rowCount: r.rowCount ?? 0 }
    },
  })
  return {
    ...run(pool),
    async transaction(fn) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const out = await fn(run(client))
        await client.query('commit')
        return out
      } catch (err) {
        await client.query('rollback').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  }
}

d('contact lookup rehash (Postgres)', () => {
  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: URL, max: 1 })
    await bootstrap.query(`create schema ${schema}`)
    await bootstrap.end()
    pool = new Pool({ connectionString: URL, max: 3, options: `-c search_path=${schema}` })
    await pool.query(`create table customer_entities (
      id uuid primary key, tenant_id uuid not null, organization_id uuid not null,
      primary_email text, primary_phone text, primary_email_hash text, primary_phone_hash text, deleted_at timestamptz)`)
    await pool.query(`create unique index customer_entities_org_email_hash_uniq on customer_entities (organization_id, primary_email_hash)
      where primary_email_hash is not null and deleted_at is null`)
  })

  afterAll(async () => {
    await pool?.end()
    const cleanup = new Pool({ connectionString: URL, max: 1 })
    await cleanup.query(`drop schema if exists ${schema} cascade`)
    await cleanup.end()
    resetLookupKeyCacheForTests()
  })

  it('rewrites legacy and missing hashes to the keyed format, keeps duplicates, and is idempotent', async () => {
    const hasher = await contactLookupHasher(T1, keys)
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const rows = [
      // legacy unkeyed hashes on an encrypted row
      [id(1), enc('Ada@Example.com'), enc('+1 555 010 0100'), hashForLookup('ada@example.com'), hashForLookup('15550100100'), null],
      // value with no hash at all
      [id(2), enc('grace@example.com'), null, null, null, null],
      // already keyed
      [id(3), enc('linus@example.com'), null, hasher.write('linus@example.com'), null, null],
      // duplicate made during the rollout: 4 was written keyed, 5 still carries the legacy hash
      [id(4), enc('dup@example.com'), null, hasher.write('dup@example.com'), null, null],
      [id(5), enc('DUP@example.com'), null, hashForLookup('dup@example.com'), null, null],
      // unreadable envelope (another key)
      [id(6), encryptWithAesGcm('x@example.com', dekFor('other')).value, null, hashForLookup('x@example.com'), null, null],
    ]
    for (const r of rows) {
      await pool.query(
        `insert into customer_entities (id, tenant_id, organization_id, primary_email, primary_phone, primary_email_hash, primary_phone_hash, deleted_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [r[0], T1, O1, r[1], r[2], r[3], r[4], r[5]],
      )
    }

    const dry = await runLookupRehash(db(), { keys, decrypt }, { dryRun: true, tenantId: T1 })
    expect(dry.tenants.get(T1)).toMatchObject({ emailRehashed: 2, phoneRehashed: 1, duplicates: 1, unreadable: 1 })
    const untouched = await pool.query(`select primary_email_hash from customer_entities where id = $1`, [id(1)])
    expect(untouched.rows[0].primary_email_hash).toBe(hashForLookup('ada@example.com'))

    const real = await runLookupRehash(db(), { keys, decrypt }, { dryRun: false, tenantId: T1, batchSize: 2 })
    expect(real.tenants.get(T1)).toMatchObject({ emailRehashed: 2, phoneRehashed: 1, duplicates: 1, unreadable: 1, changedUnderLock: 0 })
    expect(real.duplicateIds).toEqual([id(5)])

    const after = (await pool.query(`select id, primary_email_hash, primary_phone_hash from customer_entities order by id`)).rows
    const byId = new Map(after.map((r: any) => [r.id, r]))
    expect(byId.get(id(1)).primary_email_hash).toBe(hasher.write('ada@example.com'))
    expect(byId.get(id(1)).primary_phone_hash).toBe(hasher.write('15550100100'))
    expect(byId.get(id(2)).primary_email_hash).toBe(hasher.write('grace@example.com'))
    expect(byId.get(id(5)).primary_email_hash).toBe(hashForLookup('dup@example.com'))
    expect(byId.get(id(6)).primary_email_hash).toBe(hashForLookup('x@example.com'))

    const again = await runLookupRehash(db(), { keys, decrypt }, { dryRun: true, tenantId: T1 })
    expect(rehashComplete(again)).toBe(true)
  })
})
