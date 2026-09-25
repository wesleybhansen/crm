import { describe, expect, it } from '@jest/globals'
import crypto from 'crypto'
import {
  decryptWithAesGcmStrict,
  encryptWithAesGcm,
  isEncryptedEnvelope,
  keyIdForDek,
} from '../aes'
import type { KmsService, TenantDek } from '../kms'
import { TenantDataEncryptionService, UNDECRYPTABLE_DISPLAY_TEXT } from '../tenantDataEncryptionService'
import {
  BackfillRefusedError,
  BackfillVerificationError,
  assertBackfillEnvironment,
  assertSafeToWrite,
  classifyStoredValue,
  formatBackfillReport,
  runPlaintextBackfill,
  type BackfillDb,
  type BackfillEncryption,
  type BackfillQuery,
  type BackfillRow,
} from '../plaintextBackfill'

/* ------------------------------------------------------------------------- *
 * A tiny in-memory Postgres stand-in that understands exactly the statements
 * the backfill issues. Transactions snapshot the tables and restore them on a
 * throw, so a rolled-back batch is observable.
 * ------------------------------------------------------------------------- */

type Table = { columns: Record<string, { type: string; max?: number | null }>; rows: BackfillRow[] }

class FakeDb implements BackfillDb {
  statements: string[] = []
  commits = 0
  rollbacks = 0
  /** Test hook: run before each UPDATE (simulate a concurrent writer). */
  beforeUpdate?: (table: string, id: string) => void

  constructor(
    public tables: Record<string, Table>,
    public maps: Array<{ entity_id: string; tenant_id: string | null; organization_id: string | null; fields_json: unknown }>,
  ) {}

