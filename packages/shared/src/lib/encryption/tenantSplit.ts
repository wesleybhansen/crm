import crypto from 'node:crypto'
import { keyIdForDek } from './aes'
import { parseEnvelope } from './envelopeFormat'
import {
  addRekeyCounts,
  buildRoleIdMap,
  classifyTables,
  countUndecryptable,
  emptyRekeyCounts,
  planRoleMapping,
  qi,
  rekeyColumnValue,
  resolveKeys,
  tallyEnvelopeKeyIds,
  type ColumnInfo,
  type LiteralReplacements,
  type RekeyCounts,
  type ResolvedKeys,
  type TableInfo,
} from './tenantMove'

/**
 * Move every organization except one out of a shared tenant, each into a
 * tenant of its own (one tenant per customer). Driven by
 * scripts/split-tenants.ts; see that header for flags and the runbook.
 *
 * Per organization, in ONE transaction:
 *   1. the new tenant row (its id is picked once and kept in the ledger, so a
 *      rerun reuses it);
 *   2. org-scoped rows (tenant_id + organization_id) move: tenant_id rewritten,
 *      ids kept;
 *   3. tenant-level rows: the new tenant gets its own roles (by name;
 *      superadmin becomes admin), role ACLs copied without super admin,
 *      sidebar preferences, feature toggle overrides, tenant-wide encryption
 *      maps and custom field definitions; user_roles, api_keys.roles_json and
 *      every other role reference of a moved row are remapped; user ACLs and
 *      other tenant-level rows that hang off a moved row follow it;
 *      tenant-wide rows a moved row points at by foreign key are copied and
 *      the reference remapped;
 *   4. every envelope in a moved row (text, varchar, json and jsonb columns,
 *      jsonb walked recursively; encryption-map fields, sealSecret credential
 *      columns, API key session secrets, query-index documents) is decrypted
 *      strictly with the old tenant key and encrypted with the new one, and
 *      the literal old tenant id / old role ids are rewritten in plain strings;
 *   5. the organization's blind search tokens are deleted (they are keyed by
 *      the tenant key) and rebuilt after commit;
 *   6. organization_tenant_moves and the ledger are written.
 * Email/phone lookup hashes are unkeyed sha256 (aes.ts hashForLookup) and
 * survive the move unchanged.
 *
 * A dry run executes exactly the same statements and the verification inside
 * the transaction, then ROLLS BACK: it proves the run, not an estimate of it.
 *
 * Reports carry counts, table names and ids only, never a stored value.
 * Relative imports only: bundled into the standalone script.
 */

export type Row = Record<string, any>

export interface SplitQuery {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>
}

export interface SplitDb extends SplitQuery {
  /** BEGIN/COMMIT on one connection; ROLLBACK and rethrow on error. */
  transaction<T>(fn: (q: SplitQuery) => Promise<T>): Promise<T>
}

export class SplitRefusedError extends Error {
  readonly name = 'SplitRefusedError'
}
export class SplitVerificationError extends Error {
  readonly name = 'SplitVerificationError'
}
/** Thrown inside a dry-run transaction to roll it back after the report was collected. */
class DryRunRollback extends Error {
  readonly name = 'DryRunRollback'
}

export const LEDGER_TABLE = 'tenant_split_ledger'
export const SEEDED_ROLE_NAMES = ['superadmin', 'admin', 'employee'] as const

/**
 * Tenant-wide (organization_id null) configuration every tenant needs whole:
 * without the maps and field definitions a moved org would silently stop
 * encrypting (the maps and `encrypted: true` field configs are what decide it).
 * Copied into each new tenant with new ids. Nothing references these by id.
 */
export const TENANT_WIDE_COPY_TABLES = ['encryption_maps', 'custom_field_defs', 'custom_field_entity_configs'] as const

/** Tables handled explicitly; never moved or copied by the generic rules. */
const EXPLICIT_TENANT_TABLES = new Set([
  'organizations',
  'roles',
  'role_acls',
  'role_sidebar_preferences',
  'feature_toggle_overrides',
  'user_acls',
  LEDGER_TABLE,
  'organization_tenant_moves',
])

/** Rebuilt after commit (keyed by the tenant key), so deleted for moved orgs. */
const REBUILT_TABLES = new Set(['customer_search_tokens'])

export type SplitMode = 'dry-run' | 'execute' | 'verify'

export type SplitOptions = {
  keepOrganizationId: string
  /** Root organizations to move (default: every other root org in the kept org's tenant). */
  organizationIds?: string[]
  mode: SplitMode
  /** Skip organizations whose ledger already has a commit (default true for execute). */
  resume?: boolean
  /** Re-run committed organizations too (sweeps stragglers; every step is idempotent). */
  sweep?: boolean
  /** Treat an old-key-stamped envelope that fails to open as unreadable instead of stopping. */
  allowUnreadable?: boolean
  getDek: (tenantId: string) => Promise<string>
  /** Rebuild the blind search index for (tenant, org); returns entities still out of step. */
  rebuildSearch?: (tenantId: string, organizationId: string, dryRun: boolean) => Promise<number>
  log?: (line: string) => void
}

export type TableMoveCount = { table: string; moved: number }

export type OrgReport = {
  organizationId: string
  organizationIds: string[]
  newTenantId: string
  skipped: boolean
  users: number
  tablesMoved: TableMoveCount[]
  rolesCreated: string[]
  roleIdsRemapped: number
  superadminRolesDemoted: number
  superAdminAclsDropped: number
  tenantLevelRowsFollowed: Array<{ table: string; rows: number }>
  tenantWideRowsCopied: Array<{ table: string; rows: number }>
  uuidLiteralsRewritten: Array<{ table: string; column: string; rows: number }>
  rekey: RekeyCounts
  rekeyByTable: Array<{ table: string; rows: number } & RekeyCounts>
  searchTokensDeleted: number
  searchDrift: number | null
  scheduledJobIds: string[]
  verification: VerificationReport | null
}

export type VerificationReport = {
  ok: boolean
  wrongTenantRows: Array<{ table: string; rows: number }>
  oldKeyIdEnvelopes: Array<{ table: string; column: string; count: number }>
  newKeyUndecryptable: Array<{ table: string; column: string; count: number }>
  foreignEnvelopes: Array<{ table: string; column: string; count: number }>
  v1Envelopes: Array<{ table: string; column: string; count: number }>
  usersChecked: number
  userProblems: Array<{ userId: string; problem: string }>
  apiKeyProblems: Array<{ apiKeyId: string; problem: string }>
  crossTenantReferences: Array<{ table: string; column: string; refTable: string; rows: number }>
  unscopedTables: string[]
}

export type SplitReport = {
  mode: SplitMode
  oldTenantId: string
  keepOrganizationId: string
  oldKeyId: string
  orgs: OrgReport[]
  /** org-scoped rows per table before the run (kept + moved), and after. */
  rowCounts: Array<{ table: string; before: number; after: number }>
  /** Tenant-wide rows (organization_id null) left with the kept tenant, by table. */
  tenantWideLeft: Array<{ table: string; rows: number }>
  /** Rows that contain the literal old tenant id in a text/jsonb column (moved rows are rewritten). */
  literalTenantIdColumns: Array<{ table: string; column: string; rows: number }>
  tenantLevelTablesNotHandled: Array<{ table: string; rows: number }>
  childTablesWithoutPath: string[]
  /** Rows of tables with no path to an organization that hold old-key envelopes (review: kept org or a moved one?). */
  unattributedOldKeyRows: Array<{ table: string; rows: number }>
}

type Fk = { table: string; column: string; refTable: string; refColumn: string }

/**
 * Postgres rejects a bound parameter the statement never references ("could
 * not determine data type of parameter $n"). The shared scope clauses use $1
 * and sometimes $2/$3; this renumbers the placeholders a statement actually
 * uses and drops the rest, so every call can pass the full parameter list.
 */
