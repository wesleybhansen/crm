/**
 * Encrypt, in place, contact data that was written in plaintext before every
 * write path went through the encrypting ORM path (2026-09-08 review, H1).
 *
 * Rules this module keeps:
 * - It never invents a scheme. Values are encrypted by
 *   TenantDataEncryptionService.encryptEntityPayload, with the fields that
 *   service resolves for the row's own tenant and organization, so a backfilled
 *   row is byte-for-byte what the app would have written.
 * - It never double-encrypts. Anything the shared envelope parser recognises
 *   (v1, interim v1.<keyId>, v2) is left alone, readable or not.
 * - It never prints a value. Output is counts per org/table/field and row ids.
 * - A dry run writes nothing. A real run is one transaction per batch, rows
 *   locked with FOR UPDATE, and every batch is read back and decrypted before
 *   COMMIT; any mismatch rolls the batch back and stops the run.
 * - It is resumable because it is idempotent: re-running only touches values
 *   that are still plaintext. `afterId` skips ahead inside one table.
 *
 * Relative imports only: this file is bundled by esbuild into a standalone
 * script for the production runner image, which cannot resolve `@/` aliases.
 */
import {
  TenantDataEncryptionError,
  TenantDataEncryptionErrorCode,
  decryptWithAesGcmStrict,
  isEncryptedEnvelope,
  keyIdForDek,
  keyIdFromEnvelope,
} from './aes'
import type { TenantDek } from './kms'
import { LOOKUP_HASH_RULES } from './lookupHashRules'
import { contactLookupHasher } from './lookupKey'
import type { EncryptedFieldRule } from './tenantDataEncryptionService'

/** Same text as tenantDataEncryptionService.UNDECRYPTABLE_DISPLAY_TEXT (kept literal to avoid a runtime import cycle). */
const UNDECRYPTABLE_PLACEHOLDER = 'This record could not be decrypted. Contact support.'

export type BackfillTable = { entityId: string; table: string }

/** Contact rows and the person/company/deal/activity/comment/address rows hanging off them. */
export const CONTACT_BACKFILL_TABLES: readonly BackfillTable[] = [
  { entityId: 'customers:customer_entity', table: 'customer_entities' },
  { entityId: 'customers:customer_person_profile', table: 'customer_people' },
  { entityId: 'customers:customer_company_profile', table: 'customer_companies' },
  { entityId: 'customers:customer_deal', table: 'customer_deals' },
  { entityId: 'customers:customer_activity', table: 'customer_activities' },
  { entityId: 'customers:customer_comment', table: 'customer_comments' },
  { entityId: 'customers:customer_address', table: 'customer_addresses' },
]

/**
 * Mapped tables outside the contact graph (2026-09-25 review, H2/M11): user
 * emails (six of nine production users were plaintext) and public event
 * registrations. Same rules as the contact tables.
 */
export const NON_CONTACT_BACKFILL_TABLES: readonly BackfillTable[] = [
  { entityId: 'auth:user', table: 'users' },
  { entityId: 'customers:event_attendee', table: 'event_attendees' },
]

/** Every table the backfill knows. The default selection. */
export const ENCRYPTED_BACKFILL_TABLES: readonly BackfillTable[] = [
  ...CONTACT_BACKFILL_TABLES,
  ...NON_CONTACT_BACKFILL_TABLES,
]

export type BackfillRow = Record<string, unknown>

/** One statement runner. `$1..$n` placeholders (node-postgres style). */
export interface BackfillQuery {
  query<T extends BackfillRow = BackfillRow>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>
}

export interface BackfillDb extends BackfillQuery {
  /** Run fn inside BEGIN/COMMIT on ONE connection; ROLLBACK and rethrow on any error. */
  transaction<T>(fn: (tx: BackfillQuery) => Promise<T>): Promise<T>
}

/** The slice of TenantDataEncryptionService the backfill uses. */
export interface BackfillEncryption {
  isEnabled(): boolean
  getDek(tenantId: string | null | undefined): Promise<TenantDek | null>
  resolveEncryptedFields(entityId: string, tenantId: string | null | undefined, organizationId?: string | null): Promise<EncryptedFieldRule[]>
  encryptEntityPayload(
    entityId: string,
    payload: Record<string, unknown>,
    tenantId: string | null | undefined,
    organizationId?: string | null,
  ): Promise<Record<string, unknown>>
}

