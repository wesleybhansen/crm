/**
 * The tenant split end to end on a copy of the REAL migrated schema, with a
 * generated seven-organization dataset holding encrypted rows in every table
 * class: dry run (rolls back, database byte-identical), execute, verify-only,
 * resume (no-op), a crash mid-run followed by resume, and a sweep of a
 * straggler row.
 *
 * Needs a database that `mercato db migrate` has built (the schema only; it
 * is used as a TEMPLATE and never written). Each test clones it into a
 * throwaway database and drops it afterwards. Skipped when unset.
 *
 *   createdb crm_split_schema && DATABASE_URL=postgres:///crm_split_schema mercato db migrate
 *   TENANT_SPLIT_TEMPLATE_DATABASE_URL=postgres://localhost:5432/crm_split_schema yarn jest tenantSplit.pg
 */
import crypto from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { encryptWithAesGcm, decryptWithAesGcmStrict, hashForLookup, keyIdForDek } from '../aes'
import { parseEnvelope } from '../envelopeFormat'
import { createKmsService } from '../kms'
import { TenantDataEncryptionService } from '../tenantDataEncryptionService'
import { resetSearchKeyCacheForTests } from '../searchKey'
import { runSearchIndexJob, searchIndexDrift, type SearchBackfillDb } from '../searchIndexBackfill'
import type { SearchSql } from '../searchIndex'
import { DEFAULT_ENCRYPTION_MAPS } from '@open-mercato/core/modules/entities/lib/encryptionDefaults'
import { TENANT_SPLIT_SCHEMA_SQL } from '@open-mercato/core/modules/directory/lib/tenantSplitSchema'
import { SEARCH_INDEX_SCHEMA_SQL } from '@open-mercato/core/modules/customers/lib/searchIndexSchema'
import { runTenantSplit, splitReportOk, formatSplitReport, compactParams, type SplitDb, type SplitQuery, type SplitReport } from '../tenantSplit'

const TEMPLATE_URL = process.env.TENANT_SPLIT_TEMPLATE_DATABASE_URL
const d = TEMPLATE_URL ? describe : describe.skip
jest.setTimeout(240_000)

const uuid = () => crypto.randomUUID()

describe('compactParams', () => {
  it('drops unreferenced parameters and renumbers the rest', () => {
    expect(compactParams('select $1, $3', ['a', 'b', 'c'])).toEqual({ sql: 'select $1, $2', params: ['a', 'c'] })
    expect(compactParams('select $1, $2', ['a', 'b'])).toEqual({ sql: 'select $1, $2', params: ['a', 'b'] })
    expect(compactParams('select $2, $2', ['a', 'b'])).toEqual({ sql: 'select $1, $1', params: ['b'] })
  })
})

type Clone = { url: string; name: string; pool: Pool }