export function compactParams(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
  const used = new Set<number>()
  sql.replace(/\$(\d+)/g, (_m, n: string) => {
    used.add(Number(n))
    return _m
  })
  const order = [...used].sort((a, b) => a - b)
  if (order.length === params.length && order.every((n, i) => n === i + 1)) return { sql, params }
  const renumber = new Map(order.map((n, i) => [n, i + 1]))
  return {
    sql: sql.replace(/\$(\d+)/g, (_m, n: string) => `$${renumber.get(Number(n))}`),
    params: order.map((n) => params[n - 1]),
  }
}

function compactQuery(q: SplitQuery): SplitQuery {
  return {
    query: (sql, params = []) => {
      const c = compactParams(sql, params)
      return q.query(c.sql, c.params)
    },
  }
}

function compactDb(db: SplitDb): SplitDb {
  return {
    ...compactQuery(db),
    transaction: (fn) => db.transaction((q) => fn(compactQuery(q))),
  }
}

type Schema = {
  tables: Map<string, TableInfo>
  pk: Map<string, string[]>
  fks: Fk[]
  colType: Map<string, string>
}

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function colTypeOf(schema: Schema, table: string, column: string): string | undefined {
  return schema.colType.get(`${table}.${column}`)
}

/** `alias.col = any($n)` that works whether the column is uuid or text. */
function inList(schema: Schema, table: string, alias: string, column: string, param: number): string {
  const type = colTypeOf(schema, table, column)
  return type === 'uuid' ? `${alias}.${qi(column)} = any($${param}::uuid[])` : `${alias}.${qi(column)}::text = any($${param}::text[])`
}

function eqParam(schema: Schema, table: string, alias: string, column: string, param: number): string {
  const type = colTypeOf(schema, table, column)
  return type === 'uuid' ? `${alias}.${qi(column)} = $${param}::uuid` : `${alias}.${qi(column)}::text = $${param}::text`
}

export async function loadSchema(q: SplitQuery): Promise<Schema> {
  const cols = await q.query<{ table_name: string; column_name: string; data_type: string }>(
    `select c.table_name, c.column_name, c.data_type
       from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = current_schema() and t.table_type = 'BASE TABLE'
      order by c.table_name, c.ordinal_position`,
  )
  const columns: ColumnInfo[] = cols.rows.map((r) => ({ table: r.table_name, column: r.column_name, dataType: r.data_type }))
  const pkRows = await q.query<{ table_name: string; column_name: string }>(
    `select tc.relname as table_name, a.attname as column_name
       from pg_index i
       join pg_class tc on tc.oid = i.indrelid
       join pg_namespace n on n.oid = tc.relnamespace
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indisprimary and n.nspname = current_schema()
      order by tc.relname, a.attnum`,
  )
  const pk = new Map<string, string[]>()
  for (const r of pkRows.rows) pk.set(r.table_name, [...(pk.get(r.table_name) ?? []), r.column_name])
  const fkRows = await q.query<{ table_name: string; column_name: string; ref_table: string; ref_column: string }>(
    `select cl.relname as table_name, a.attname as column_name, rcl.relname as ref_table, ra.attname as ref_column
       from pg_constraint c
       join pg_class cl on cl.oid = c.conrelid
       join pg_namespace n on n.oid = cl.relnamespace
       join pg_class rcl on rcl.oid = c.confrelid
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       join pg_attribute ra on ra.attrelid = c.confrelid and ra.attnum = c.confkey[1]
      where c.contype = 'f' and n.nspname = current_schema() and array_length(c.conkey, 1) = 1`,
  )
  const colType = new Map<string, string>()
  for (const c of columns) colType.set(`${c.table}.${c.column}`, c.dataType)
  return {
    tables: classifyTables(columns),
    pk,
    fks: fkRows.rows.map((r) => ({ table: r.table_name, column: r.column_name, refTable: r.ref_table, refColumn: r.ref_column })),
    colType,
  }
}

/**
 * Scope of the rows of `table` that belong to the moved organizations
 * ($1 = org ids as text[]/uuid[]), as a FROM-less WHERE clause over alias t.
 * null when the table has no path to an organization.
 */
function scopeClause(schema: Schema, table: string, movedUsersParam?: number): string | null {
  const info = schema.tables.get(table)
  if (!info) return null
  if (info.cls === 'org' || info.cls === 'org_only') return inList(schema, table, 't', 'organization_id', 1)
  if (table === 'organizations') return inList(schema, table, 't', 'id', 1)
  if (table === 'user_acls' && movedUsersParam) return `t."user_id" = any($${movedUsersParam}::uuid[])`
  // child / other tenant-level: follow the first foreign key to an org-scoped parent
  for (const fk of schema.fks) {
    if (fk.table !== table) continue
    const parent = schema.tables.get(fk.refTable)
    if (!parent) continue
    if (fk.refTable === 'organizations') return inList(schema, table, 't', fk.column, 1)
    if (parent.cls === 'org' || parent.cls === 'org_only') {
      return `t.${qi(fk.column)} in (select p.${qi(fk.refColumn)} from ${qi(fk.refTable)} p where ${inList(schema, fk.refTable, 'p', 'organization_id', 1)})`
    }
  }
  // No declared foreign key: follow a `<thing>_id` column to the one
  // org-scoped table named `<thing>s` / `<thing>es` / `*_<thing>s`
  // (message_recipients.message_id -> messages, webhook_deliveries.subscription_id
  // -> webhook_subscriptions). Children of raw tables often have no FK.
  if (info.cls === 'child') {
    for (const col of info.columns) {
      const m = /^(.+)_id$/.exec(col.column)
      if (!m || col.column === 'tenant_id' || col.column === 'organization_id') continue
      const base = m[1]
      const scoped = [...schema.tables.values()].filter((t) =>
        (t.cls === 'org' || t.cls === 'org_only') && t.columns.some((c) => c.column === 'id'),
      )
      const exact = scoped.filter((t) => t.table === `${base}s` || t.table === `${base}es`)
      const candidates = exact.length ? exact : scoped.filter((t) => t.table.endsWith(`_${base}s`))
      if (candidates.length !== 1) continue
      const parent = candidates[0]!.table
      return `t.${qi(col.column)}::text in (select p."id"::text from ${qi(parent)} p where ${inList(schema, parent, 'p', 'organization_id', 1)})`
    }
  }
  return null
}

async function ensureLedger(q: SplitQuery): Promise<void> {
  await q.query(`create table if not exists ${qi(LEDGER_TABLE)} (
    "id" bigint generated by default as identity primary key,
    "organization_id" uuid not null,
    "old_tenant_id" uuid not null,
    "new_tenant_id" uuid not null,
    "step" text not null,
    "table_name" text,
    "rows" integer not null default 0,
    "done_at" timestamptz not null default now()
  )`)
}

async function ledgerTenantFor(q: SplitQuery, orgId: string, oldTenantId: string): Promise<{ newTenantId: string | null; committed: boolean }> {
  const exists = await q.query(`select to_regclass($1)::text as t`, [LEDGER_TABLE])
  if (!exists.rows[0]?.t) return { newTenantId: null, committed: false }
  const rows = await q.query<{ new_tenant_id: string; step: string }>(
    `select new_tenant_id::text as new_tenant_id, step from ${qi(LEDGER_TABLE)}
      where organization_id = $1 and old_tenant_id = $2 order by id`,
    [orgId, oldTenantId],
  )
  if (!rows.rows.length) return { newTenantId: null, committed: false }
  return { newTenantId: rows.rows[0].new_tenant_id, committed: rows.rows.some((r) => r.step === 'commit') }
}

async function ledger(q: SplitQuery, orgId: string, oldTenantId: string, newTenantId: string, step: string, table: string | null, rows: number) {
  await q.query(
    `insert into ${qi(LEDGER_TABLE)} (organization_id, old_tenant_id, new_tenant_id, step, table_name, rows) values ($1, $2, $3, $4, $5, $6)`,
    [orgId, oldTenantId, newTenantId, step, table, rows],
  )
}