export type StoredValueClass =
  | 'null'
  | 'empty'
  | 'placeholder'
  | 'plaintext'
  | 'envelope_ok'
  | 'envelope_wrong_key'
  | 'envelope_unreadable'

/**
 * Classify one stored value. Plaintext is anything that is a non-empty string
 * and not one of our envelopes. Envelopes are opened (never modified) so the
 * report can say whether they are readable with the key this process holds.
 */
export function classifyStoredValue(value: unknown, dekKey: string): StoredValueClass {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'string') return 'plaintext'
  if (value === '') return 'empty'
  if (value === UNDECRYPTABLE_PLACEHOLDER) return 'placeholder'
  if (!isEncryptedEnvelope(value)) return 'plaintext'
  try {
    decryptWithAesGcmStrict(value, dekKey)
    return 'envelope_ok'
  } catch (err) {
    if ((err as TenantDataEncryptionError)?.code === TenantDataEncryptionErrorCode.WRONG_KEY) return 'envelope_wrong_key'
    return 'envelope_unreadable'
  }
}

export type FieldCounts = {
  plaintext: number
  encrypted: number
  alreadyEncrypted: number
  wrongKey: number
  unreadable: number
  empty: number
  placeholder: number
  tooLong: number
  /** Contact lookup hash (email/phone) filled for a row that had none. */
  hashFilled: number
  /** Lookup hash left empty: another live contact in the org already holds it (legacy duplicate). */
  hashDuplicate: number
}

const emptyCounts = (): FieldCounts => ({
  plaintext: 0,
  encrypted: 0,
  alreadyEncrypted: 0,
  wrongKey: 0,
  unreadable: 0,
  empty: 0,
  placeholder: 0,
  tooLong: 0,
  hashFilled: 0,
  hashDuplicate: 0,
})

export type BackfillReport = {
  dryRun: boolean
  activeKeyIds: Record<string, string>
  /** key: `${organizationId}|${table}|${field}` */
  fields: Map<string, FieldCounts>
  /** Plaintext values in mapped-somewhere fields whose own scope has no active map (runtime would not encrypt them either). key: `${organizationId}|${table}|${field}` */
  unmapped: Map<string, number>
  /** Mapped fields that are missing from the table or are not text. key: `${table}|${field}` */
  skippedColumns: Map<string, string>
  rowsScanned: number
  rowsChanged: number
  batchesCommitted: number
  /** ids of rows written (real run) or that would be written (dry run), per `${organizationId}|${table}`. */
  rowIds: Map<string, string[]>
  lastIdByTable: Record<string, string | null>
}

export type BackfillOptions = {
  dryRun: boolean
  batchSize?: number
  /** Restrict to these table names (default: every ENCRYPTED_BACKFILL_TABLES entry). */
  tables?: string[]
  tenantId?: string | null
  organizationId?: string | null
  /** Keyset start inside the (single) selected table. */
  afterId?: string | null
  /** Collect row ids into the report. */
  collectRowIds?: boolean
  log?: (line: string) => void
  /** Per-transaction lock wait cap so a backfill never stalls app writes for long. */
  lockTimeoutMs?: number
}

export class BackfillRefusedError extends Error {
  readonly name = 'BackfillRefusedError'
}

export class BackfillVerificationError extends Error {
  readonly name = 'BackfillVerificationError'
}

/**
 * Hard preconditions, checked before any database access.
 * - TENANT_DATA_ENCRYPTION_KEY must be set: never the fallback variable, never
 *   the development default. The backfill must write under the dedicated key.
 * - Encryption must be on and the key source must be the derived scheme (the
 *   Vault provider is retired; writing under it is exactly the silent key
 *   substitution the retirement removed).
 */
