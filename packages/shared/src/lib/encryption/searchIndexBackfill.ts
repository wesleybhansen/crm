import {
  SEARCH_SOURCES,
  SEARCH_TOKENS_TABLE,
  buildSearchTokenRows,
  insertSearchTokenRows,
  isUnindexableValue,
  type SearchEntityType,
  type SearchSource,
  type SearchSql,
  type SearchTokenRow,
  type SearchTokenScope,
} from './searchIndex'
import { resolveSearchKey } from './searchKey'
import type { TenantDek } from './kms'

/**
 * Backfill and consistency check for the blind search index
 * (customer_search_tokens). Driven by scripts/reindex-customer-search.ts.
 *
 * - backfill: walk every contact / person / company / deal row in id order,
 *   decrypt its searchable fields, compute the tokens it should have, and
 *   compare with what is stored. A dry run (the default) only counts. With
 *   execute, entities that differ are rewritten, one transaction per batch,
 *   read back and compared before COMMIT. Idempotent: an in-sync entity is
 *   never touched, so a second run writes nothing. Resumable with afterId.
 * - check: the same comparison plus orphan tokens (entity deleted, moved to
 *   another organization, profile gone). Counts only unless execute, which
 *   repairs.
 *
 * Never prints a value or a token: counts, table names and row ids only.
 * Relative imports only: bundled into the standalone script.
 */

type DecryptService = {
  getDek(tenantId: string | null | undefined): Promise<TenantDek | null>
  decryptEntityPayloadForDisplay(
    entityId: string,
    payload: Record<string, unknown>,
    tenantId: string | null | undefined,
    organizationId?: string | null,
  ): Promise<{ payload: Record<string, unknown>; undecryptableFields: string[] }>
}

export interface SearchBackfillDb extends SearchSql {
  /** Run fn inside BEGIN/COMMIT on one connection; ROLLBACK and rethrow on error. */
  transaction<T>(fn: (tx: SearchSql) => Promise<T>): Promise<T>
}

export class SearchIndexVerificationError extends Error {
  readonly name = 'SearchIndexVerificationError'
}

export type SearchIndexMode = 'backfill' | 'check'

export type SearchIndexRunOptions = {
  mode: SearchIndexMode
  dryRun: boolean
  batchSize?: number
  tenantId?: string | null
  organizationId?: string | null
  /** Source tables to walk (default: all four). */
  tables?: string[]
  afterId?: string | null
  log?: (line: string) => void
}

export type SourceCounts = {
  rows: number
  entitiesInSync: number
  entitiesDrifted: number
  tokensMissing: number
  tokensExtra: number
  scopeMismatches: number
  unreadableFields: number
  noKey: number
  entitiesWritten: number
  lastId: string | null
}

export type SearchIndexReport = {
  mode: SearchIndexMode
  dryRun: boolean
  sources: Record<string, SourceCounts>
  orphanTokens: number
  orphanTokensRemoved: number
}