/** Root org + its descendants (by parent_id), never crossing into the kept tree. */
async function orgTree(q: SplitQuery, rootId: string): Promise<string[]> {
  const rows = await q.query<{ id: string }>(
    `with recursive tree as (
       select id from organizations where id = $1
       union
       select o.id from organizations o join tree on o.parent_id = tree.id
     ) select id::text as id from tree`,
    [rootId],
  )
  return rows.rows.map((r) => r.id)
}

function emptyOrgReport(organizationId: string, newTenantId: string): OrgReport {
  return {
    organizationId,
    organizationIds: [organizationId],
    newTenantId,
    skipped: false,
    users: 0,
    tablesMoved: [],
    rolesCreated: [],
    roleIdsRemapped: 0,
    superadminRolesDemoted: 0,
    superAdminAclsDropped: 0,
    tenantLevelRowsFollowed: [],
    tenantWideRowsCopied: [],
    uuidLiteralsRewritten: [],
    rekey: emptyRekeyCounts(),
    rekeyByTable: [],
    searchTokensDeleted: 0,
    searchDrift: null,
    scheduledJobIds: [],
    verification: null,
  }
}

/** Override value for copyRow: a fresh primary key (gen_random_uuid, or the column default). */
const NEW_ID = Symbol('new-id')

async function copyRow(
  q: SplitQuery,
  schema: Schema,
  table: string,
  whereSql: string,
  whereParams: unknown[],
  overrides: Record<string, unknown>,
): Promise<number> {
  const info = schema.tables.get(table)!
  const params: unknown[] = [...whereParams]
  const select: string[] = []
  const names: string[] = []
  for (const col of info.columns) {
    if (overrides[col.column] === NEW_ID) {
      if (col.dataType !== 'uuid') continue // integer/identity key: let the default fill it
      names.push(qi(col.column))
      select.push('gen_random_uuid()')
      continue
    }
    names.push(qi(col.column))
    if (col.column in overrides) {
      params.push(overrides[col.column])
      select.push(`$${params.length}::${col.dataType === 'uuid' ? 'uuid' : col.dataType === 'jsonb' ? 'jsonb' : col.dataType === 'json' ? 'json' : 'text'}`)
    } else {
      select.push(`t.${qi(col.column)}`)
    }
  }
  const res = await q.query(`insert into ${qi(table)} (${names.join(', ')}) select ${select.join(', ')} from ${qi(table)} t where ${whereSql}`, params)
  return res.rowCount
}

type RekeyContext = {
  keys: ResolvedKeys
  replacements: LiteralReplacements
  allowUnreadable: boolean
}

function prefilterPatterns(ctx: { oldTenantId: string; roleIds: string[] }): string[] {
  return ['%:v1%', '%:v2:%', `%${ctx.oldTenantId}%`, ...ctx.roleIds.map((id) => `%${id}%`)]
}

/** Re-key (and rewrite literals in) every scan column of the scoped rows of one table. */
async function rekeyTable(
  q: SplitQuery,
  schema: Schema,
  table: string,
  scope: string,
  scopeParams: unknown[],
  ctx: RekeyContext,
  patterns: string[],
): Promise<{ rows: number; counts: RekeyCounts }> {
  const info = schema.tables.get(table)!
  const counts = emptyRekeyCounts()
  if (!info.scanColumns.length) return { rows: 0, counts }
  const pk = schema.pk.get(table)
  const keyCols = pk && pk.length ? pk : null
  const patternParam = scopeParams.length + 1
  const filter = info.scanColumns.map((c) => `t.${qi(c.column)}::text like any($${patternParam}::text[])`).join(' or ')
  const keySelect = keyCols ? keyCols.map((c) => `t.${qi(c)} as ${qi(`__k_${c}`)}`).join(', ') : `t.ctid::text as "__ctid"`
  const res = await q.query(
    `select ${keySelect}, ${info.scanColumns.map((c) => `t.${qi(c.column)}`).join(', ')}
       from ${qi(table)} t where (${scope}) and (${filter})`,
    [...scopeParams, patterns],
  )
  let rowsChanged = 0
  for (const row of res.rows) {
    const sets: string[] = []
    const params: unknown[] = []
    for (const col of info.scanColumns) {
      let r
      try {
        r = rekeyColumnValue(row[col.column], col.isJson, ctx.keys, ctx.replacements)
      } catch (err) {
        if (!ctx.allowUnreadable) {
          const e = new SplitVerificationError(`${table}.${col.column}: an envelope stamped with the old key id did not open with the old key`)
          ;(e as any).cause = err
          throw e
        }
        counts.unreadable++
        continue
      }
      addRekeyCounts(counts, r.counts)
      if (!r.changed) continue
      const type = colTypeOf(schema, table, col.column)
      params.push(col.isJson ? JSON.stringify(r.value) : r.value)
      sets.push(`${qi(col.column)} = $${params.length}${type === 'jsonb' ? '::jsonb' : type === 'json' ? '::json' : ''}`)
    }
    if (!sets.length) continue
    let where: string
    if (keyCols) {
      where = keyCols.map((c) => {
        params.push(row[`__k_${c}`])
        return `${qi(c)} = $${params.length}`
      }).join(' and ')
    } else {
      params.push(row.__ctid)
      where = `ctid = $${params.length}::tid`
    }
    await q.query(`update ${qi(table)} set ${sets.join(', ')} where ${where}`, params)
    rowsChanged++
  }
  return { rows: rowsChanged, counts }
}