export function assertBackfillEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const key = (env.TENANT_DATA_ENCRYPTION_KEY ?? '').trim().replace(/(?:^['"]|['"]$)/g, '')
  if (!key) {
    throw new BackfillRefusedError(
      'TENANT_DATA_ENCRYPTION_KEY is not set. Refusing to run: values would be encrypted under a fallback or development key.',
    )
  }
  const toggle = (env.TENANT_DATA_ENCRYPTION ?? '').trim().toLowerCase()
  if (['0', 'false', 'no', 'off', 'n', 'f'].includes(toggle)) {
    throw new BackfillRefusedError('TENANT_DATA_ENCRYPTION is disabled. Refusing to run.')
  }
  const provider = ((env.TENANT_KMS_PROVIDER ?? '').trim() || (env.TENANT_DATA_KMS ?? '').trim() || 'derived').toLowerCase()
  if (provider !== 'derived') {
    throw new BackfillRefusedError(`TENANT_KMS_PROVIDER=${provider}. The backfill only writes under the derived key scheme.`)
  }
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/
function ident(name: string): string {
  if (!IDENT_RE.test(name)) throw new BackfillRefusedError(`Unexpected identifier: ${name}`)
  return `"${name}"`
}

type ColumnInfo = { dataType: string; maxLength: number | null }

async function loadColumns(db: BackfillQuery, table: string): Promise<Map<string, ColumnInfo>> {
  const { rows } = await db.query<{ column_name: string; data_type: string; character_maximum_length: number | null }>(
    `select column_name, data_type, character_maximum_length
       from information_schema.columns
      where table_schema = current_schema() and table_name = $1`,
    [table],
  )
  const out = new Map<string, ColumnInfo>()
  for (const row of rows) {
    out.set(String(row.column_name), {
      dataType: String(row.data_type).toLowerCase(),
      maxLength: row.character_maximum_length == null ? null : Number(row.character_maximum_length),
    })
  }
  return out
}

/** Every field any active map (any scope) lists for this entity: the columns worth reading. */
async function loadCandidateFields(db: BackfillQuery, entityId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ fields_json: unknown }>(
    `select fields_json from encryption_maps where entity_id = $1 and is_active = true and deleted_at is null`,
    [entityId],
  )
  const out = new Set<string>()
  for (const row of rows) {
    let fields = row.fields_json
    if (typeof fields === 'string') {
      try { fields = JSON.parse(fields) } catch { fields = [] }
    }
    for (const rule of Array.isArray(fields) ? (fields as EncryptedFieldRule[]) : []) {
      if (rule?.field) out.add(String(rule.field))
      if (rule?.hashField) out.add(String(rule.hashField))
    }
  }
  return out
}

const TEXT_TYPES = new Set(['text', 'character varying', 'character'])

type PlannedWrite = {
  id: string
  tenantId: string
  organizationId: string
  /** column -> [stored plaintext, envelope to write] */
  values: Map<string, { before: string; after: string }>
  /** hash column -> value (only when the map rule asks for one) */
  hashes: Map<string, unknown>
  /** contact lookup hash column -> value, only written where the column is still null */
  lookupHashes: Map<string, string>
}

function bump(map: Map<string, FieldCounts>, key: string, field: keyof FieldCounts): void {
  let counts = map.get(key)
  if (!counts) { counts = emptyCounts(); map.set(key, counts) }
  counts[field] += 1
}

export async function runPlaintextBackfill(
  db: BackfillDb,
  encryption: BackfillEncryption,
  options: BackfillOptions,
): Promise<BackfillReport> {
  const log = options.log ?? (() => {})
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 200, 5000))
  const lockTimeoutMs = Math.max(100, options.lockTimeoutMs ?? 5000)
  if (!encryption.isEnabled()) {
    throw new BackfillRefusedError('Tenant data encryption service is not enabled (KMS unhealthy). Refusing to run.')
  }
  const selected = options.tables?.length
    ? ENCRYPTED_BACKFILL_TABLES.filter((t) => options.tables!.includes(t.table))
    : [...ENCRYPTED_BACKFILL_TABLES]
  if (options.tables?.length && selected.length !== options.tables.length) {
    const known = ENCRYPTED_BACKFILL_TABLES.map((t) => t.table).join(', ')
    throw new BackfillRefusedError(`Unknown table in --table. Known: ${known}`)
  }
  if (options.afterId && selected.length !== 1) {
    throw new BackfillRefusedError('--after-id needs exactly one --table.')
  }

  const report: BackfillReport = {
    dryRun: options.dryRun,
    activeKeyIds: {},
    fields: new Map(),
    unmapped: new Map(),
    skippedColumns: new Map(),
    rowsScanned: 0,
    rowsChanged: 0,
    batchesCommitted: 0,
    rowIds: new Map(),
    lastIdByTable: {},
  }

  const dekCache = new Map<string, TenantDek>()
  const getDek = async (tenantId: string): Promise<TenantDek> => {
    const cached = dekCache.get(tenantId)
    if (cached) return cached
    const dek = await encryption.getDek(tenantId)
    if (!dek?.key) throw new BackfillRefusedError(`No data key for tenant ${tenantId}. Refusing to run.`)
    dekCache.set(tenantId, dek)
    report.activeKeyIds[tenantId] = keyIdForDek(dek.key)
    return dek
  }

  for (const { entityId, table } of selected) {
    const columns = await loadColumns(db, table)
    if (!columns.size) {
      log(`[skip] table=${table} not present in this database`)
      continue
    }
    for (const required of ['id', 'tenant_id', 'organization_id']) {
      if (!columns.has(required)) throw new BackfillRefusedError(`${table} has no ${required} column; refusing.`)
    }
    const candidates = await loadCandidateFields(db, entityId)
    const readable: string[] = []
    for (const field of candidates) {
      const info = columns.get(field)
      if (!info) { report.skippedColumns.set(`${table}|${field}`, 'column missing'); continue }
      if (!TEXT_TYPES.has(info.dataType)) { report.skippedColumns.set(`${table}|${field}`, `non-text column (${info.dataType})`); continue }
      readable.push(field)
    }
    if (!readable.length) {
      log(`[skip] table=${table} entity=${entityId} no active encryption map lists a text column of this table`)
      continue
    }

    // Contact lookup hashes (primary_email_hash, primary_phone_hash). Every
    // lookup matches on these once the value is ciphertext, so a legacy row
    // encrypted without one would drop out of dedupe and bounce suppression.
    const lookupRules = (LOOKUP_HASH_RULES[entityId] ?? []).filter(
      (r) => readable.includes(r.sourceColumn) && columns.has(r.targetColumn),
    )
    const extraCols = lookupRules.map((r) => r.targetColumn)
    // Unique lookup hashes handed out during this run (legacy duplicates in
    // one org must not both claim the same hash).
    const claimedHashes = new Set<string>()
    if (lookupRules.some((r) => r.uniquePerOrg) && columns.has('deleted_at')) extraCols.push('deleted_at')
    const selectCols = ['id', 'tenant_id', 'organization_id', ...readable, ...extraCols].map(ident).join(', ')
    const scopeSql: string[] = []
    const scopeParams: unknown[] = []
    if (options.tenantId) { scopeParams.push(options.tenantId); scopeSql.push(`tenant_id = $${scopeParams.length}`) }
    if (options.organizationId) { scopeParams.push(options.organizationId); scopeSql.push(`organization_id = $${scopeParams.length}`) }

    /** Plan the writes for one batch of rows. Pure except for the service calls. */
    const planBatch = async (q: BackfillQuery, rows: BackfillRow[], countStats: boolean): Promise<PlannedWrite[]> => {
      const planned: PlannedWrite[] = []
      for (const row of rows) {
        const id = String(row.id)
        const tenantId = row.tenant_id ? String(row.tenant_id) : null
        const organizationId = row.organization_id ? String(row.organization_id) : null
        if (!tenantId || !organizationId) continue
        const rules = await encryption.resolveEncryptedFields(entityId, tenantId, organizationId)
        const statKey = (field: string) => `${organizationId}|${table}|${field}`
        if (!rules.length) {
          if (countStats) {
            for (const field of readable) {
              const v = row[field]
              if (typeof v === 'string' && v !== '' && !isEncryptedEnvelope(v)) {
                const key = statKey(field)
                report.unmapped.set(key, (report.unmapped.get(key) ?? 0) + 1)
              }
            }
          }
          continue
        }
        const dek = await getDek(tenantId)
        const plaintext: Record<string, string> = {}
        for (const rule of rules) {
          const field = String(rule.field)
          if (!readable.includes(field)) continue
          const cls = classifyStoredValue(row[field], dek.key)
          if (countStats) {
            if (cls === 'plaintext') bump(report.fields, statKey(field), 'plaintext')
            else if (cls === 'envelope_ok') bump(report.fields, statKey(field), 'alreadyEncrypted')
            else if (cls === 'envelope_wrong_key') bump(report.fields, statKey(field), 'wrongKey')
            else if (cls === 'envelope_unreadable') bump(report.fields, statKey(field), 'unreadable')
            else if (cls === 'empty') bump(report.fields, statKey(field), 'empty')
            else if (cls === 'placeholder') bump(report.fields, statKey(field), 'placeholder')
          }
          if (cls === 'plaintext' && typeof row[field] === 'string') plaintext[field] = row[field] as string
        }
        if (!Object.keys(plaintext).length) continue

        const encrypted = await encryption.encryptEntityPayload(entityId, { ...plaintext }, tenantId, organizationId)
        const activeKeyId = keyIdForDek(dek.key)
        const write: PlannedWrite = { id, tenantId, organizationId, values: new Map(), hashes: new Map(), lookupHashes: new Map() }
        for (const [field, before] of Object.entries(plaintext)) {
          const after = encrypted[field]
          // The service must have produced a fresh envelope under the active
          // key that opens back to exactly what is stored. Anything else means
          // the service and this backfill disagree about the map or the key:
          // stop before a single byte is written.
          if (typeof after !== 'string' || !isEncryptedEnvelope(after)) {
            throw new BackfillVerificationError(
              `encryptEntityPayload did not encrypt ${table}.${field} for row ${id} (map or key disagreement); nothing was written for this batch.`,
            )
          }
          if (keyIdFromEnvelope(after) !== activeKeyId) {
            throw new BackfillVerificationError(`Envelope for ${table}.${field} row ${id} is not stamped with the active key id.`)
          }
          if (decryptWithAesGcmStrict(after, dek.key) !== before) {
            throw new BackfillVerificationError(`Round trip mismatch for ${table}.${field} row ${id}.`)
          }
          const maxLength = columns.get(field)?.maxLength ?? null
          if (maxLength !== null && after.length > maxLength) {
            if (countStats) bump(report.fields, statKey(field), 'tooLong')
            continue
          }
          write.values.set(field, { before, after })
          const rule = rules.find((r) => r.field === field)
          if (rule?.hashField && columns.has(rule.hashField) && encrypted[rule.hashField] !== undefined) {
            write.hashes.set(rule.hashField, encrypted[rule.hashField])
          }
        }
        const hasher = lookupRules.length ? await contactLookupHasher(tenantId, encryption) : null
        for (const rule of lookupRules) {
          const source = write.values.get(rule.sourceColumn)
          if (!source || row[rule.targetColumn] != null) continue
          const normalized = rule.normalize(source.before)
          if (!normalized) continue
          // Keyed per tenant (lookupKey.ts); a holder of either format is the same person.
          const hash = hasher!.write(normalized) as string
          if (rule.uniquePerOrg && row.deleted_at == null) {
            const claimKey = `${organizationId}|${rule.targetColumn}|${hash}`
            const { rows: holders } = await q.query(
              `select id from ${ident(table)} where organization_id = $1 and ${ident(rule.targetColumn)} = any($2::text[]) and deleted_at is null and id <> $3 limit 1`,
              [organizationId, hasher!.candidates(normalized), id],
            )
            if (holders.length || claimedHashes.has(claimKey)) {
              if (countStats) bump(report.fields, statKey(rule.sourceColumn), 'hashDuplicate')
              continue
            }
            claimedHashes.add(claimKey)
          }
          write.lookupHashes.set(rule.targetColumn, hash)
        }
        if (write.values.size) planned.push(write)
      }
      return planned
    }

    const fetchBatch = async (q: BackfillQuery, afterId: string | null, lock: boolean): Promise<BackfillRow[]> => {
      const params = [...scopeParams]
      const where = [...scopeSql]
      if (afterId) { params.push(afterId); where.push(`id > $${params.length}`) }
      params.push(batchSize)
      const sql =
        `select ${selectCols} from ${ident(table)}`
        + (where.length ? ` where ${where.join(' and ')}` : '')
        + ` order by id limit $${params.length}`
        + (lock ? ' for update' : '')
      const { rows } = await q.query(sql, params)
      return rows
    }

    let afterId: string | null = options.afterId ?? null

    if (options.dryRun) {
      // Read-only: no transaction, no locks. Envelopes are still produced in
      // memory and opened again, so a dry run proves the key and the map work.
      for (;;) {
        const rows = await fetchBatch(db, afterId, false)
        if (!rows.length) break
        report.rowsScanned += rows.length
        const planned = await planBatch(db, rows, true)
        for (const write of planned) {
          report.rowsChanged += 1
          for (const field of write.values.keys()) bump(report.fields, `${write.organizationId}|${table}|${field}`, 'encrypted')
          countLookupHashes(report, table, write, lookupRules)
          if (options.collectRowIds) pushId(report, `${write.organizationId}|${table}`, write.id)
        }
        afterId = String(rows[rows.length - 1]!.id)
        report.lastIdByTable[table] = afterId
        log(`[dry-run] table=${table} scanned=${rows.length} would_encrypt_rows=${planned.length} last_id=${afterId}`)
      }
      continue
    }

    for (;;) {
      const outcome = await db.transaction(async (tx) => {
        await tx.query(`set local lock_timeout = '${Math.floor(lockTimeoutMs)}ms'`)
        const rows = await fetchBatch(tx, afterId, true)
        if (!rows.length) return null
        const planned = await planBatch(tx, rows, true)
        for (const write of planned) {
          const sets: string[] = []
          const params: unknown[] = []
          for (const [field, { after }] of write.values) { params.push(after); sets.push(`${ident(field)} = $${params.length}`) }
          for (const [hashCol, hash] of write.hashes) { params.push(hash); sets.push(`${ident(hashCol)} = $${params.length}`) }
          for (const [hashCol, hash] of write.lookupHashes) { params.push(hash); sets.push(`${ident(hashCol)} = $${params.length}`) }
          params.push(write.id)
          const idParam = params.length
          // Compare-and-set on every column: the row is locked, but if its
          // value is no longer the plaintext we planned from, touch nothing.
          const guards: string[] = []
          for (const [field, { before }] of write.values) { params.push(before); guards.push(`${ident(field)} = $${params.length}`) }
          for (const hashCol of write.lookupHashes.keys()) guards.push(`${ident(hashCol)} is null`)
          const result = await tx.query(
            `update ${ident(table)} set ${sets.join(', ')} where id = $${idParam} and ${guards.join(' and ')}`,
            params,
          )
          if (result.rowCount !== 1) {
            throw new BackfillVerificationError(`Row ${table}/${write.id} changed under the lock; batch rolled back.`)
          }
        }
        // Verify: read back what was written in this transaction and open it.
        if (planned.length) {
          const ids = planned.map((w) => w.id)
          const cols = Array.from(new Set(planned.flatMap((w) => [...w.values.keys(), ...w.lookupHashes.keys()])))
          const { rows: stored } = await tx.query(
            `select ${['id', ...cols].map(ident).join(', ')} from ${ident(table)} where id = any($1::uuid[])`,
            [ids],
          )
          const byId = new Map(stored.map((r) => [String(r.id), r]))
          for (const write of planned) {
            const row = byId.get(write.id)
            if (!row) throw new BackfillVerificationError(`Row ${table}/${write.id} missing on read-back.`)
            const dek = await getDek(write.tenantId)
            for (const [field, { before, after }] of write.values) {
              const value = row[field]
              if (value !== after) throw new BackfillVerificationError(`Read-back differs for ${table}.${field} row ${write.id}.`)
              if (decryptWithAesGcmStrict(String(value), dek.key) !== before) {
                throw new BackfillVerificationError(`Read-back does not decrypt to the original for ${table}.${field} row ${write.id}.`)
              }
            }
            for (const [hashCol, hash] of write.lookupHashes) {
              if (row[hashCol] !== hash) throw new BackfillVerificationError(`Read-back lookup hash differs for ${table}.${hashCol} row ${write.id}.`)
            }
          }
        }
        return { rows, planned }
      })
      if (!outcome) break
      report.batchesCommitted += 1
      report.rowsScanned += outcome.rows.length
      for (const write of outcome.planned) {
        report.rowsChanged += 1
        for (const field of write.values.keys()) bump(report.fields, `${write.organizationId}|${table}|${field}`, 'encrypted')
        countLookupHashes(report, table, write, lookupRules)
        if (options.collectRowIds) pushId(report, `${write.organizationId}|${table}`, write.id)
      }
      afterId = String(outcome.rows[outcome.rows.length - 1]!.id)
      report.lastIdByTable[table] = afterId
      log(`[committed] table=${table} scanned=${outcome.rows.length} encrypted_rows=${outcome.planned.length} last_id=${afterId}`)
    }
  }
  return report
}