  async query<T extends BackfillRow = BackfillRow>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    this.statements.push(sql)
    const s = sql.replace(/\s+/g, ' ').trim()
    if (s.startsWith('set local')) return { rows: [], rowCount: 0 }
    if (s.includes('from information_schema.columns')) {
      const table = this.tables[String(params[0])]
      if (!table) return { rows: [], rowCount: 0 }
      const rows = Object.entries(table.columns).map(([column_name, c]) => ({
        column_name, data_type: c.type, character_maximum_length: c.max ?? null,
      }))
      return { rows: rows as any, rowCount: rows.length }
    }
    if (s.startsWith('select fields_json from encryption_maps')) {
      const rows = this.maps.filter((m) => m.entity_id === params[0]).map((m) => ({ fields_json: m.fields_json }))
      return { rows: rows as any, rowCount: rows.length }
    }
    let m = /^select (.+) from "(\w+)" where id = any\(\$1::uuid\[\]\)$/.exec(s)
    if (m) {
      const cols = m[1]!.split(', ').map((c) => c.replace(/"/g, ''))
      const ids = params[0] as string[]
      const rows = this.tables[m[2]!]!.rows.filter((r) => ids.includes(String(r.id))).map((r) => pick(r, cols))
      return { rows: rows as any, rowCount: rows.length }
    }
    m = /^select (.+) from "(\w+)"(?: where (.+?))? order by id limit \$(\d+)( for update)?$/.exec(s)
    if (m) {
      const cols = m[1]!.split(', ').map((c) => c.replace(/"/g, ''))
      const conds = (m[3] ?? '').split(' and ').filter(Boolean)
      let rows = [...this.tables[m[2]!]!.rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))
      for (const cond of conds) {
        const c = /^(\w+) (=|>) \$(\d+)$/.exec(cond)!
        const v = params[Number(c[3]) - 1]
        rows = rows.filter((r) => (c[2] === '=' ? r[c[1]!] === v : String(r[c[1]!]) > String(v)))
      }
      rows = rows.slice(0, Number(params[Number(m[4]) - 1]))
      return { rows: rows.map((r) => pick(r, cols)) as any, rowCount: rows.length }
    }
    m = /^update "(\w+)" set (.+) where id = \$(\d+) and (.+)$/.exec(s)
    if (m) {
      const id = String(params[Number(m[3]) - 1])
      this.beforeUpdate?.(m[1]!, id)
      const row = this.tables[m[1]!]!.rows.find((r) => String(r.id) === id)
      const guards = m[4]!.split(' and ').map((g) => /^"(\w+)" = \$(\d+)$/.exec(g)!)
      if (!row || guards.some((g) => row[g[1]!] !== params[Number(g[2]) - 1])) return { rows: [], rowCount: 0 }
      for (const set of m[2]!.split(', ')) {
        const a = /^"(\w+)" = \$(\d+)$/.exec(set)!
        row[a[1]!] = params[Number(a[2]) - 1]
      }
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`FakeDb: unexpected statement: ${s}`)
  }

  async transaction<T>(fn: (tx: BackfillQuery) => Promise<T>): Promise<T> {
    const snapshot = JSON.stringify(this.tables)
    try {
      const out = await fn(this)
      this.commits += 1
      return out
    } catch (err) {
      this.tables = JSON.parse(snapshot)
      this.rollbacks += 1
      throw err
    }
  }
}

function pick(row: BackfillRow, cols: string[]): BackfillRow {
  const out: BackfillRow = {}
  for (const c of cols) out[c] = row[c]
  return out
}

const keyFor = (tenantId: string) => crypto.createHash('sha256').update(`test-root:${tenantId}`).digest('base64')

class FixedKms implements KmsService {
  isHealthy() { return true }
  async getTenantDek(tenantId: string): Promise<TenantDek> { return { tenantId, key: keyFor(tenantId), fetchedAt: 0 } }
  async createTenantDek(tenantId: string) { return this.getTenantDek(tenantId) }
}

/** The real service, reading maps from the fake db the way it reads them in production. */
function realService(db: FakeDb): TenantDataEncryptionService {
  const em = {
    getConnection: () => ({
      async execute(_sql: string, params: unknown[]) {
        const [entityId, tenantId, organizationId] = params
        return db.maps.filter(
          (m) => m.entity_id === entityId && m.tenant_id === (tenantId ?? null) && m.organization_id === (organizationId ?? null),
        )
      },
    }),
  }
  return new TenantDataEncryptionService(em as any, { kms: new FixedKms() })
}

const CONTACT_FIELDS = [{ field: 'display_name' }, { field: 'primary_email' }, { field: 'primary_phone' }, { field: 'description' }]

function contactsTable(rows: BackfillRow[]): Table {
  return {
    columns: {
      id: { type: 'uuid' },
      tenant_id: { type: 'uuid' },
      organization_id: { type: 'uuid' },
      display_name: { type: 'text' },
      primary_email: { type: 'text' },
      primary_phone: { type: 'text' },
      description: { type: 'text' },
    },
    rows,
  }
}

const uuid = () => crypto.randomUUID()
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function scenario(opts: { rows?: (tenant: string, org: string) => BackfillRow[]; mapped?: boolean } = {}) {
  const tenant = uuid()
  const org = uuid()
  const rows = opts.rows
    ? opts.rows(tenant, org)
    : [
      { id: id(1), tenant_id: tenant, organization_id: org, display_name: 'Ada Lovelace', primary_email: 'ada@example.com', primary_phone: '+1 555 0100', description: null },
      { id: id(2), tenant_id: tenant, organization_id: org, display_name: 'Grace Hopper', primary_email: 'grace@example.com', primary_phone: '', description: 'notes: a:b:c' },
      { id: id(3), tenant_id: tenant, organization_id: org, display_name: 'Alan Turing', primary_email: null, primary_phone: null, description: null },
    ]
  const db = new FakeDb(
    { customer_entities: contactsTable(rows) },
    opts.mapped === false
      ? []
      : [{ entity_id: 'customers:customer_entity', tenant_id: tenant, organization_id: null, fields_json: CONTACT_FIELDS }],
  )
  return { tenant, org, db, service: realService(db) }
}

const PLAINTEXT_VALUES = ['Ada Lovelace', 'ada@example.com', '+1 555 0100', 'Grace Hopper', 'grace@example.com', 'notes: a:b:c', 'Alan Turing']

describe('classifyStoredValue', () => {
  const key = crypto.randomBytes(32).toString('base64')
  const other = crypto.randomBytes(32).toString('base64')
  const v2 = encryptWithAesGcm('hello', key).value as string
  const [iv, ct, tag] = v2.split(':')

  it('recognises every envelope version and never calls one plaintext', () => {
    expect(classifyStoredValue(v2, key)).toBe('envelope_ok')
    expect(classifyStoredValue([iv, ct, tag, 'v1'].join(':'), key)).toBe('envelope_ok')
    expect(classifyStoredValue([iv, ct, tag, `v1.${keyIdForDek(key)}`].join(':'), key)).toBe('envelope_ok')
  })

  it('separates wrong-key and unreadable envelopes from plaintext', () => {
    expect(classifyStoredValue(v2, other)).toBe('envelope_wrong_key')
    expect(classifyStoredValue([iv, ct, tag, 'v1'].join(':'), other)).toBe('envelope_unreadable')
  })

  it('treats ordinary text, including text with colons, as plaintext', () => {
    expect(classifyStoredValue('Ada Lovelace', key)).toBe('plaintext')
    expect(classifyStoredValue('a:b:c', key)).toBe('plaintext')
    expect(classifyStoredValue('a:b:c:v3', key)).toBe('plaintext')
    expect(classifyStoredValue('a:b:c:v2:nothex!!', key)).toBe('plaintext')
  })

  it('leaves null, empty and the undecryptable placeholder alone', () => {
    expect(classifyStoredValue(null, key)).toBe('null')
    expect(classifyStoredValue('', key)).toBe('empty')
    expect(classifyStoredValue(UNDECRYPTABLE_DISPLAY_TEXT, key)).toBe('placeholder')
  })
})

describe('assertBackfillEnvironment', () => {
  it('refuses without TENANT_DATA_ENCRYPTION_KEY, even when the fallback variable is set', () => {
    expect(() => assertBackfillEnvironment({} as any)).toThrow(BackfillRefusedError)
    expect(() => assertBackfillEnvironment({ TENANT_DATA_ENCRYPTION_FALLBACK_KEY: 'x' } as any)).toThrow(/TENANT_DATA_ENCRYPTION_KEY/)
    expect(() => assertBackfillEnvironment({ TENANT_DATA_ENCRYPTION_KEY: '  ' } as any)).toThrow(BackfillRefusedError)
  })

  it('refuses when encryption is off or the key source is not the derived scheme', () => {
    expect(() => assertBackfillEnvironment({ TENANT_DATA_ENCRYPTION_KEY: 'k', TENANT_DATA_ENCRYPTION: 'false' } as any)).toThrow(/disabled/)
    expect(() => assertBackfillEnvironment({ TENANT_DATA_ENCRYPTION_KEY: 'k', TENANT_KMS_PROVIDER: 'vault' } as any)).toThrow(/derived/)
    expect(() => assertBackfillEnvironment({ TENANT_DATA_ENCRYPTION_KEY: 'k', TENANT_DATA_KMS: 'vault' } as any)).toThrow(/derived/)
  })

  it('passes with the dedicated key on the derived scheme', () => {
    expect(() => assertBackfillEnvironment({ TENANT_DATA_ENCRYPTION_KEY: 'k' } as any)).not.toThrow()
    expect(() => assertBackfillEnvironment({ TENANT_DATA_ENCRYPTION_KEY: 'k', TENANT_KMS_PROVIDER: 'derived' } as any)).not.toThrow()
  })
})

describe('runPlaintextBackfill', () => {
  it('dry run counts per org/table/field, writes nothing, and prints no values', async () => {
    const { db, service, org, tenant } = scenario()
    const before = JSON.stringify(db.tables)
    const lines: string[] = []
    const report = await runPlaintextBackfill(db, service, { dryRun: true, collectRowIds: true, log: (l) => lines.push(l) })
    lines.push(...formatBackfillReport(report))

    expect(JSON.stringify(db.tables)).toBe(before)
    expect(db.statements.some((s) => /^\s*update/i.test(s))).toBe(false)
    expect(db.commits).toBe(0)

    const counts = (field: string) => report.fields.get(`${org}|customer_entities|${field}`)!
    expect(counts('display_name')).toMatchObject({ plaintext: 3, encrypted: 3 })
    expect(counts('primary_email')).toMatchObject({ plaintext: 2, encrypted: 2 })
    expect(counts('primary_phone')).toMatchObject({ plaintext: 1, encrypted: 1, empty: 1 })
    expect(counts('description')).toMatchObject({ plaintext: 1, encrypted: 1 })
    expect(report.rowsChanged).toBe(3)
    expect(report.activeKeyIds[tenant]).toBe(keyIdForDek(keyFor(tenant)))

    const output = lines.join('\n')
    for (const value of PLAINTEXT_VALUES) expect(output).not.toContain(value)
    expect(output).toContain(id(1))
  })

  it('encrypts plaintext in place with the service, verifies it, and the app can read it back', async () => {
    const { db, service, org, tenant } = scenario()
    const report = await runPlaintextBackfill(db, service, { dryRun: false, batchSize: 2 })
    expect(report.rowsChanged).toBe(3)
    expect(report.batchesCommitted).toBe(2)
    expect(db.rollbacks).toBe(0)

    const rows = db.tables.customer_entities!.rows
    for (const row of rows) {
      for (const field of ['display_name', 'primary_email', 'primary_phone', 'description']) {
        const value = row[field]
        if (value === null || value === '') continue
        expect(isEncryptedEnvelope(value)).toBe(true)
        expect(String(value).split(':')[4]).toBe(keyIdForDek(keyFor(tenant)))
      }
    }
    expect(rows[1]!.primary_phone).toBe('')
    const opened = await service.decryptEntityPayload('customers:customer_entity', { ...rows[0]! }, tenant, org)
    expect(opened).toMatchObject({ display_name: 'Ada Lovelace', primary_email: 'ada@example.com', primary_phone: '+1 555 0100' })
    const opened2 = await service.decryptEntityPayload('customers:customer_entity', { ...rows[1]! }, tenant, org)
    expect(opened2.description).toBe('notes: a:b:c')
  })

  it('is idempotent: a second run changes nothing and never double-encrypts', async () => {
    const { db, service } = scenario()
    await runPlaintextBackfill(db, service, { dryRun: false })
    const afterFirst = JSON.stringify(db.tables)
    const second = await runPlaintextBackfill(db, service, { dryRun: false })
    expect(second.rowsChanged).toBe(0)
    expect(JSON.stringify(db.tables)).toBe(afterFirst)
    for (const counts of second.fields.values()) expect(counts.plaintext).toBe(0)
  })

  it('leaves existing envelopes byte-for-byte, including v1 and wrong-key ones', async () => {
    const otherKey = crypto.randomBytes(32).toString('base64')
    let v1 = ''
    let foreign = ''
    const { db, service, tenant } = scenario({
      rows: (t, o) => {
        const [iv, ct, tag] = (encryptWithAesGcm('Legacy Name', keyFor(t)).value as string).split(':')
        v1 = [iv, ct, tag, 'v1'].join(':')
        foreign = encryptWithAesGcm('Foreign', otherKey).value as string
        return [
          { id: id(1), tenant_id: t, organization_id: o, display_name: v1, primary_email: 'mixed@example.com', primary_phone: null, description: null },
          { id: id(2), tenant_id: t, organization_id: o, display_name: foreign, primary_email: null, primary_phone: null, description: null },
        ]
      },
    })
    const preflight = await runPlaintextBackfill(db, service, { dryRun: true })
    expect(() => assertSafeToWrite(preflight)).toThrow(/different key id/)

    // Even when forced past the preflight, envelopes are never rewritten.
    await runPlaintextBackfill(db, service, { dryRun: false })
    const rows = db.tables.customer_entities!.rows
    expect(rows[0]!.display_name).toBe(v1)
    expect(rows[1]!.display_name).toBe(foreign)
    expect(decryptWithAesGcmStrict(String(rows[0]!.primary_email), keyFor(tenant))).toBe('mixed@example.com')
  })

  it('refuses to write over unreadable bare-v1 envelopes unless told they are understood', async () => {
    const { db, service } = scenario({
      rows: (t, o) => {
        const [iv, ct, tag] = (encryptWithAesGcm('x', crypto.randomBytes(32).toString('base64')).value as string).split(':')
        return [{ id: id(1), tenant_id: t, organization_id: o, display_name: [iv, ct, tag, 'v1'].join(':'), primary_email: null, primary_phone: null, description: null }]
      },
    })
    const preflight = await runPlaintextBackfill(db, service, { dryRun: true })
    expect(() => assertSafeToWrite(preflight)).toThrow(/do not open/)
    expect(() => assertSafeToWrite(preflight, { allowUnreadable: true })).not.toThrow()
  })

  it('does not touch scopes without an active map, and says so', async () => {
    const { db, service, org } = scenario({ mapped: false })
    // With no map anywhere, the entity has no candidate columns at all.
    const empty = await runPlaintextBackfill(db, service, { dryRun: false })
    expect(empty.rowsChanged).toBe(0)

    // A map for a different tenant: this tenant's rows are read but left alone.
    db.maps.push({ entity_id: 'customers:customer_entity', tenant_id: uuid(), organization_id: null, fields_json: CONTACT_FIELDS })
    const before = JSON.stringify(db.tables)
    const report = await runPlaintextBackfill(db, service, { dryRun: false })
    expect(JSON.stringify(db.tables)).toBe(before)
    expect(report.unmapped.get(`${org}|customer_entities|display_name`)).toBe(3)
    expect(formatBackfillReport(report).join('\n')).toContain('NO active encryption map')
  })

  it('rolls the batch back and stops when the service output does not verify', async () => {
    const { db, service } = scenario()
    const broken: BackfillEncryption = {
      isEnabled: () => true,
      getDek: (t) => service.getDek(t),
      resolveEncryptedFields: (...a) => service.resolveEncryptedFields(...a),
      // Simulates a map/key disagreement: a field comes back unencrypted.
      encryptEntityPayload: async (e, p, t, o) => ({ ...(await service.encryptEntityPayload(e, p, t, o)), display_name: 'oops' }),
    }
    const before = JSON.stringify(db.tables)
    await expect(runPlaintextBackfill(db, broken, { dryRun: false })).rejects.toBeInstanceOf(BackfillVerificationError)
    expect(JSON.stringify(db.tables)).toBe(before)
    expect(db.rollbacks).toBe(1)
  })

  it('rolls back when a row changes between planning and writing', async () => {
    const { db, service } = scenario()
    db.beforeUpdate = (table, rowId) => {
      if (rowId === id(2)) db.tables[table]!.rows.find((r) => r.id === rowId)!.display_name = 'Edited meanwhile'
    }
    await expect(runPlaintextBackfill(db, service, { dryRun: false })).rejects.toThrow(/changed under the lock/)
    expect(db.rollbacks).toBe(1)
    expect(db.tables.customer_entities!.rows[0]!.display_name).toBe('Ada Lovelace')
  })

  it('skips values that would overflow a length-limited column', async () => {
    const { db, service, org } = scenario()
    db.tables.customer_entities!.columns.primary_phone = { type: 'character varying', max: 40 }
    const report = await runPlaintextBackfill(db, service, { dryRun: false })
    expect(report.fields.get(`${org}|customer_entities|primary_phone`)).toMatchObject({ plaintext: 1, tooLong: 1, encrypted: 0 })
    expect(db.tables.customer_entities!.rows[0]!.primary_phone).toBe('+1 555 0100')
  })

  it('resumes after a given id inside one table', async () => {
    const { db, service } = scenario()
    const report = await runPlaintextBackfill(db, service, { dryRun: false, tables: ['customer_entities'], afterId: id(1) })
    expect(report.rowsChanged).toBe(2)
    expect(db.tables.customer_entities!.rows[0]!.display_name).toBe('Ada Lovelace')
    await expect(runPlaintextBackfill(db, service, { dryRun: true, afterId: id(1) })).rejects.toThrow(/exactly one --table/)
  })

  it('refuses when the key service is not enabled', async () => {
    const { db } = scenario()
    const off: BackfillEncryption = {
      isEnabled: () => false,
      getDek: async () => null,
      resolveEncryptedFields: async () => [],
      encryptEntityPayload: async (_e, p) => p,
    }
    await expect(runPlaintextBackfill(db, off, { dryRun: true })).rejects.toBeInstanceOf(BackfillRefusedError)
  })
})