/** Move one root organization (and its descendants) into newTenantId. */
async function moveOrganization(
  q: SplitQuery,
  schema: Schema,
  opts: { oldTenantId: string; newTenantId: string; rootOrgId: string; keys: ResolvedKeys; allowUnreadable: boolean; log: (l: string) => void },
): Promise<OrgReport> {
  const { oldTenantId, newTenantId, rootOrgId } = opts
  const report = emptyOrgReport(rootOrgId, newTenantId)
  const orgIds = await orgTree(q, rootOrgId)
  report.organizationIds = orgIds

  // 1. Tenant row (named after the organization; inactive/deleted like it).
  const org = (await q.query(`select name, is_active, deleted_at from organizations where id = $1`, [rootOrgId])).rows[0]
  await q.query(
    `insert into tenants (id, name, is_active, created_at, updated_at, deleted_at, seed_version)
     values ($1, $2, $3, now(), now(), $4, 0) on conflict (id) do nothing`,
    [newTenantId, String(org?.name ?? 'Workspace'), org?.is_active !== false, org?.deleted_at ?? null],
  )

  // Moved users (ids kept) and the old roles their rows reference.
  const users = await q.query<{ id: string }>(
    `select t.id::text as id from users t where ${inList(schema, 'users', 't', 'organization_id', 1)}`,
    [orgIds],
  )
  const movedUsers = users.rows.map((r) => r.id)
  report.users = movedUsers.length

  const referenced = new Map<string, string>()
  const addRoles = async (sql: string, params: unknown[]) => {
    for (const r of (await q.query<{ id: string; name: string }>(sql, params)).rows) referenced.set(r.id, r.name)
  }
  await addRoles(
    `select r.id::text as id, r.name from user_roles ur join roles r on r.id = ur.role_id
      where ur.user_id = any($1::uuid[]) and r.tenant_id = $2`,
    [movedUsers, oldTenantId],
  )
  // Role ids inside jsonb lists (api_keys.roles_json) and role_id columns of moved rows.
  if (schema.tables.has('api_keys')) {
    await addRoles(
      `select r.id::text as id, r.name from roles r
        where r.tenant_id = $2 and exists (select 1 from api_keys k where ${inList(schema, 'api_keys', 'k', 'organization_id', 1)}
          and k.roles_json is not null and k.roles_json::jsonb @> to_jsonb(r.id::text))`,
      [orgIds, oldTenantId],
    )
  }
  const roleRefColumns = roleReferenceColumns(schema)
  for (const ref of roleRefColumns) {
    const scope = scopeClause(schema, ref.table, 3)
    if (!scope) continue
    await addRoles(
      `select r.id::text as id, r.name from roles r where r.tenant_id = $2
         and r.id::text in (select t.${qi(ref.column)}::text from ${qi(ref.table)} t where ${scope})`,
      [orgIds, oldTenantId, movedUsers],
    )
  }

  // 2. Org-scoped rows move (ids kept). Search tokens are keyed by the tenant
  //    key: deleted here, rebuilt after commit.
  for (const info of schema.tables.values()) {
    if (info.cls !== 'org' || EXPLICIT_TENANT_TABLES.has(info.table)) continue
    if (REBUILT_TABLES.has(info.table)) {
      const del = await q.query(
        `delete from ${qi(info.table)} t where ${inList(schema, info.table, 't', 'organization_id', 1)}`,
        [orgIds],
      )
      report.searchTokensDeleted += del.rowCount
      continue
    }
    const res = await q.query(
      `update ${qi(info.table)} t set "tenant_id" = $2 where ${inList(schema, info.table, 't', 'organization_id', 1)} and ${eqParam(schema, info.table, 't', 'tenant_id', 3)}`,
      [orgIds, newTenantId, oldTenantId],
    )
    if (res.rowCount) report.tablesMoved.push({ table: info.table, moved: res.rowCount })
  }
  const orgRes = await q.query(`update organizations set tenant_id = $2, updated_at = now() where id = any($1::uuid[]) and tenant_id = $3`, [orgIds, newTenantId, oldTenantId])
  if (orgRes.rowCount) report.tablesMoved.push({ table: 'organizations', moved: orgRes.rowCount })

  // 3a. Roles of the new tenant: the seeded names plus every referenced name.
  const plan = planRoleMapping([...referenced].map(([id, name]) => ({ id, name })), SEEDED_ROLE_NAMES)
  report.superadminRolesDemoted = plan.demotedSuperadmin.length
  const newRolesByName = new Map<string, string>()
  for (const name of plan.requiredNames) {
    const ins = await q.query<{ id: string }>(
      `insert into roles (id, name, tenant_id, created_at) values (gen_random_uuid(), $1, $2, now())
       on conflict (tenant_id, name) do nothing returning id::text as id`,
      [name, newTenantId],
    )
    if (ins.rows.length) report.rolesCreated.push(name)
    const row = (await q.query<{ id: string }>(`select id::text as id from roles where tenant_id = $1 and name = $2`, [newTenantId, name])).rows[0]
    newRolesByName.set(name, row.id)
  }
  const roleMap = buildRoleIdMap(plan, newRolesByName)

  // 3b. Role ACLs for the new roles: copied from the old tenant's role of the
  //     same name, never as super admin, org list narrowed to the moved orgs.
  for (const [name, newRoleId] of newRolesByName) {
    // The superadmin role exists (seeding expects it) but a customer tenant
    // never gets its grant: nobody moved holds it (they were demoted to admin).
    if (name === 'superadmin') continue
    const has = await q.query(`select 1 from role_acls where role_id = $1 and tenant_id = $2 and deleted_at is null limit 1`, [newRoleId, newTenantId])
    if (has.rows.length) continue
    const src = (await q.query(
      `select a.features_json, a.is_super_admin, a.organizations_json from role_acls a join roles r on r.id = a.role_id
        where r.tenant_id = $1 and r.name = $2 and a.tenant_id = $1 and a.deleted_at is null
        order by a.is_super_admin asc limit 1`,
      [oldTenantId, name],
    )).rows[0]
    if (!src) continue
    if (src.is_super_admin) report.superAdminAclsDropped++
    let orgsJson = src.organizations_json
    if (Array.isArray(orgsJson)) {
      const kept = orgsJson.filter((id: unknown) => typeof id === 'string' && orgIds.includes(id))
      orgsJson = kept.length ? kept : null
    }
    await q.query(
      `insert into role_acls (id, role_id, tenant_id, features_json, is_super_admin, organizations_json, created_at)
       values (gen_random_uuid(), $1, $2, $3::jsonb, false, $4::jsonb, now())`,
      [newRoleId, newTenantId, src.features_json == null ? null : JSON.stringify(src.features_json), orgsJson == null ? null : JSON.stringify(orgsJson)],
    )
  }

  // 3c. Sidebar preferences of the referenced roles.
  if (schema.tables.has('role_sidebar_preferences')) {
    for (const [oldRoleId, newRoleId] of roleMap) {
      await q.query(
        `insert into role_sidebar_preferences (id, role_id, tenant_id, locale, settings_json, created_at, updated_at)
         select gen_random_uuid(), $2, $3, p.locale, p.settings_json, now(), now() from role_sidebar_preferences p
          where p.role_id = $1 and p.deleted_at is null
            and not exists (select 1 from role_sidebar_preferences x where x.role_id = $2 and x.tenant_id = $3 and x.locale = p.locale)`,
        [oldRoleId, newRoleId, newTenantId],
      )
    }
  }

  // 3d. Remap role references of moved rows: user_roles and role id columns.
  const oldRoleIds = [...roleMap.keys()]
  // Role ids come from the catalog (uuids), never from input.
  const caseSql = (col: string) => `case ${col}::text ${[...roleMap].map(([o, n]) => `when '${o}' then '${n}'`).join(' ')} else ${col}::text end`
  if (oldRoleIds.length) {
    const ur = await q.query(
      `update user_roles set role_id = (${caseSql('role_id')})::uuid where user_id = any($1::uuid[]) and role_id = any($2::uuid[])`,
      [movedUsers, oldRoleIds],
    )
    report.roleIdsRemapped += ur.rowCount
    for (const ref of roleRefColumns) {
      if (ref.table === 'user_roles') continue
      const scope = scopeClause(schema, ref.table, 3)
      if (!scope) continue
      const type = colTypeOf(schema, ref.table, ref.column)
      const res = await q.query(
        `update ${qi(ref.table)} t set ${qi(ref.column)} = (${caseSql(`t.${qi(ref.column)}`)})${type === 'uuid' ? '::uuid' : ''}
          where (${scope}) and t.${qi(ref.column)}::text = any($2::text[])`,
        [orgIds, oldRoleIds, movedUsers],
      )
      report.roleIdsRemapped += res.rowCount
    }
  }

  // 3e. Tenant-level rows that hang off a moved row follow it.
  if (schema.tables.has('user_acls')) {
    const sup = await q.query(`select count(*)::int as n from user_acls where user_id = any($1::uuid[]) and tenant_id = $2 and is_super_admin`, [movedUsers, oldTenantId])
    report.superAdminAclsDropped += Number(sup.rows[0]?.n ?? 0)
    const ua = await q.query(
      `update user_acls set tenant_id = $2, is_super_admin = false where user_id = any($1::uuid[]) and tenant_id = $3`,
      [movedUsers, newTenantId, oldTenantId],
    )
    if (ua.rowCount) report.tenantLevelRowsFollowed.push({ table: 'user_acls', rows: ua.rowCount })
  }
  for (const info of schema.tables.values()) {
    if (info.cls !== 'tenant' || EXPLICIT_TENANT_TABLES.has(info.table)) continue
    const scope = scopeClause(schema, info.table)
    if (!scope) continue
    const res = await q.query(
      `update ${qi(info.table)} t set "tenant_id" = $2 where (${scope}) and ${eqParam(schema, info.table, 't', 'tenant_id', 3)}`,
      [orgIds, newTenantId, oldTenantId],
    )
    if (res.rowCount) report.tenantLevelRowsFollowed.push({ table: info.table, rows: res.rowCount })
  }

  // 3f. Feature toggle overrides (tenant configuration) and tenant-wide config.
  if (schema.tables.has('feature_toggle_overrides')) {
    const ft = await q.query(
      `insert into feature_toggle_overrides (id, toggle_id, tenant_id, value, created_at, updated_at)
       select gen_random_uuid(), o.toggle_id, $2, o.value, now(), now() from feature_toggle_overrides o
        where o.tenant_id = $1 and not exists (select 1 from feature_toggle_overrides x where x.toggle_id = o.toggle_id and x.tenant_id = $2)`,
      [oldTenantId, newTenantId],
    )
    if (ft.rowCount) report.tenantWideRowsCopied.push({ table: 'feature_toggle_overrides', rows: ft.rowCount })
  }
  for (const table of TENANT_WIDE_COPY_TABLES) {
    const info = schema.tables.get(table)
    if (!info || info.cls !== 'org') continue
    const already = await q.query(`select count(*)::int as n from ${qi(table)} where tenant_id = $1 and organization_id is null`, [newTenantId])
    if (Number(already.rows[0]?.n ?? 0) > 0) continue
    const live = colTypeOf(schema, table, 'deleted_at') ? ' and t.deleted_at is null' : ''
    const n = await copyRow(q, schema, table, `t.tenant_id::text = $1 and t.organization_id is null${live}`, [oldTenantId], {
      id: NEW_ID,
      tenant_id: newTenantId,
    })
    if (n) report.tenantWideRowsCopied.push({ table, rows: n })
  }

  // 3g. Tenant-wide rows a moved row points at by foreign key: copy, remap.
  for (let pass = 0; pass < 5; pass++) {
    let copiedThisPass = 0
    for (const fk of schema.fks) {
      const parent = schema.tables.get(fk.refTable)
      if (!parent || parent.cls !== 'org' || fk.refColumn !== 'id' || EXPLICIT_TENANT_TABLES.has(fk.refTable)) continue
      const scope = scopeClause(schema, fk.table, 2)
      if (!scope) continue
      const refs = await q.query<{ id: string }>(
        `select distinct p.id::text as id from ${qi(fk.refTable)} p
          where p.organization_id is null and ${eqParam(schema, fk.refTable, 'p', 'tenant_id', 3)}
            and p.id in (select t.${qi(fk.column)} from ${qi(fk.table)} t where ${scope})`,
        [orgIds, movedUsers, oldTenantId],
      )
      for (const ref of refs.rows) {
        const newId = crypto.randomUUID()
        await copyRow(q, schema, fk.refTable, `t.id::text = $1`, [ref.id], { id: newId, tenant_id: newTenantId })
        await q.query(
          `update ${qi(fk.table)} t set ${qi(fk.column)} = $4 where (${scope}) and t.${qi(fk.column)} = $3`,
          [orgIds, movedUsers, ref.id, newId],
        )
        copiedThisPass++
        const entry = report.tenantWideRowsCopied.find((e) => e.table === fk.refTable)
        if (entry) entry.rows++
        else report.tenantWideRowsCopied.push({ table: fk.refTable, rows: 1 })
      }
    }
    if (!copiedThisPass) break
  }

  // 3h. uuid columns (other than the scope columns) holding the old tenant id.
  for (const info of schema.tables.values()) {
    if (info.cls !== 'org' && info.cls !== 'org_only') continue
    for (const column of info.uuidColumns) {
      if (column === 'id' || column === 'tenant_id' || column === 'organization_id') continue
      const res = await q.query(
        `update ${qi(info.table)} t set ${qi(column)} = $2 where ${inList(schema, info.table, 't', 'organization_id', 1)} and t.${qi(column)} = $3`,
        [orgIds, newTenantId, oldTenantId],
      )
      if (res.rowCount) report.uuidLiteralsRewritten.push({ table: info.table, column, rows: res.rowCount })
    }
  }

  // 4. Re-key every envelope in moved rows; rewrite literals in plain strings.
  const ctx: RekeyContext = {
    keys: opts.keys,
    replacements: {
      exact: new Map([...roleMap]),
      substring: new Map([[oldTenantId, newTenantId]]),
    },
    allowUnreadable: opts.allowUnreadable,
  }
  const patterns = prefilterPatterns({ oldTenantId, roleIds: oldRoleIds })
  for (const info of schema.tables.values()) {
    if (REBUILT_TABLES.has(info.table) || info.table === LEDGER_TABLE) continue
    let scope: string | null
    let params: unknown[]
    const copiedHere = TENANT_WIDE_COPY_TABLES.includes(info.table as any) || report.tenantWideRowsCopied.some((e) => e.table === info.table)
    if (copiedHere && info.cls === 'tenant') {
      // tenant-level rows copied into the new tenant (feature toggle overrides)
      scope = eqParam(schema, info.table, 't', 'tenant_id', 2)
      params = [orgIds, newTenantId]
    } else if (copiedHere && info.cls === 'org') {
      // moved rows plus the tenant-wide rows copied into the new tenant
      scope = `(${inList(schema, info.table, 't', 'organization_id', 1)}) or (t.organization_id is null and ${eqParam(schema, info.table, 't', 'tenant_id', 2)})`
      params = [orgIds, newTenantId]
    } else {
      scope = scopeClause(schema, info.table, 2)
      params = [orgIds, movedUsers]
    }
    if (!scope) continue
    const r = await rekeyTable(q, schema, info.table, scope, params, ctx, patterns)
    if (r.rows || r.counts.foreign || r.counts.unreadable) {
      report.rekeyByTable.push({ table: info.table, rows: r.rows, ...r.counts })
    }
    addRekeyCounts(report.rekey, r.counts)
  }

  // 6. Schedules whose BullMQ repeatables carry the old tenant id.
  const sjInfo = schema.tables.get('scheduled_jobs')
  if (sjInfo && sjInfo.cls === 'org' && colTypeOf(schema, 'scheduled_jobs', 'is_enabled') && colTypeOf(schema, 'scheduled_jobs', 'deleted_at')) {
    const sj = await q.query<{ id: string }>(
      `select id::text as id from scheduled_jobs t where ${inList(schema, 'scheduled_jobs', 't', 'organization_id', 1)} and t.is_enabled and t.deleted_at is null`,
      [orgIds],
    )
    report.scheduledJobIds = sj.rows.map((r) => r.id)
  }

  for (const orgId of orgIds) {
    await q.query(
      `insert into organization_tenant_moves (organization_id, from_tenant_id, to_tenant_id) values ($1, $2, $3)
       on conflict (organization_id, from_tenant_id) do update set to_tenant_id = excluded.to_tenant_id`,
      [orgId, oldTenantId, newTenantId],
    )
  }
  return report
}