function countLookupHashes(
  report: BackfillReport,
  table: string,
  write: PlannedWrite,
  rules: Array<{ sourceColumn: string; targetColumn: string }>,
): void {
  for (const rule of rules) {
    if (write.lookupHashes.has(rule.targetColumn)) bump(report.fields, `${write.organizationId}|${table}|${rule.sourceColumn}`, 'hashFilled')
  }
}

function pushId(report: BackfillReport, key: string, id: string): void {
  const list = report.rowIds.get(key) ?? []
  list.push(id)
  report.rowIds.set(key, list)
}

/**
 * Stop a real run before any write when the data already holds envelopes that
 * the active key cannot open. Writing new rows under a key that differs from
 * the one the existing rows use would split the tenant across two keys.
 */
export function assertSafeToWrite(preflight: BackfillReport, opts: { allowUnreadable?: boolean } = {}): void {
  let wrongKey = 0
  let unreadable = 0
  for (const counts of preflight.fields.values()) {
    wrongKey += counts.wrongKey
    unreadable += counts.unreadable
  }
  if (wrongKey > 0) {
    throw new BackfillRefusedError(
      `${wrongKey} stored value(s) are envelopes stamped with a different key id than the active key. `
        + 'Refusing to write: the configured TENANT_DATA_ENCRYPTION_KEY is not the key the existing data uses.',
    )
  }
  // A bare v1 envelope carries no key id, so a wrong key shows up only as an
  // authentication failure. Treat unreadable envelopes as a possible key
  // mismatch until someone has looked at them.
  if (unreadable > 0 && !opts.allowUnreadable) {
    throw new BackfillRefusedError(
      `${unreadable} stored envelope(s) do not open with the active key (possible key mismatch or corruption). `
        + 'Investigate first; pass --allow-unreadable only once they are understood. They are never modified either way.',
    )
  }
}