async function cloneTemplate(): Promise<Clone> {
  const template = new URL(TEMPLATE_URL!)
  const templateDb = template.pathname.replace(/^\//, '')
  const admin = new URL(TEMPLATE_URL!)
  admin.pathname = '/postgres'
  const name = `tsplit_${crypto.randomBytes(4).toString('hex')}`
  const adminPool = new Pool({ connectionString: admin.toString(), max: 1 })
  await adminPool.query(`create database ${name} template ${templateDb}`)
  await adminPool.end()
  const url = new URL(TEMPLATE_URL!)
  url.pathname = `/${name}`
  const pool = new Pool({ connectionString: url.toString(), max: 4 })
  for (const sql of TENANT_SPLIT_SCHEMA_SQL) await pool.query(sql)
  for (const sql of SEARCH_INDEX_SCHEMA_SQL) await pool.query(sql)
  return { url: url.toString(), name, pool }
}

async function dropClone(c: Clone | null) {
  if (!c) return
  await c.pool.end().catch(() => {})
  if (process.env.KEEP_TENANT_SPLIT_DB) {
    console.log(`kept fixture database ${c.name}`)
    return
  }
  const admin = new URL(TEMPLATE_URL!)
  admin.pathname = '/postgres'
  const adminPool = new Pool({ connectionString: admin.toString(), max: 1 })
  await adminPool.query(`drop database if exists ${c.name}`)
  await adminPool.end()
}

function pgQuery(client: Pool | PoolClient): SplitQuery {
  return {
    async query(sql, params) {
      try {
        const r = await client.query(sql, params as unknown[])
        return { rows: r.rows, rowCount: r.rowCount ?? 0 }
      } catch (err) {
        // Test-only context: which statement failed (fixture data, no secrets).
        ;(err as Error).message += `\n  in: ${sql.replace(/\s+/g, ' ').slice(0, 400)}`
        throw err
      }
    },
  }
}
function pgDb(pool: Pool): SplitDb {
  return {
    ...pgQuery(pool),
    async transaction(fn) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const out = await fn(pgQuery(client))
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
const toPg = (sql: string) => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`) }
function searchDb(pool: Pool): SearchBackfillDb {
  const run = (c: Pool | PoolClient): SearchSql => ({ async query<T>(sql: string, p: unknown[]) { return (await c.query(toPg(sql), p as unknown[])).rows as T[] } })
  return {
    ...run(pool),
    async transaction(fn) {
      const client = await pool.connect()
      try { await client.query('begin'); const out = await fn(run(client)); await client.query('commit'); return out }
      catch (err) { await client.query('rollback').catch(() => {}); throw err }
      finally { client.release() }
    },
  }
}
function service(pool: Pool) {
  return new TenantDataEncryptionService({
    getConnection: () => ({ execute: async (sql: string, params: unknown[] = []) => (await pool.query(toPg(sql), params)).rows }),
  } as any, { kms: createKmsService() })
}

/** Insert a row, filling NOT NULL columns without a default with a type-appropriate value. */
async function insertRow(pool: Pool, table: string, values: Record<string, unknown>): Promise<void> {
  const cols = (await pool.query(
    `select column_name, data_type, is_nullable, column_default, is_identity from information_schema.columns
      where table_schema = current_schema() and table_name = $1`,
    [table],
  )).rows
  if (!cols.length) throw new Error(`fixture table ${table} missing`)
  const row: Record<string, unknown> = { ...values }
  for (const c of cols) {
    if (c.column_name in row) continue
    if (c.is_nullable === 'YES' || c.column_default !== null || c.is_identity === 'YES') continue
    switch (c.data_type) {
      case 'uuid': row[c.column_name] = uuid(); break
      case 'text': case 'character varying': row[c.column_name] = 'x'; break
      case 'boolean': row[c.column_name] = false; break
      case 'integer': case 'bigint': case 'smallint': case 'numeric': case 'real': case 'double precision': row[c.column_name] = 0; break
      case 'jsonb': case 'json': row[c.column_name] = JSON.stringify({}); break
      default: row[c.column_name] = new Date()
    }
  }
  const names = Object.keys(row)
  const types = new Map(cols.map((c: any) => [c.column_name, c.data_type]))
  const params = names.map((n) => {
    const v = row[n]
    const t = types.get(n)
    if ((t === 'jsonb' || t === 'json') && typeof v !== 'string') return JSON.stringify(v)
    return v
  })
  await pool.query(
    `insert into ${table} (${names.map((n) => `"${n}"`).join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
    params,
  )
}

type Fixture = {
  oldTenant: string
  keep: string
  orgs: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F', string>
  childOfB: string
  plain: Map<string, string> // "<table>:<id>:<column>" -> plaintext
  roles: Record<'superadmin' | 'admin' | 'employee' | 'member', string>
  usersByOrg: Map<string, string[]>
  foreignEnvelopeRow: string
}

async function buildFixture(pool: Pool, oldTenant: string, oldKey: string): Promise<Fixture> {
  const enc = (v: string) => encryptWithAesGcm(v, oldKey).value as string
  await insertRow(pool, 'tenants', { id: oldTenant, name: 'Noli', is_active: true, seed_version: 1 })
  const keep = uuid()
  const orgs = { A: uuid(), B: uuid(), C: uuid(), D: uuid(), E: uuid(), F: uuid() }
  const childOfB = uuid()
  await insertRow(pool, 'organizations', { id: keep, tenant_id: oldTenant, name: 'Wes', created_at: new Date('2026-01-01') })
  let i = 0
  for (const [k, id] of Object.entries(orgs)) {
    await insertRow(pool, 'organizations', {
      id, tenant_id: oldTenant, name: `Org ${k}`, created_at: new Date(Date.UTC(2026, 1, ++i)),
      deleted_at: k === 'F' ? new Date() : null, is_active: k !== 'F',
    })
  }
  await insertRow(pool, 'organizations', { id: childOfB, tenant_id: oldTenant, name: 'Org B child', parent_id: orgs.B, depth: 1 })

  // Tenant-level roles and ACLs (one super-admin ACL, one bug-minted super-admin member ACL).
  const roles = { superadmin: uuid(), admin: uuid(), employee: uuid(), member: uuid() }
  for (const [name, id] of Object.entries(roles)) await insertRow(pool, 'roles', { id, name, tenant_id: oldTenant, created_at: new Date() })
  await insertRow(pool, 'role_acls', { role_id: roles.superadmin, tenant_id: oldTenant, features_json: JSON.stringify(['*']), is_super_admin: true, created_at: new Date() })
  await insertRow(pool, 'role_acls', { role_id: roles.admin, tenant_id: oldTenant, features_json: JSON.stringify(['customers.*']), is_super_admin: false, organizations_json: JSON.stringify([keep, orgs.A]), created_at: new Date() })
  await insertRow(pool, 'role_acls', { role_id: roles.employee, tenant_id: oldTenant, features_json: JSON.stringify(['customers.view']), is_super_admin: false, created_at: new Date() })
  await insertRow(pool, 'role_acls', { role_id: roles.member, tenant_id: oldTenant, features_json: JSON.stringify(['customers.*']), is_super_admin: true, created_at: new Date() })
  await insertRow(pool, 'role_sidebar_preferences', { role_id: roles.admin, tenant_id: oldTenant, locale: 'en', settings_json: JSON.stringify({ order: ['a'] }), created_at: new Date() })
  const toggle = uuid()
  await insertRow(pool, 'feature_toggles', { id: toggle, identifier: `t_${toggle.slice(0, 6)}`, name: 'T', type: 'boolean', default_value: JSON.stringify(false) })
  await insertRow(pool, 'feature_toggle_overrides', { toggle_id: toggle, tenant_id: oldTenant, value: JSON.stringify(true) })

  // Tenant-wide config: maps (org null) and an encrypted custom field def.
  await insertRow(pool, 'encryption_maps', { entity_id: 'customers:customer_comment', tenant_id: oldTenant, organization_id: null, fields_json: JSON.stringify([{ field: 'body' }]), is_active: true })
  await insertRow(pool, 'custom_field_defs', { entity_id: 'customers:customer_entity', tenant_id: oldTenant, organization_id: null, key: 'secret_note', kind: 'text', config_json: JSON.stringify({ encrypted: true }) })

  // A tenant-wide row referenced by foreign key from org rows (copy + remap rule).
  await pool.query(`create table fixture_templates (id uuid primary key, tenant_id uuid not null, organization_id uuid, body text)`)
  await pool.query(`create table fixture_notes (id uuid primary key, tenant_id uuid not null, organization_id uuid not null,
    template_id uuid references fixture_templates(id), body text)`)
  const sharedTemplate = uuid()
  await insertRow(pool, 'fixture_templates', { id: sharedTemplate, tenant_id: oldTenant, organization_id: null, body: enc('shared template body') })

  const plain = new Map<string, string>()
  const usersByOrg = new Map<string, string[]>()
  const allOrgs = [keep, ...Object.values(orgs), childOfB]
  let foreignEnvelopeRow = ''
  for (const org of allOrgs) {
    const tag = org.slice(0, 8)
    for (const spec of DEFAULT_ENCRYPTION_MAPS) {
      await insertRow(pool, 'encryption_maps', { entity_id: spec.entityId, tenant_id: oldTenant, organization_id: org, fields_json: JSON.stringify(spec.fields), is_active: true })
    }
    const users: string[] = []
    for (let u = 0; u < 2; u++) {
      const id = uuid()
      const email = `user${u}.${tag}@example.com`
      users.push(id)
      plain.set(`users:${id}:email`, email)
      await insertRow(pool, 'users', { id, tenant_id: oldTenant, organization_id: org, email: enc(email), email_hash: hashForLookup(email), name: `U${u}`, is_confirmed: true })
      const role = org === orgs.A && u === 0 ? roles.superadmin : org === orgs.C && u === 1 ? roles.member : org === keep && u === 0 ? roles.superadmin : roles.admin
      await insertRow(pool, 'user_roles', { user_id: id, role_id: role, created_at: new Date() })
    }
    usersByOrg.set(org, users)
    if (org === orgs.A) await insertRow(pool, 'user_acls', { user_id: users[1], tenant_id: oldTenant, features_json: JSON.stringify(['*']), is_super_admin: true, created_at: new Date() })

    const secret = `omk_secret_${tag}`
    const keyId = uuid()
    plain.set(`api_keys:${keyId}:session_secret_encrypted`, secret)
    await insertRow(pool, 'api_keys', {
      id: keyId, name: `key ${tag}`, tenant_id: oldTenant, organization_id: org, key_hash: 'h', key_prefix: `p_${tag}_${crypto.randomBytes(2).toString('hex')}`,
      roles_json: JSON.stringify([roles.admin]), session_secret_encrypted: enc(secret), created_by: users[0],
    })
    await insertRow(pool, 'dashboard_role_widgets', { role_id: roles.admin, tenant_id: oldTenant, organization_id: org, widget_ids_json: JSON.stringify(['w1']) })

    const contacts: string[] = []
    for (let c = 0; c < 3; c++) {
      const id = uuid()
      contacts.push(id)
      const name = `Contact ${c} ${tag}`
      const email = `c${c}.${tag}@example.com`
      plain.set(`customer_entities:${id}:display_name`, name)
      plain.set(`customer_entities:${id}:primary_email`, email)
      await insertRow(pool, 'customer_entities', {
        id, tenant_id: oldTenant, organization_id: org, kind: 'person', display_name: enc(name), primary_email: enc(email),
        primary_email_hash: hashForLookup(email), is_active: true, created_at: new Date(), updated_at: new Date(),
      })
    }
    const personId = uuid()
    plain.set(`customer_people:${personId}:first_name`, `First ${tag}`)
    await insertRow(pool, 'customer_people', { id: personId, tenant_id: oldTenant, organization_id: org, entity_id: contacts[0], first_name: enc(`First ${tag}`), last_name: enc('Hopper'), created_at: new Date(), updated_at: new Date() })
    const dealId = uuid()
    plain.set(`customer_deals:${dealId}:title`, `Deal ${tag}`)
    await insertRow(pool, 'customer_deals', { id: dealId, tenant_id: oldTenant, organization_id: org, title: enc(`Deal ${tag}`), created_at: new Date(), updated_at: new Date() })
    await insertRow(pool, 'customer_deal_people', { deal_id: dealId, person_entity_id: contacts[0], role: 'buyer', created_at: new Date() })

    const idxId = uuid()
    await insertRow(pool, 'entity_indexes', {
      id: idxId, entity_type: 'customers:customer_entity', entity_id: contacts[0], tenant_id: oldTenant, organization_id: org,
      doc: { display_name: enc(`Contact 0 ${tag}`), cf: { secret_note: enc(`note ${tag}`), list: [enc('x'), 'plain'] }, tenant_id: oldTenant },
    })
    plain.set(`entity_indexes:${idxId}:doc.cf.secret_note`, `note ${tag}`)
    await insertRow(pool, 'custom_field_values', { entity_id: 'customers:customer_entity', record_id: contacts[0], tenant_id: oldTenant, organization_id: org, field_key: 'secret_note', value_text: enc(`cf ${tag}`) })
    const connId = uuid()
    plain.set(`email_connections:${connId}:access_token`, `tok_${tag}`)
    await insertRow(pool, 'email_connections', {
      id: connId, tenant_id: oldTenant, organization_id: org, user_id: users[0], provider: 'gmail', email_address: `m.${tag}@example.com`,
      access_token: enc(`tok_${tag}`), smtp_pass: enc(`pw_${tag}`), is_active: true,
    })
    await insertRow(pool, 'gtm_mailbox_cursors', { organization_id: org, tenant_id: oldTenant, mailbox_connection_id: connId, provider: 'gmail', cursor_kind: 'history', sealed_cursor: enc(`cursor ${tag}`) })
    await insertRow(pool, 'action_logs', { tenant_id: oldTenant, organization_id: org, command_id: 'customers.people.create', command_payload: { tenantId: oldTenant, cacheKey: `crud:${oldTenant}:people` }, created_at: new Date(), updated_at: new Date() })
    await insertRow(pool, 'search_tokens', { entity_type: 'catalog:product', entity_id: uuid(), tenant_id: oldTenant, organization_id: org, field: 'title', token_hash: 'abc' })
    await insertRow(pool, 'scheduled_jobs', {
      organization_id: org, tenant_id: oldTenant, scope_type: 'organization', name: `refill ${tag}`, schedule_type: 'cron', schedule_value: '0 9 * * *',
      timezone: 'UTC', target_type: 'queue', target_queue: 'gtm-auto-refill', target_payload: { tenantId: oldTenant, organizationId: org }, is_enabled: true,
    })
    const customerRole = uuid()
    await insertRow(pool, 'customer_roles', { id: customerRole, tenant_id: oldTenant, organization_id: org, name: 'Buyer', slug: `buyer-${tag}` })
    await insertRow(pool, 'customer_role_acls', { role_id: customerRole, tenant_id: oldTenant, features_json: JSON.stringify(['portal.view']), created_at: new Date() })
    await insertRow(pool, 'fixture_notes', { id: uuid(), tenant_id: oldTenant, organization_id: org, template_id: sharedTemplate, body: enc(`note body ${tag}`) })
    // A child table with no declared FK (message_objects.message_id -> messages).
    const messageId = uuid()
    await insertRow(pool, 'messages', { id: messageId, tenant_id: oldTenant, organization_id: org, sender_user_id: users[0], subject: 's', body: 'b' })
    await insertRow(pool, 'message_objects', { message_id: messageId, entity_module: 'customers', entity_type: 'person', entity_id: contacts[0], entity_snapshot: { name: enc(`snap ${tag}`) } })
  }

  // A bare v1 envelope (opens with the old key) and a foreign-key envelope (does not).
  const v1 = (encryptWithAesGcm('legacy v1', oldKey).value as string).split(':').slice(0, 3).concat('v1').join(':')
  await pool.query(`update customer_entities set description = $1 where organization_id = $2 and id = (select id from customer_entities where organization_id = $2 limit 1)`, [v1, orgs.D])
  const foreign = encryptWithAesGcm('vault era', crypto.randomBytes(32).toString('base64')).value as string
  foreignEnvelopeRow = (await pool.query(`update customer_entities set source = $1 where id = (select id from customer_entities where organization_id = $2 limit 1) returning id`, [foreign, orgs.E])).rows[0].id

  return { oldTenant, keep, orgs, childOfB, plain, roles, usersByOrg, foreignEnvelopeRow }
}

async function checksum(pool: Pool): Promise<string> {
  const tables = (await pool.query(`select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE' order by 1`)).rows
  const h = crypto.createHash('sha256')
  for (const { table_name } of tables) {
    const r = await pool.query(`select coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as m from "${table_name}" t`)
    h.update(`${table_name}:${r.rows[0].m};`)
  }
  return h.digest('hex')
}

d('tenant split on the real schema (Postgres)', () => {
  const prevKey = process.env.TENANT_DATA_ENCRYPTION_KEY
  let clone: Clone | null = null
  const kms = () => createKmsService()
  const getDek = async (t: string) => (await kms().getTenantDek(t))!.key

  beforeAll(() => {
    process.env.TENANT_DATA_ENCRYPTION_KEY = 'tenant-split-fixture-key'
    resetSearchKeyCacheForTests()
  })
  afterAll(() => {
    if (prevKey === undefined) delete process.env.TENANT_DATA_ENCRYPTION_KEY
    else process.env.TENANT_DATA_ENCRYPTION_KEY = prevKey
  })
  afterEach(async () => { await dropClone(clone); clone = null })

  const rebuildSearchFor = (pool: Pool) => async (tenantId: string, organizationId: string, dryRun: boolean) => {
    const svc = service(pool)
    const sdb = searchDb(pool)
    if (!dryRun) await runSearchIndexJob(sdb, svc, { mode: 'backfill', dryRun: false, tenantId, organizationId })
    return searchIndexDrift(await runSearchIndexJob(sdb, svc, { mode: 'check', dryRun: true, tenantId, organizationId }))
  }

  const split = (pool: Pool, keep: string, mode: 'dry-run' | 'execute' | 'verify', extra: Partial<Parameters<typeof runTenantSplit>[1]> = {}) =>
    runTenantSplit(pgDb(pool), { keepOrganizationId: keep, mode, getDek, rebuildSearch: rebuildSearchFor(pool), ...extra })

  const decryptAll = async (pool: Pool, fx: Fixture, tenantOf: (org: string) => string) => {
    // Every recorded plaintext opens with its row's CURRENT tenant key.
    let checked = 0
    for (const [ref, want] of fx.plain) {
      const [table, id, column] = ref.split(':')
      const path = column.split('.')
      const r = (await pool.query(`select tenant_id::text as tenant_id, organization_id::text as org, "${path[0]}" as v from ${table} where id = $1`, [id])).rows[0]
      let v: any = r.v
      for (const p of path.slice(1)) v = v?.[p]
      expect(r.tenant_id).toBe(tenantOf(r.org))
      expect(decryptWithAesGcmStrict(String(v), await getDek(r.tenant_id))).toBe(want)
      checked++
    }
    return checked
  }

  async function setup() {
    clone = await cloneTemplate()
    const pool = clone.pool
    const oldTenant = uuid()
    const oldKey = await getDek(oldTenant)
    const fx = await buildFixture(pool, oldTenant, oldKey)
    // The blind index exists for every org before the split (as on production).
    const orgIds = [fx.keep, ...Object.values(fx.orgs), fx.childOfB]
    for (const org of orgIds) {
      await runSearchIndexJob(searchDb(pool), service(pool), { mode: 'backfill', dryRun: false, tenantId: oldTenant, organizationId: org })
    }
    return { pool, fx, oldKey }
  }

  const expectOk = (report: SplitReport) => {
    if (!splitReportOk(report)) throw new Error(formatSplitReport(report).join('\n'))
  }

  // Fixture generator for rehearsing the real script (scripts/split-tenants.ts):
  //   TENANT_SPLIT_FIXTURE_ONLY=1 TENANT_SPLIT_TEMPLATE_DATABASE_URL=... yarn jest tenantSplit.pg -t fixture
  // leaves a populated, not-yet-split database and prints its name and the keep org.
  const fixtureOnly = process.env.TENANT_SPLIT_FIXTURE_ONLY ? it : it.skip
  fixtureOnly('fixture: build a seven-org database for a manual script rehearsal', async () => {
    const { fx } = await setup()
    process.env.KEEP_TENANT_SPLIT_DB = '1'
    console.log(`fixture database=${clone!.name} keep_org=${fx.keep} old_tenant=${fx.oldTenant} key=${process.env.TENANT_DATA_ENCRYPTION_KEY}`)
  })

  it('dry run rolls everything back; execute moves, re-keys, remaps; verify, resume and sweep', async () => {
    const { pool, fx, oldKey } = await setup()
    const oldKeyId = keyIdForDek(oldKey)
    const keepSnapshot = async () =>
      (await pool.query(`select md5(string_agg(t::text, '|' order by t.id)) as m from customer_entities t where organization_id = $1`, [fx.keep])).rows[0].m

    // --- dry run: full run per org inside a transaction, then ROLLBACK ------
    const before = await checksum(pool)
    const keepBefore = await keepSnapshot()
    const dry = await split(pool, fx.keep, 'dry-run')
    expectOk(dry)
    expect(dry.orgs.map((o) => o.organizationId).sort()).toEqual(Object.values(fx.orgs).sort())
    expect(dry.orgs.every((o) => o.verification?.ok)).toBe(true)
    expect(await checksum(pool)).toBe(before)
    const orgA = dry.orgs.find((o) => o.organizationId === fx.orgs.A)!
    expect(orgA.rekey.rekeyed).toBeGreaterThan(10)
    expect(orgA.superadminRolesDemoted).toBe(1)
    expect(dry.literalTenantIdColumns.some((c) => c.table === 'action_logs')).toBe(true)

    // --- execute --------------------------------------------------------------
    const run = await split(pool, fx.keep, 'execute')
    expectOk(run)
    const tenantOf = new Map<string, string>()
    tenantOf.set(fx.keep, fx.oldTenant)
    for (const o of run.orgs) for (const id of o.organizationIds) tenantOf.set(id, o.newTenantId)
    expect(tenantOf.get(fx.childOfB)).toBe(tenantOf.get(fx.orgs.B)) // child org moves with its root
    expect(new Set(run.orgs.map((o) => o.newTenantId)).size).toBe(6)

    // Kept org untouched, byte for byte.
    expect(await keepSnapshot()).toBe(keepBefore)
    // Every recorded plaintext opens with its row's current tenant key.
    expect(await decryptAll(pool, fx, (org) => tenantOf.get(org)!)).toBe(fx.plain.size)

    const newTenantIds = run.orgs.map((o) => o.newTenantId)
    const tenantA = tenantOf.get(fx.orgs.A)!
    const q1 = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows
    // No moved row keeps the old key id (users, contacts, index docs, secrets).
    for (const table of ['users', 'customer_entities', 'customer_people', 'customer_deals', 'entity_indexes', 'email_connections', 'gtm_mailbox_cursors', 'api_keys', 'custom_field_values', 'fixture_notes']) {
      const rows = await q1(`select t::text as r from ${table} t where organization_id <> $1`, [fx.keep])
      for (const r of rows) expect(r.r.includes(`:v2:${oldKeyId}`)).toBe(false)
    }
    // Child rows without a declared FK are re-keyed through message_id -> messages.
    const snap = (await q1(`select o.entity_snapshot from message_objects o join messages m on m.id = o.message_id where m.organization_id = $1`, [fx.orgs.A]))[0]
    expect(decryptWithAesGcmStrict(snap.entity_snapshot.name, await getDek(tenantA))).toMatch(/^snap /)
    const keptSnap = (await q1(`select o.entity_snapshot from message_objects o join messages m on m.id = o.message_id where m.organization_id = $1`, [fx.keep]))[0]
    expect(parseEnvelope(keptSnap.entity_snapshot.name)?.keyId).toBe(oldKeyId)
    // Lookup hashes unchanged (unkeyed sha256).
    const someUser = fx.usersByOrg.get(fx.orgs.A)![0]
    expect((await q1(`select email_hash from users where id = $1`, [someUser]))[0].email_hash).toBe(hashForLookup(fx.plain.get(`users:${someUser}:email`)!))

    // Roles: own roles per tenant; superadmin user -> admin; member ACL not super; super ACLs gone.
    const aUserRoles = await q1(`select u.id::text as id, r.name, r.tenant_id::text as t from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id where u.organization_id = $1`, [fx.orgs.A])
    expect(aUserRoles.every((r) => r.t === tenantA && r.name === 'admin')).toBe(true)
    const tenantC = tenantOf.get(fx.orgs.C)!
    const member = await q1(`select a.is_super_admin from roles r join role_acls a on a.role_id = r.id where r.tenant_id = $1 and r.name = 'member'`, [tenantC])
    expect(member).toEqual([{ is_super_admin: false }])
    expect(Number((await q1(`select count(*)::int as n from role_acls where tenant_id = any($1::uuid[]) and is_super_admin`, [newTenantIds]))[0].n)).toBe(0)
    expect(Number((await q1(`select count(*)::int as n from role_acls a join roles r on r.id = a.role_id where a.tenant_id = any($1::uuid[]) and r.name = 'superadmin'`, [newTenantIds]))[0].n)).toBe(0)
    expect((await q1(`select is_super_admin, tenant_id::text as t from user_acls where user_id = $1`, [fx.usersByOrg.get(fx.orgs.A)![1]]))[0]).toEqual({ is_super_admin: false, t: tenantA })
    const adminAcl = (await q1(`select a.organizations_json from role_acls a join roles r on r.id = a.role_id where r.tenant_id = $1 and r.name = 'admin'`, [tenantA]))[0]
    expect(adminAcl.organizations_json).toEqual([fx.orgs.A]) // narrowed: the kept org id is gone
    // Kept tenant still has its superadmin (Wes) untouched.
    expect(Number((await q1(`select count(*)::int as n from role_acls where tenant_id = $1 and is_super_admin`, [fx.oldTenant]))[0].n)).toBe(2)

    // API keys: roles_json remapped, session secret re-keyed.
    const key = (await q1(`select roles_json, tenant_id::text as t from api_keys where organization_id = $1`, [fx.orgs.A]))[0]
    const adminA = (await q1(`select id::text as id from roles where tenant_id = $1 and name = 'admin'`, [tenantA]))[0].id
    expect(key).toEqual({ roles_json: [adminA], t: tenantA })
    // Role id without a foreign key (dashboard_role_widgets.role_id) remapped too.
    expect((await q1(`select role_id::text as r from dashboard_role_widgets where organization_id = $1`, [fx.orgs.A]))[0].r).toBe(adminA)
    // Sidebar preferences and feature toggle overrides copied.
    expect(Number((await q1(`select count(*)::int as n from role_sidebar_preferences where tenant_id = $1 and role_id = $2`, [tenantA, adminA]))[0].n)).toBe(1)
    expect(Number((await q1(`select count(*)::int as n from feature_toggle_overrides where tenant_id = $1`, [tenantA]))[0].n)).toBe(1)
    // Tenant-wide config copied (maps and field defs), FK-referenced tenant-wide row copied + remapped.
    expect(Number((await q1(`select count(*)::int as n from encryption_maps where tenant_id = $1 and organization_id is null`, [tenantA]))[0].n)).toBe(1)
    expect(Number((await q1(`select count(*)::int as n from custom_field_defs where tenant_id = $1 and organization_id is null`, [tenantA]))[0].n)).toBe(1)
    const note = (await q1(`select n.template_id::text as tid, t.tenant_id::text as tt, t.body from fixture_notes n join fixture_templates t on t.id = n.template_id where n.organization_id = $1`, [fx.orgs.A]))[0]
    expect(note.tt).toBe(tenantA)
    expect(decryptWithAesGcmStrict(note.body, await getDek(tenantA))).toBe('shared template body')
    // Literal old tenant id rewritten inside moved rows' jsonb; kept org's rows keep it.
    const log = (await q1(`select command_payload from action_logs where organization_id = $1`, [fx.orgs.A]))[0].command_payload
    expect(log).toEqual({ tenantId: tenantA, cacheKey: `crud:${tenantA}:people` })
    const sched = (await q1(`select tenant_id::text as t, target_payload from scheduled_jobs where organization_id = $1`, [fx.orgs.A]))[0]
    expect(sched).toEqual({ t: tenantA, target_payload: { tenantId: tenantA, organizationId: fx.orgs.A } })
    expect(run.orgs.find((o) => o.organizationId === fx.orgs.A)!.scheduledJobIds).toHaveLength(1)
    // Tenant-level rows hanging off moved rows followed them.
    expect(Number((await q1(`select count(*)::int as n from customer_role_acls a join customer_roles r on r.id = a.role_id where r.organization_id = $1 and a.tenant_id = $2`, [fx.orgs.A, tenantA]))[0].n)).toBe(1)
    // Blind search index rebuilt under each new key; the old tokens are gone.
    for (const o of run.orgs) expect(o.searchDrift).toBe(0)
    expect(Number((await q1(`select count(*)::int as n from customer_search_tokens where organization_id = $1 and tenant_id = $2`, [fx.orgs.A, fx.oldTenant]))[0].n)).toBe(0)
    expect(Number((await q1(`select count(*)::int as n from customer_search_tokens where organization_id = $1 and tenant_id = $2`, [fx.orgs.A, tenantA]))[0].n)).toBeGreaterThan(0)
    // History for signed artefacts; new tenants start unseeded; deleted org -> deleted tenant.
    expect(Number((await q1(`select count(*)::int as n from organization_tenant_moves where from_tenant_id = $1`, [fx.oldTenant]))[0].n)).toBe(7)
    expect((await q1(`select seed_version from tenants where id = $1`, [tenantA]))[0].seed_version).toBe(0)
    expect((await q1(`select deleted_at is not null as d from tenants where id = $1`, [tenantOf.get(fx.orgs.F)]))[0].d).toBe(true)
    // Foreign-key envelope reported, left as is; v1 re-keyed.
    const e = run.orgs.find((o) => o.organizationId === fx.orgs.E)!
    expect(e.rekey.foreign).toBe(1)
    const dRow = (await q1(`select description from customer_entities where organization_id = $1 and description is not null`, [fx.orgs.D]))[0]
    expect(parseEnvelope(dRow.description)?.keyId).toBe(keyIdForDek(await getDek(tenantOf.get(fx.orgs.D)!)))
    // Row counts: nothing lost or duplicated in org-scoped tables.
    expect(run.rowCounts.every((c) => c.before === c.after)).toBe(true)

    // --- verify-only ------------------------------------------------------------
    const verify = await split(pool, fx.keep, 'verify')
    expectOk(verify)
    expect(verify.orgs).toHaveLength(6)

    // --- resume: a second execute is a no-op -------------------------------------
    const afterRun = await checksum(pool)
    const again = await split(pool, fx.keep, 'execute')
    expect(again.orgs).toHaveLength(6)
    expect(again.orgs.every((o) => o.skipped)).toBe(true)
    expect(await checksum(pool)).toBe(afterRun)

    // --- a straggler written under the old tenant during the window: verify catches, sweep fixes
    await pool.query(`update customer_deals set tenant_id = $1 where organization_id = $2`, [fx.oldTenant, fx.orgs.B])
    const caught = await split(pool, fx.keep, 'verify')
    expect(splitReportOk(caught)).toBe(false)
    const swept = await split(pool, fx.keep, 'execute', { sweep: true })
    expectOk(swept)
    expect(swept.orgs.find((o) => o.organizationId === fx.orgs.B)!.tablesMoved).toEqual([{ table: 'customer_deals', moved: 1 }])
    expectOk(await split(pool, fx.keep, 'verify'))
  })

  it('a crash mid-run rolls back that org only; the rerun resumes with the same tenant ids', async () => {
    const { pool, fx } = await setup()
    const failingOrg = fx.orgs.C
    // Crash inside org C's transaction, after its rows were already moved.
    let crashed = false
    const base = pgDb(pool)
    const crashingDb: SplitDb = {
      ...base,
      transaction: (fn) => base.transaction((q) => fn({
        async query(sql, params) {
          if (!crashed && /^update organizations set tenant_id/.test(sql) && JSON.stringify(params).includes(failingOrg)) {
            crashed = true
            throw new Error('SIMULATED_CRASH')
          }
          return q.query(sql, params)
        },
      })),
    }
    await expect(runTenantSplit(crashingDb, { keepOrganizationId: fx.keep, mode: 'execute', getDek, rebuildSearch: rebuildSearchFor(pool) }))
      .rejects.toThrow('SIMULATED_CRASH')
    const committed = (await pool.query(`select distinct organization_id::text as o from tenant_split_ledger where step = 'commit'`)).rows.map((r) => r.o)
    expect(committed).not.toContain(failingOrg)
    expect(committed.length).toBeGreaterThan(0)
    const planned = (await pool.query(`select new_tenant_id::text as t from tenant_split_ledger where organization_id = $1 and step = 'plan'`, [failingOrg])).rows[0].t
    // The failed org is untouched: old tenant, rows not moved.
    expect((await pool.query(`select tenant_id::text as t from organizations where id = $1`, [failingOrg])).rows[0].t).toBe(fx.oldTenant)
    expect(Number((await pool.query(`select count(*)::int as n from customer_entities where organization_id = $1 and tenant_id = $2`, [failingOrg, fx.oldTenant])).rows[0].n)).toBe(3)

    const resumed = await split(pool, fx.keep, 'execute')
    expectOk(resumed)
    const c = resumed.orgs.find((o) => o.organizationId === failingOrg)!
    expect(c.skipped).toBe(false)
    expect(c.newTenantId).toBe(planned) // the tenant id picked before the crash is reused
    expect(resumed.orgs.filter((o) => o.skipped).map((o) => o.organizationId).sort()).toEqual([...committed].sort())
    expect(resumed.rowCounts.every((r) => r.before === r.after)).toBe(true)
    expectOk(await split(pool, fx.keep, 'verify'))
  })
})