/** role_id columns (by FK to roles, or by name when a table has no FK for it) outside the explicit tenant tables. */
function roleReferenceColumns(schema: Schema): Array<{ table: string; column: string }> {
  const out: Array<{ table: string; column: string }> = []
  const seen = new Set<string>()
  const fkCols = new Set(schema.fks.map((f) => `${f.table}.${f.column}`))
  for (const fk of schema.fks) {
    if (fk.refTable !== 'roles' || EXPLICIT_TENANT_TABLES.has(fk.table)) continue
    const key = `${fk.table}.${fk.column}`
    if (!seen.has(key)) { seen.add(key); out.push({ table: fk.table, column: fk.column }) }
  }
  for (const info of schema.tables.values()) {
    if (EXPLICIT_TENANT_TABLES.has(info.table) || info.cls !== 'org') continue
    for (const c of info.columns) {
      const key = `${info.table}.${c.column}`
      if (c.column === 'role_id' && !fkCols.has(key) && !seen.has(key)) { seen.add(key); out.push({ table: info.table, column: c.column }) }
    }
  }
  return out
}

/** Verify one moved org tree against its new tenant. Counts only. */
export async function verifyOrganization(
  q: SplitQuery,
  schema: Schema,
  opts: { oldTenantId: string; newTenantId: string; orgIds: string[]; oldKeyId: string; newKey: string },
): Promise<VerificationReport> {
  const { oldTenantId, newTenantId, orgIds } = opts
  const v: VerificationReport = {
    ok: true,
    wrongTenantRows: [],
    oldKeyIdEnvelopes: [],
    newKeyUndecryptable: [],
    foreignEnvelopes: [],
    v1Envelopes: [],
    usersChecked: 0,
    userProblems: [],
    apiKeyProblems: [],
    crossTenantReferences: [],
    unscopedTables: [],
  }
  const newKeyId = keyIdForDek(opts.newKey)
  const users = (await q.query<{ id: string; tenant_id: string | null }>(
    `select id::text as id, tenant_id::text as tenant_id from users where organization_id = any($1::uuid[])`, [orgIds],
  )).rows
  const movedUsers = users.map((u) => u.id)

  for (const info of schema.tables.values()) {
    if (info.cls === 'org' && !EXPLICIT_TENANT_TABLES.has(info.table)) {
      const wrong = await q.query(
        `select count(*)::int as n from ${qi(info.table)} t where ${inList(schema, info.table, 't', 'organization_id', 1)}
           and (t.tenant_id is null or t.tenant_id::text <> $2)`,
        [orgIds, newTenantId],
      )
      const n = Number(wrong.rows[0]?.n ?? 0)
      if (n) v.wrongTenantRows.push({ table: info.table, rows: n })
    }
    if (!info.scanColumns.length || info.table === LEDGER_TABLE) continue
    let scope = scopeClause(schema, info.table, 2)
    let params: unknown[] = [orgIds, movedUsers]
    if (TENANT_WIDE_COPY_TABLES.includes(info.table as any)) {
      scope = `(${inList(schema, info.table, 't', 'organization_id', 1)}) or (t.organization_id is null and ${eqParam(schema, info.table, 't', 'tenant_id', 2)})`
      params = [orgIds, newTenantId]
    }
    if (!scope) {
      if (info.cls === 'child' || info.cls === 'tenant') v.unscopedTables.push(info.table)
      continue
    }
    const rows = await q.query(
      `select ${info.scanColumns.map((c) => `t.${qi(c.column)}`).join(', ')} from ${qi(info.table)} t
        where (${scope}) and (${info.scanColumns.map((c) => `t.${qi(c.column)}::text like any($${params.length + 1}::text[])`).join(' or ')})`,
      [...params, ['%:v1%', '%:v2:%']],
    )
    for (const col of info.scanColumns) {
      let oldN = 0, foreignN = 0, v1N = 0, badNew = 0
      for (const row of rows.rows) {
        const tally = tallyEnvelopeKeyIds(row[col.column])
        oldN += tally.byKeyId.get(opts.oldKeyId) ?? 0
        v1N += tally.v1
        for (const [kid, cnt] of tally.byKeyId) if (kid !== opts.oldKeyId && kid !== newKeyId) foreignN += cnt
        if ((tally.byKeyId.get(newKeyId) ?? 0) > 0) {
          // only the new-key envelopes must open with the new key
          const onlyNew = filterEnvelopes(row[col.column], newKeyId)
          badNew += countUndecryptable(onlyNew, opts.newKey).failed
        }
      }
      if (oldN) v.oldKeyIdEnvelopes.push({ table: info.table, column: col.column, count: oldN })
      if (badNew) v.newKeyUndecryptable.push({ table: info.table, column: col.column, count: badNew })
      if (foreignN) v.foreignEnvelopes.push({ table: info.table, column: col.column, count: foreignN })
      if (v1N) v.v1Envelopes.push({ table: info.table, column: col.column, count: v1N })
    }
  }

  // Users: tenant consistent with the org, every role in the user's tenant.
  const orgTenant = new Map(
    (await q.query<{ id: string; tenant_id: string }>(`select id::text as id, tenant_id::text as tenant_id from organizations where id = any($1::uuid[])`, [orgIds])).rows.map((r) => [r.id, r.tenant_id]),
  )
  for (const u of users) {
    v.usersChecked++
    if (u.tenant_id !== newTenantId) v.userProblems.push({ userId: u.id, problem: 'user tenant is not the new tenant' })
  }
  for (const [orgId, t] of orgTenant) if (t !== newTenantId) v.userProblems.push({ userId: orgId, problem: 'organization tenant is not the new tenant' })
  const badRoles = await q.query<{ user_id: string }>(
    `select distinct ur.user_id::text as user_id from user_roles ur join roles r on r.id = ur.role_id
      where ur.user_id = any($1::uuid[]) and (r.tenant_id is null or r.tenant_id::text <> $2)`,
    [movedUsers, newTenantId],
  )
  for (const r of badRoles.rows) v.userProblems.push({ userId: r.user_id, problem: 'user has a role outside the new tenant' })

  // API keys: every role id in roles_json belongs to the new tenant.
  if (schema.tables.has('api_keys')) {
    const keys = await q.query<{ id: string; roles_json: unknown }>(
      `select id::text as id, roles_json from api_keys t where ${inList(schema, 'api_keys', 't', 'organization_id', 1)} and roles_json is not null`,
      [orgIds],
    )
    const roleIds = new Set(
      (await q.query<{ id: string }>(`select id::text as id from roles where tenant_id = $1`, [newTenantId])).rows.map((r) => r.id),
    )
    for (const k of keys.rows) {
      const list = Array.isArray(k.roles_json) ? k.roles_json : []
      for (const item of list) {
        if (typeof item === 'string' && uuidRe.test(item) && !roleIds.has(item)) {
          v.apiKeyProblems.push({ apiKeyId: k.id, problem: 'roles_json references a role outside the new tenant' })
          break
        }
      }
    }
  }

  // Foreign keys from moved rows to rows still in the old tenant.
  for (const fk of schema.fks) {
    const parent = schema.tables.get(fk.refTable)
    if (!parent || (parent.cls !== 'org' && parent.cls !== 'tenant') || fk.refTable === 'organizations') continue
    const child = schema.tables.get(fk.table)
    if (!child || child.cls !== 'org' || EXPLICIT_TENANT_TABLES.has(fk.table)) continue
    const res = await q.query(
      `select count(*)::int as n from ${qi(fk.table)} t join ${qi(fk.refTable)} p on p.${qi(fk.refColumn)} = t.${qi(fk.column)}
        where ${inList(schema, fk.table, 't', 'organization_id', 1)} and p.tenant_id::text = $2`,
      [orgIds, oldTenantId],
    )
    const n = Number(res.rows[0]?.n ?? 0)
    if (n) v.crossTenantReferences.push({ table: fk.table, column: fk.column, refTable: fk.refTable, rows: n })
  }

  v.ok =
    v.wrongTenantRows.length === 0 &&
    v.oldKeyIdEnvelopes.length === 0 &&
    v.newKeyUndecryptable.length === 0 &&
    v.userProblems.length === 0 &&
    v.apiKeyProblems.length === 0
  // crossTenantReferences are reported, not fatal: they are pre-existing
  // references from a moved row to a row of another organization (the app
  // never follows them across tenants), not something the move created.
  return v
}