/** Human-readable report. Counts, org ids, table and field names, row ids. Never a value. */
export function formatBackfillReport(report: BackfillReport): string[] {
  const lines: string[] = []
  const tag = report.dryRun ? '[dry-run] ' : ''
  lines.push(`${tag}active key ids by tenant: ${Object.entries(report.activeKeyIds).map(([t, k]) => `${t}=${k}`).join(' ') || '(none resolved)'}`)
  lines.push(`${tag}org | table | field | plaintext_found | ${report.dryRun ? 'would_encrypt' : 'encrypted'} | already_encrypted | wrong_key | unreadable_envelope | empty | placeholder | too_long | lookup_hash_filled | lookup_hash_duplicate`)
  const keys = Array.from(report.fields.keys()).sort()
  for (const key of keys) {
    const c = report.fields.get(key)!
    const [org, table, field] = key.split('|')
    lines.push(`${tag}${org} | ${table} | ${field} | ${c.plaintext} | ${c.encrypted} | ${c.alreadyEncrypted} | ${c.wrongKey} | ${c.unreadable} | ${c.empty} | ${c.placeholder} | ${c.tooLong} | ${c.hashFilled} | ${c.hashDuplicate}`)
  }
  if (report.unmapped.size) {
    lines.push(`${tag}plaintext in scopes with NO active encryption map (the app does not encrypt these either; left untouched):`)
    for (const key of Array.from(report.unmapped.keys()).sort()) {
      const [org, table, field] = key.split('|')
      lines.push(`${tag}  ${org} | ${table} | ${field} | ${report.unmapped.get(key)}`)
    }
  }
  for (const [key, why] of report.skippedColumns) {
    const [table, field] = key.split('|')
    lines.push(`${tag}skipped column ${table}.${field}: ${why}`)
  }
  for (const [key, ids] of report.rowIds) {
    const [org, table] = key.split('|')
    lines.push(`${tag}row ids ${org} | ${table} (${ids.length}): ${ids.join(',')}`)
  }
  lines.push(`${tag}rows scanned=${report.rowsScanned} rows ${report.dryRun ? 'that would change' : 'changed'}=${report.rowsChanged} batches committed=${report.batchesCommitted}`)
  return lines
}