function emptyCounts(): SourceCounts {
  return {
    rows: 0, entitiesInSync: 0, entitiesDrifted: 0, tokensMissing: 0, tokensExtra: 0,
    scopeMismatches: 0, unreadableFields: 0, noKey: 0, entitiesWritten: 0, lastId: null,
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function selectBatchSql(source: SearchSource, filters: { tenant: boolean; org: boolean }): string {
  const cols = source.fields.map((f) => `s."${f.column}"`).join(', ')
  const parent = source.keyColumn === 'id'
    ? (source.table === 'customer_entities' ? 's.kind as kind' : 'null as kind') + ', s.deleted_at as parent_deleted_at'
    : 'ce.kind as kind, ce.deleted_at as parent_deleted_at'
  const join = source.keyColumn === 'id' ? '' : ' left join customer_entities ce on ce.id = s.entity_id'
  const where = ['(?::uuid is null or s.id > ?::uuid)']
  if (filters.tenant) where.push('s.tenant_id = ?')
  if (filters.org) where.push('s.organization_id = ?')
  return `select s.id, s."${source.keyColumn}" as search_key, s.tenant_id, s.organization_id, ${parent}, ${cols}
            from "${source.table}" s${join}
           where ${where.join(' and ')}
           order by s.id
           limit ?`
}

type Expected = {
  scope: SearchTokenScope
  /** field -> expected hashes; only fields that could be read. */
  fields: Map<string, Set<string>>
  deleted: boolean
}

function key3(entityId: string, entityType: string, field: string): string {
  return `${entityId}|${entityType}|${field}`
}

async function expectedFor(
  service: DecryptService,
  source: SearchSource,
  row: Record<string, unknown>,
  counts: SourceCounts,
): Promise<Expected | null> {
  const entityId = row.search_key ? String(row.search_key) : null
  const tenantId = row.tenant_id ? String(row.tenant_id) : null
  const organizationId = row.organization_id ? String(row.organization_id) : null
  const entityType = (source.entityType ?? (row.kind ? String(row.kind) : null)) as SearchEntityType | null
  if (!entityId || !tenantId || !organizationId || !entityType || !['person', 'company', 'deal'].includes(entityType)) return null
  const scope: SearchTokenScope = { tenantId, organizationId, entityType, entityId }
  const fields = new Map<string, Set<string>>()
  if (row.parent_deleted_at) {
    for (const f of source.fields) fields.set(f.column, new Set())
    return { scope, fields, deleted: true }
  }
  const payload: Record<string, unknown> = {}
  for (const f of source.fields) payload[f.column] = row[f.column] ?? null
  const { payload: values } = await service.decryptEntityPayloadForDisplay(source.entityId, payload, tenantId, organizationId)
  const key = await resolveSearchKey(tenantId, service)
  if (!key) { counts.noKey++; return null }
  const readable: Record<string, unknown> = {}
  for (const f of source.fields) {
    const v = values[f.column]
    if (isUnindexableValue(v)) { counts.unreadableFields++; continue }
    readable[f.column] = v
    fields.set(f.column, new Set())
  }
  for (const r of buildSearchTokenRows(key, source, scope, readable)) fields.get(r.field)!.add(r.tokenHash)
  return { scope, fields, deleted: false }
}

async function storedTokens(
  db: SearchSql,
  source: SearchSource,
  entityIds: string[],
): Promise<Map<string, { hashes: Set<string>; tenantId: string; organizationId: string }>> {
  const out = new Map<string, { hashes: Set<string>; tenantId: string; organizationId: string }>()
  if (!entityIds.length) return out
  const rows = await db.query<{ entity_id: string; entity_type: string; field: string; token_hash: string; tenant_id: string; organization_id: string }>(
    `select entity_id, entity_type, field, token_hash, tenant_id, organization_id
       from ${SEARCH_TOKENS_TABLE}
      where entity_id = any(?::uuid[]) and field = any(?::text[])`,
    [entityIds, source.fields.map((f) => f.column)],
  )
  for (const r of rows) {
    const k = key3(String(r.entity_id), String(r.entity_type), String(r.field))
    const entry = out.get(k) ?? { hashes: new Set<string>(), tenantId: String(r.tenant_id), organizationId: String(r.organization_id) }
    entry.hashes.add(String(r.token_hash))
    if (String(r.tenant_id) !== entry.tenantId || String(r.organization_id) !== entry.organizationId) entry.tenantId = '__mixed__'
    out.set(k, entry)
  }
  return out
}

type Diff = { drifted: boolean; missing: number; extra: number; scopeMismatch: boolean }

function diffEntity(exp: Expected, stored: Map<string, { hashes: Set<string>; tenantId: string; organizationId: string }>, source: SearchSource): Diff {
  let missing = 0
  let extra = 0
  let scopeMismatch = false
  for (const f of source.fields) {
    const want = exp.fields.get(f.column)
    const have = stored.get(key3(exp.scope.entityId, exp.scope.entityType, f.column))
    if (!want) continue // unreadable: leave whatever is stored
    const haveSet = have?.hashes ?? new Set<string>()
    for (const h of want) if (!haveSet.has(h)) missing++
    for (const h of haveSet) if (!want.has(h)) extra++
    if (have && (have.tenantId !== exp.scope.tenantId || have.organizationId !== exp.scope.organizationId)) scopeMismatch = true
  }
  // Tokens stored under the other contact kind (person <-> company changed).
  if (exp.scope.entityType !== 'deal') {
    const other = exp.scope.entityType === 'person' ? 'company' : 'person'
    for (const f of source.fields) {
      const wrong = stored.get(key3(exp.scope.entityId, other, f.column))
      if (wrong?.hashes.size) extra += wrong.hashes.size
    }
  }
  return { drifted: missing > 0 || extra > 0 || scopeMismatch, missing, extra, scopeMismatch }
}

async function rewrite(tx: SearchSql, source: SearchSource, exps: Expected[]): Promise<void> {
  const rows: SearchTokenRow[] = []
  for (const exp of exps) {
    const fields = Array.from(exp.fields.keys())
    if (!fields.length) continue
    const types = exp.scope.entityType === 'deal' ? ['deal'] : ['person', 'company']
    await tx.query(
      `delete from ${SEARCH_TOKENS_TABLE} where entity_id = ? and entity_type = any(?::text[]) and field = any(?::text[])`,
      [exp.scope.entityId, types, fields],
    )
    for (const [field, hashes] of exp.fields) for (const tokenHash of hashes) rows.push({ ...exp.scope, field, tokenHash })
  }
  await insertSearchTokenRows(tx, rows)
}

const ORPHAN_WHERE = `(
      (t.entity_type in ('person', 'company') and not exists (
        select 1 from customer_entities ce
         where ce.id = t.entity_id and ce.deleted_at is null and ce.kind = t.entity_type
           and ce.tenant_id = t.tenant_id and ce.organization_id = t.organization_id))
   or (t.entity_type = 'deal' and not exists (
        select 1 from customer_deals d
         where d.id = t.entity_id and d.deleted_at is null
           and d.tenant_id = t.tenant_id and d.organization_id = t.organization_id))
   or (t.field in ('first_name', 'last_name', 'preferred_name', 'job_title') and not exists (
        select 1 from customer_people p where p.entity_id = t.entity_id))
   or (t.field in ('legal_name', 'brand_name', 'domain', 'website_url') and not exists (
        select 1 from customer_companies c where c.entity_id = t.entity_id))
  )`

function scopeWhere(opts: SearchIndexRunOptions): { sql: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []
  if (opts.tenantId) { parts.push('t.tenant_id = ?'); params.push(opts.tenantId) }
  if (opts.organizationId) { parts.push('t.organization_id = ?'); params.push(opts.organizationId) }
  return { sql: parts.length ? ` and ${parts.join(' and ')}` : '', params }
}

export async function runSearchIndexJob(
  db: SearchBackfillDb,
  service: DecryptService,
  opts: SearchIndexRunOptions,
): Promise<SearchIndexReport> {
  const log = opts.log ?? (() => {})
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 200, 5000))
  for (const [name, v] of [['tenantId', opts.tenantId], ['organizationId', opts.organizationId], ['afterId', opts.afterId]] as const) {
    if (v && !UUID_RE.test(v)) throw new Error(`${name} must be a uuid`)
  }
  const sources = opts.tables?.length
    ? SEARCH_SOURCES.filter((s) => opts.tables!.includes(s.table))
    : [...SEARCH_SOURCES]
  if (opts.tables?.length && sources.length !== opts.tables.length) {
    throw new Error(`Unknown table; expected one of ${SEARCH_SOURCES.map((s) => s.table).join(', ')}`)
  }
  const report: SearchIndexReport = { mode: opts.mode, dryRun: opts.dryRun, sources: {}, orphanTokens: 0, orphanTokensRemoved: 0 }

  for (const source of sources) {
    const counts = emptyCounts()
    report.sources[source.table] = counts
    let after: string | null = opts.afterId ?? null
    const sql = selectBatchSql(source, { tenant: !!opts.tenantId, org: !!opts.organizationId })
    for (;;) {
      const params: unknown[] = [after, after]
      if (opts.tenantId) params.push(opts.tenantId)
      if (opts.organizationId) params.push(opts.organizationId)
      params.push(batchSize)
      const rows = await db.query<Record<string, unknown>>(sql, params)
      if (!rows.length) break
      counts.rows += rows.length
      const exps: Expected[] = []
      for (const row of rows) {
        const exp = await expectedFor(service, source, row, counts)
        if (exp) exps.push(exp)
      }
      const stored = await storedTokens(db, source, exps.map((e) => e.scope.entityId))
      const drifted: Expected[] = []
      for (const exp of exps) {
        const d = diffEntity(exp, stored, source)
        counts.tokensMissing += d.missing
        counts.tokensExtra += d.extra
        if (d.scopeMismatch) counts.scopeMismatches++
        if (d.drifted) { counts.entitiesDrifted++; drifted.push(exp) } else counts.entitiesInSync++
      }
      if (!opts.dryRun && drifted.length) {
        await db.transaction(async (tx) => {
          await rewrite(tx, source, drifted)
          // Read back inside the transaction: every rewritten entity must now match.
          const after = await storedTokens(tx, source, drifted.map((e) => e.scope.entityId))
          for (const exp of drifted) {
            if (diffEntity(exp, after, source).drifted) {
              throw new SearchIndexVerificationError(`${source.table}: tokens for ${exp.scope.entityId} did not verify after rewrite`)
            }
          }
        })
        counts.entitiesWritten += drifted.length
      }
      after = String(rows[rows.length - 1]!.id)
      counts.lastId = after
      log(`[search-index] ${source.table} batch up to ${after}: rows=${rows.length} drifted=${drifted.length}${opts.dryRun ? '' : ` written=${drifted.length}`}`)
      if (rows.length < batchSize) break
    }
  }

  const scope = scopeWhere(opts)
  const [orphans] = await db.query<{ n: number | string }>(
    `select count(*)::bigint as n from ${SEARCH_TOKENS_TABLE} t where ${ORPHAN_WHERE}${scope.sql}`,
    scope.params,
  )
  report.orphanTokens = Number(orphans?.n ?? 0)
  if (!opts.dryRun && report.orphanTokens > 0) {
    await db.transaction(async (tx) => {
      await tx.query(`delete from ${SEARCH_TOKENS_TABLE} t where ${ORPHAN_WHERE}${scope.sql}`, scope.params)
    })
    report.orphanTokensRemoved = report.orphanTokens
  }
  return report
}

export function formatSearchIndexReport(report: SearchIndexReport): string[] {
  const lines: string[] = []
  for (const [table, c] of Object.entries(report.sources)) {
    lines.push(
      `[search-index] ${table}: rows=${c.rows} in_sync=${c.entitiesInSync} drifted=${c.entitiesDrifted}`
        + ` tokens_missing=${c.tokensMissing} tokens_extra=${c.tokensExtra} scope_mismatch=${c.scopeMismatches}`
        + ` unreadable_fields=${c.unreadableFields} no_key=${c.noKey}`
        + (report.dryRun ? '' : ` written=${c.entitiesWritten}`)
        + (c.lastId ? ` last_id=${c.lastId}` : ''),
    )
  }
  lines.push(`[search-index] orphan_tokens=${report.orphanTokens}${report.dryRun ? '' : ` removed=${report.orphanTokensRemoved}`}`)
  return lines
}

/** Entities still out of step after a run (0 means the index matches the data). */
export function searchIndexDrift(report: SearchIndexReport): number {
  let n = 0
  for (const c of Object.values(report.sources)) n += c.entitiesDrifted - c.entitiesWritten
  return n + (report.orphanTokens - report.orphanTokensRemoved)
}