/** Keep only the envelopes stamped with keyId (verification helper). */
function filterEnvelopes(value: unknown, keyId: string): unknown[] {
  const out: unknown[] = []
  const visit = (node: unknown) => {
    if (typeof node === 'string') {
      if (parseEnvelope(node)?.keyId === keyId) out.push(node)
      return
    }
    if (Array.isArray(node)) node.forEach(visit)
    else if (node && typeof node === 'object') Object.values(node as Record<string, unknown>).forEach(visit)
  }
  visit(value)
  return out
}

async function orgScopedCounts(q: SplitQuery, schema: Schema, tenantIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const info of schema.tables.values()) {
    if (info.cls !== 'org' || EXPLICIT_TENANT_TABLES.has(info.table) || REBUILT_TABLES.has(info.table)) continue
    const res = await q.query(`select count(*)::int as n from ${qi(info.table)} where tenant_id::text = any($1::text[]) and organization_id is not null`, [tenantIds])
    out.set(info.table, Number(res.rows[0]?.n ?? 0))
  }
  return out
}

/**
 * Plan and run the split. dry-run: every org's transaction runs in full and
 * rolls back. execute: commits org by org (resumable). verify: read-only.
 */
export async function runTenantSplit(rawDb: SplitDb, opts: SplitOptions): Promise<SplitReport> {
  const db = compactDb(rawDb)
  const log = opts.log ?? (() => {})
  const keep = (await db.query<{ tenant_id: string; parent_id: string | null }>(
    `select tenant_id::text as tenant_id, parent_id::text as parent_id from organizations where id = $1`,
    [opts.keepOrganizationId],
  )).rows[0]
  if (!keep) throw new SplitRefusedError(`keep organization ${opts.keepOrganizationId} not found`)
  const oldTenantId = keep.tenant_id
  const seedCol = await db.query(
    `select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'tenants' and column_name = 'seed_version'`,
  )
  const movesTable = await db.query(`select to_regclass('organization_tenant_moves')::text as t`)
  if (!seedCol.rows.length || !movesTable.rows[0]?.t) {
    throw new SplitRefusedError('tenants.seed_version / organization_tenant_moves missing: run `mercato db migrate` first (Migration20260926120000)')
  }
  const schema = await loadSchema(db)
  const oldKey = await opts.getDek(oldTenantId)
  const oldKeyId = keyIdForDek(oldKey)
  const keepTree = new Set(await orgTree(db, opts.keepOrganizationId))

  // Root organizations to move: from the ledger for verify, else the old tenant's.
  let roots: string[]
  if (opts.organizationIds?.length) {
    roots = opts.organizationIds
  } else if (opts.mode === 'verify') {
    const hasLedger = (await db.query(`select to_regclass($1)::text as t`, [LEDGER_TABLE])).rows[0]?.t
    roots = hasLedger
      ? (await db.query<{ id: string }>(
          `select distinct organization_id::text as id from ${qi(LEDGER_TABLE)} where old_tenant_id = $1 and step = 'commit'`, [oldTenantId],
        )).rows.map((r) => r.id)
      : []
  } else {
    // Orgs still in the old tenant, plus orgs earlier runs already moved (so a
    // resumed run reports them as skipped and --sweep re-runs them).
    const hasLedger = (await db.query(`select to_regclass($1)::text as t`, [LEDGER_TABLE])).rows[0]?.t
    const earlier = hasLedger
      ? (await db.query<{ id: string }>(
          `select organization_id::text as id from ${qi(LEDGER_TABLE)} where old_tenant_id = $1 group by organization_id order by min(id)`, [oldTenantId],
        )).rows.map((r) => r.id)
      : []
    const remaining = (await db.query<{ id: string }>(
      `select id::text as id from organizations where tenant_id = $1 and parent_id is null order by created_at`, [oldTenantId],
    )).rows.map((r) => r.id).filter((id) => !keepTree.has(id))
    roots = [...new Set([...earlier, ...remaining])]
  }
  for (const id of roots) {
    if (keepTree.has(id)) throw new SplitRefusedError(`organization ${id} is the kept organization (or inside its tree)`)
  }

  const report: SplitReport = {
    mode: opts.mode,
    oldTenantId,
    keepOrganizationId: opts.keepOrganizationId,
    oldKeyId,
    orgs: [],
    rowCounts: [],
    tenantWideLeft: [],
    literalTenantIdColumns: [],
    tenantLevelTablesNotHandled: [],
    childTablesWithoutPath: [],
    unattributedOldKeyRows: [],
  }

  // Planning facts (read-only).
  for (const info of schema.tables.values()) {
    if (info.cls === 'org' && !TENANT_WIDE_COPY_TABLES.includes(info.table as any) && !EXPLICIT_TENANT_TABLES.has(info.table)) {
      const n = Number((await db.query(`select count(*)::int as n from ${qi(info.table)} where tenant_id::text = $1 and organization_id is null`, [oldTenantId])).rows[0]?.n ?? 0)
      if (n) report.tenantWideLeft.push({ table: info.table, rows: n })
    }
    if (info.cls === 'tenant' && !EXPLICIT_TENANT_TABLES.has(info.table) && !scopeClause(schema, info.table)) {
      const n = Number((await db.query(`select count(*)::int as n from ${qi(info.table)} where tenant_id::text = $1`, [oldTenantId])).rows[0]?.n ?? 0)
      if (n) report.tenantLevelTablesNotHandled.push({ table: info.table, rows: n })
    }
    if (info.cls === 'child' && info.scanColumns.length && !scopeClause(schema, info.table) && !info.table.startsWith('mikro_orm_migrations')) {
      report.childTablesWithoutPath.push(info.table)
      // Old-key envelopes there cannot be attributed to an org: list them for review.
      const n = Number((await db.query(
        `select count(*)::int as n from ${qi(info.table)} t where ${info.scanColumns.map((c) => `t.${qi(c.column)}::text like $1`).join(' or ')}`,
        [`%:${oldKeyId}%`],
      )).rows[0]?.n ?? 0)
      if (n) report.unattributedOldKeyRows.push({ table: info.table, rows: n })
    }
    if ((info.cls === 'org' || info.cls === 'org_only') && roots.length && opts.mode !== 'verify') {
      for (const col of info.scanColumns) {
        const n = Number((await db.query(
          `select count(*)::int as n from ${qi(info.table)} t where ${inList(schema, info.table, 't', 'organization_id', 1)} and t.${qi(col.column)}::text like $2`,
          [roots, `%${oldTenantId}%`],
        )).rows[0]?.n ?? 0)
        if (n) report.literalTenantIdColumns.push({ table: info.table, column: col.column, rows: n })
      }
    }
  }

  if (opts.mode === 'execute') {
    await db.transaction(async (q) => { await ensureLedger(q) })
  }
  // Row counts over the old tenant plus every tenant earlier runs created, so a
  // resumed or sweeping run compares like with like.
  const ledgerExists = (await db.query(`select to_regclass($1)::text as t`, [LEDGER_TABLE])).rows[0]?.t
  const knownTenants = ledgerExists
    ? (await db.query<{ t: string }>(`select distinct new_tenant_id::text as t from ${qi(LEDGER_TABLE)} where old_tenant_id = $1`, [oldTenantId])).rows.map((r) => r.t)
    : []
  const baseline = await orgScopedCounts(db, schema, [oldTenantId, ...knownTenants])
  const newTenantIds: string[] = []

  for (const rootId of roots) {
    const prior = await ledgerTenantFor(db, rootId, oldTenantId)
    const newTenantId = prior.newTenantId ?? crypto.randomUUID()
    newTenantIds.push(newTenantId)
    const newKey = await opts.getDek(newTenantId)
    const keys = resolveKeys({ oldKey, newKey, oldKeyId })
    if (keys.newKeyId === oldKeyId) throw new SplitRefusedError('new tenant key id equals the old one')

    if (opts.mode === 'verify') {
      const orgIds = await orgTree(db, rootId)
      const r = emptyOrgReport(rootId, newTenantId)
      r.organizationIds = orgIds
      r.verification = await verifyOrganization(db, schema, { oldTenantId, newTenantId, orgIds, oldKeyId, newKey })
      if (opts.rebuildSearch) r.searchDrift = await opts.rebuildSearch(newTenantId, rootId, true)
      report.orgs.push(r)
      continue
    }
    if (prior.committed && !opts.sweep && opts.resume !== false) {
      const r = emptyOrgReport(rootId, newTenantId)
      r.skipped = true
      report.orgs.push(r)
      log(`[split] org ${rootId}: already committed to tenant ${newTenantId}, skipped (use --sweep to re-run)`)
      continue
    }
    if (opts.mode === 'execute' && !prior.newTenantId) {
      // Pick the tenant id once and keep it, so a rerun after a crash reuses it.
      await db.transaction(async (q) => ledger(q, rootId, oldTenantId, newTenantId, 'plan', null, 0))
    }

    const dryRun = opts.mode === 'dry-run'
    let orgReport: OrgReport | null = null
    try {
      await db.transaction(async (q) => {
        const r = await moveOrganization(q, schema, { oldTenantId, newTenantId, rootOrgId: rootId, keys, allowUnreadable: Boolean(opts.allowUnreadable), log })
        r.verification = await verifyOrganization(q, schema, { oldTenantId, newTenantId, orgIds: r.organizationIds, oldKeyId, newKey })
        orgReport = r
        if (!r.verification.ok) {
          throw new SplitVerificationError(`organization ${rootId}: verification failed inside the transaction (rolled back)`)
        }
        if (dryRun) throw new DryRunRollback('dry run')
        for (const t of r.tablesMoved) await ledger(q, rootId, oldTenantId, newTenantId, 'move', t.table, t.moved)
        for (const t of r.rekeyByTable) await ledger(q, rootId, oldTenantId, newTenantId, 'rekey', t.table, t.rows)
        await ledger(q, rootId, oldTenantId, newTenantId, 'commit', null, r.users)
      })
    } catch (err) {
      if (!(err instanceof DryRunRollback)) {
        if (orgReport) report.orgs.push(orgReport)
        throw err
      }
    }
    const done = orgReport as OrgReport | null
    if (!done) continue
    report.orgs.push(done)
    log(`[split] org ${rootId}: ${dryRun ? 'dry run (rolled back)' : 'committed'} -> tenant ${newTenantId}`)

    // 5. Search tokens: rebuilt under the new tenant key after commit.
    if (!dryRun && opts.rebuildSearch) {
      done.searchDrift = await opts.rebuildSearch(newTenantId, rootId, false)
      await db.transaction(async (q) => ledger(q, rootId, oldTenantId, newTenantId, 'search', 'customer_search_tokens', done.searchDrift ?? 0))
    }
  }

  const after = await orgScopedCounts(db, schema, [...new Set([oldTenantId, ...knownTenants, ...newTenantIds])])
  for (const [table, before] of baseline) {
    const a = after.get(table) ?? 0
    if (before || a) report.rowCounts.push({ table, before, after: a })
  }
  return report
}

export function formatSplitReport(report: SplitReport): string[] {
  const lines: string[] = []
  lines.push(`[split] mode=${report.mode} old_tenant=${report.oldTenantId} keep_org=${report.keepOrganizationId} old_key_id=${report.oldKeyId} orgs=${report.orgs.length}`)
  for (const t of report.tenantWideLeft) lines.push(`[plan] tenant-wide rows staying with the kept tenant: ${t.table}=${t.rows}`)
  for (const t of report.tenantLevelTablesNotHandled) lines.push(`[plan] tenant-level table with no path to an org (rows stay with the kept tenant): ${t.table}=${t.rows}`)
  for (const t of report.childTablesWithoutPath) lines.push(`[plan] child table with no path to an organization (not re-keyed): ${t}`)
  for (const t of report.unattributedOldKeyRows) lines.push(`[plan] REVIEW: ${t.table} has ${t.rows} rows with old-key envelopes and no path to an organization`)
  for (const t of report.literalTenantIdColumns) lines.push(`[plan] old tenant id literal in moved rows: ${t.table}.${t.column}=${t.rows} (rewritten)`)
  for (const o of report.orgs) {
    const head = `[org ${o.organizationId}] tenant=${o.newTenantId}${o.skipped ? ' SKIPPED (committed earlier)' : ''} orgs=${o.organizationIds.length} users=${o.users}`
    lines.push(head)
    if (o.skipped) continue
    if (o.tablesMoved.length) lines.push(`  moved: ${o.tablesMoved.map((t) => `${t.table}=${t.moved}`).join(' ')}`)
    lines.push(`  roles created=${o.rolesCreated.join(',') || '-'} role refs remapped=${o.roleIdsRemapped} superadmin roles demoted=${o.superadminRolesDemoted} super-admin ACLs dropped=${o.superAdminAclsDropped}`)
    if (o.tenantLevelRowsFollowed.length) lines.push(`  tenant-level rows followed: ${o.tenantLevelRowsFollowed.map((t) => `${t.table}=${t.rows}`).join(' ')}`)
    if (o.tenantWideRowsCopied.length) lines.push(`  tenant-wide rows copied: ${o.tenantWideRowsCopied.map((t) => `${t.table}=${t.rows}`).join(' ')}`)
    if (o.uuidLiteralsRewritten.length) lines.push(`  uuid columns holding the old tenant id: ${o.uuidLiteralsRewritten.map((t) => `${t.table}.${t.column}=${t.rows}`).join(' ')}`)
    lines.push(`  re-keyed envelopes=${o.rekey.rekeyed} already-new=${o.rekey.alreadyNew} foreign=${o.rekey.foreign} unreadable=${o.rekey.unreadable} literals=${o.rekey.literalsReplaced}`)
    for (const t of o.rekeyByTable) lines.push(`    ${t.table}: rows=${t.rows} rekeyed=${t.rekeyed} foreign=${t.foreign} unreadable=${t.unreadable} literals=${t.literalsReplaced}`)
    lines.push(`  search tokens deleted=${o.searchTokensDeleted} rebuilt drift=${o.searchDrift ?? 'n/a'} schedules to re-register=${o.scheduledJobIds.length}`)
    const v = o.verification
    if (v) {
      lines.push(`  verify: ${v.ok ? 'OK' : 'FAILED'} users=${v.usersChecked}`
        + ` wrong-tenant=${v.wrongTenantRows.map((t) => `${t.table}:${t.rows}`).join(',') || 0}`
        + ` old-key-envelopes=${v.oldKeyIdEnvelopes.map((t) => `${t.table}.${t.column}:${t.count}`).join(',') || 0}`
        + ` new-key-undecryptable=${v.newKeyUndecryptable.map((t) => `${t.table}.${t.column}:${t.count}`).join(',') || 0}`)
      if (v.foreignEnvelopes.length) lines.push(`    foreign-key envelopes (unreadable before the move too): ${v.foreignEnvelopes.map((t) => `${t.table}.${t.column}:${t.count}`).join(',')}`)
      if (v.v1Envelopes.length) lines.push(`    v1 envelopes left (did not open with the old key): ${v.v1Envelopes.map((t) => `${t.table}.${t.column}:${t.count}`).join(',')}`)
      for (const p of v.userProblems) lines.push(`    user ${p.userId}: ${p.problem}`)
      for (const p of v.apiKeyProblems) lines.push(`    api key ${p.apiKeyId}: ${p.problem}`)
      for (const p of v.crossTenantReferences) lines.push(`    ${p.table}.${p.column} -> ${p.refTable} in the old tenant: ${p.rows}`)
    }
  }
  const mismatched = report.rowCounts.filter((c) => report.mode !== 'dry-run' && c.before !== c.after)
  lines.push(`[counts] org-scoped tables=${report.rowCounts.length} total before=${report.rowCounts.reduce((s, c) => s + c.before, 0)} after=${report.rowCounts.reduce((s, c) => s + c.after, 0)} mismatched=${mismatched.length}`)
  for (const c of mismatched) lines.push(`  ${c.table}: before=${c.before} after=${c.after}`)
  return lines
}

export function splitReportOk(report: SplitReport): boolean {
  if (report.orgs.some((o) => o.verification && !o.verification.ok)) return false
  if (report.orgs.some((o) => (o.searchDrift ?? 0) > 0)) return false
  if (report.mode !== 'dry-run' && report.rowCounts.some((c) => c.before !== c.after)) return false
  return true
}
