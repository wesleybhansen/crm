import {
  SEARCH_SOURCES_BY_ENTITY_ID,
  buildSearchTokenRows,
  deleteSearchTokensForEntities,
  insertSearchTokenRows,
  isUnindexableValue,
  replaceSearchTokens,
  searchSqlFromEm,
  searchTokensTableExists,
  type SearchEntityType,
  type SearchSource,
  type SearchSql,
  type SearchTokenRow,
  type SearchTokenScope,
} from './searchIndex'
import { resolveSearchKey } from './searchKey'
import type { TenantDek } from './kms'

/**
 * Keeping customer_search_tokens in step with every write.
 *
 * - ORM writes (creates, updates, upserts, removes, soft deletes, imports,
 *   commands): SearchIndexTracker, driven by the tenant-encryption subscriber.
 *   It snapshots the plaintext in afterCreate/afterUpdate/afterUpsert/afterDelete
 *   (after the subscriber has decrypted the entity) and writes the tokens in
 *   afterFlush, so a rolled-back flush writes nothing.
 * - Raw writes that go through encryptRowForRawWrite: the caller runs
 *   refreshSearchTokensForIds after its UPDATE (a guard test enforces it).
 * - Hard deletes of any kind (nativeDelete, GDPR purge, raw DELETE) and raw
 *   soft deletes: database triggers remove the rows' tokens (see the
 *   migration), so no delete path can leave derived data behind.
 *
 * Token maintenance never fails the user's write: a failure is logged with
 * names only and the consistency check (reindex-customer-search --check)
 * finds and repairs the drift.
 *
 * Relative imports only: reachable from worker bundles.
 */

type DekSource = { getDek(tenantId: string | null | undefined): Promise<TenantDek | null> }

type DecryptService = DekSource & {
  decryptEntityPayloadForDisplay?: (
    entityId: string,
    payload: Record<string, unknown>,
    tenantId: string | null | undefined,
    organizationId?: string | null,
  ) => Promise<{ payload: Record<string, unknown>; undecryptableFields: string[] }>
}

type PendingOp =
  | { kind: 'replace'; source: SearchSource; scope: Partial<SearchTokenScope> & { entityId: string }; values: Record<string, unknown> }
  | { kind: 'delete'; source: SearchSource; entityId: string }

function refId(value: unknown): string | null {
  if (!value) return null
  if (typeof value === 'string') return value
  const v = value as any
  if (typeof v.id === 'string') return v.id
  try {
    const unwrapped = typeof v.unwrap === 'function' ? v.unwrap() : null
    if (unwrapped && typeof unwrapped.id === 'string') return unwrapped.id
  } catch { /* not initialized */ }
  if (typeof v.getEntity === 'function') {
    try { const e = v.getEntity(); if (typeof e?.id === 'string') return e.id } catch { /* ignore */ }
  }
  return null
}

function str(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value)
}

/** Remove fields whose value could not be read, so their existing tokens stay. */
function readableValues(source: SearchSource, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of source.fields) {
    if (!Object.prototype.hasOwnProperty.call(values, f.column)) continue
    if (isUnindexableValue(values[f.column])) continue
    out[f.column] = values[f.column]
  }
  return out
}

export class SearchIndexTracker {
  private pending = new WeakMap<object, PendingOp[]>()

  constructor(private readonly dekSource: DekSource) {}

  private queue(em: any, op: PendingOp): void {
    const uow = em?.getUnitOfWork?.()
    if (!uow) return
    const list = this.pending.get(uow) ?? []
    list.push(op)
    this.pending.set(uow, list)
  }

  /** Called from the subscriber's after-hooks with the (decrypted) entity. */
  track(em: any, entityId: string | null, entity: Record<string, unknown>, change: 'upsert' | 'delete'): void {
    if (!entityId) return
    const source = SEARCH_SOURCES_BY_ENTITY_ID[entityId]
    if (!source || !entity) return
    const key = source.keyProperty === 'id' ? str(entity.id) : refId(entity[source.keyProperty]) ?? str((entity as any).entityId ?? (entity as any).entity_id)
    if (!key) return
    const deleted = entity.deletedAt instanceof Date || (entity.deletedAt !== null && entity.deletedAt !== undefined)
    if (change === 'delete' || (source.keyProperty === 'id' && deleted)) {
      this.queue(em, { kind: 'delete', source, entityId: key })
      return
    }
    const values: Record<string, unknown> = {}
    for (const f of source.fields) {
      const v = entity[f.property]
      if (v === undefined) continue // not loaded: leave its tokens alone
      values[f.column] = v
    }
    const tenantId = str(entity.tenantId ?? (entity as any).tenant_id)
    const organizationId = str(entity.organizationId ?? (entity as any).organization_id)
    const entityType = (source.entityType ?? str(entity.kind)) as SearchEntityType | null
    this.queue(em, {
      kind: 'replace',
      source,
      scope: { entityId: key, tenantId: tenantId ?? undefined, organizationId: organizationId ?? undefined, entityType: entityType ?? undefined },
      values,
    })
  }

  reset(uow: object | undefined | null): void {
    if (uow) this.pending.delete(uow)
  }

  async flush(em: any, uow: object | undefined | null): Promise<void> {
    if (!uow) return
    const ops = this.pending.get(uow)
    this.pending.delete(uow)
    if (!ops?.length) return
    // Inside an outer transaction the writes must join it: a soft delete's
    // trigger already locked these token rows there, and a second connection
    // would wait on them forever. A savepoint keeps a failing statement from
    // aborting the caller's transaction. Outside one (the flush's own
    // transaction has committed by afterFlush), statements autocommit.
    const ctx = em?.getTransactionContext?.()
    const db = searchSqlFromEm(em, ctx)
    try {
      if (!(await searchTokensTableExists(db))) return
    } catch {
      return
    }
    const savepoint = ctx ? 'customer_search_tokens_sync' : null
    if (savepoint) {
      try { await db.query(`savepoint ${savepoint}`, []) } catch { return }
    }
    let failed = false
    const rows: SearchTokenRow[] = []
    for (const op of ops) {
      try {
        if (op.kind === 'delete') {
          const types = op.source.entityType ? [op.source.entityType] : (['person', 'company'] as SearchEntityType[])
          const fields = op.source.keyProperty === 'id' ? undefined : op.source.fields.map((f) => f.column)
          await deleteSearchTokensForEntities(db, [op.entityId], { entityTypes: types, fields })
          continue
        }
        await applyReplace(db, this.dekSource, op.source, op.scope, op.values, rows)
      } catch (err) {
        failed = true
        console.error('[search-index] sync_failed', {
          entityId: op.source.entityId,
          op: op.kind,
          code: (err as { code?: string })?.code ?? (err as Error)?.name ?? 'error',
        })
        if (savepoint) break // the transaction is in error until the savepoint is rolled back
      }
    }
    if (!failed || !savepoint) {
      try {
        await insertSearchTokenRows(db, rows)
      } catch (err) {
        failed = true
        console.error('[search-index] sync_failed', { op: 'insert', code: (err as { code?: string })?.code ?? 'error' })
      }
    }
    if (savepoint) {
      try {
        await db.query(failed ? `rollback to savepoint ${savepoint}` : `release savepoint ${savepoint}`, [])
      } catch { /* nothing more to do */ }
    }
  }
}

async function applyReplace(
  db: SearchSql,
  dekSource: DekSource,
  source: SearchSource,
  partialScope: Partial<SearchTokenScope> & { entityId: string },
  values: Record<string, unknown>,
  pending: SearchTokenRow[],
): Promise<void> {
  let { tenantId, organizationId, entityType } = partialScope
  if (!tenantId || !organizationId || !entityType) {
    // Partially loaded entity: read the scope columns (never a value).
    const rows = await db.query<{ tenant_id: string; organization_id: string; kind?: string }>(
      source.table === 'customer_entities' || source.keyColumn !== 'id'
        ? `select tenant_id, organization_id, kind from customer_entities where id = ?`
        : `select tenant_id, organization_id from ${source.table} where id = ?`,
      [partialScope.entityId],
    )
    const row = rows[0]
    if (!row) return
    tenantId = tenantId ?? String(row.tenant_id)
    organizationId = organizationId ?? String(row.organization_id)
    entityType = entityType ?? ((source.entityType ?? row.kind) as SearchEntityType)
  }
  if (!tenantId || !organizationId || !entityType) return
  const key = await resolveSearchKey(tenantId, dekSource)
  if (!key) {
    console.error('[search-index] no_search_key', { entityId: source.entityId, tenantId })
    return
  }
  const scope: SearchTokenScope = { tenantId, organizationId, entityType, entityId: partialScope.entityId }
  const readable = readableValues(source, values)
  // Drop this entity's old tokens for these fields now; the new ones are
  // inserted with every other entity's in one statement at the end of the flush.
  await replaceSearchTokens(db, scope, Object.keys(readable), [])
  pending.push(...buildSearchTokenRows(key, source, scope, readable))
}

/**
 * Rebuild the tokens of the given rows from the database: read them, decrypt,
 * tokenize, replace. For raw writers (after their UPDATE), merges and the
 * backfill. `ids` are the source table's primary keys.
 */
export async function refreshSearchTokensForIds(
  db: SearchSql,
  service: DecryptService,
  sourceEntityId: string,
  ids: string[],
): Promise<{ refreshed: number; skipped: number }> {
  const source = SEARCH_SOURCES_BY_ENTITY_ID[sourceEntityId]
  if (!source) throw new Error(`[search-index] ${sourceEntityId} is not a search source`)
  const unique = Array.from(new Set(ids.filter(Boolean)))
  if (!unique.length) return { refreshed: 0, skipped: 0 }
  const cols = source.fields.map((f) => `s.${f.column}`).join(', ')
  const joinKind = source.table === 'customer_entities'
    ? 's.kind as kind, s.deleted_at as parent_deleted_at'
    : source.keyColumn === 'id'
      ? `null as kind, s.deleted_at as parent_deleted_at`
      : 'ce.kind as kind, ce.deleted_at as parent_deleted_at'
  const join = source.keyColumn !== 'id' ? ' join customer_entities ce on ce.id = s.entity_id' : ''
  const rows = await db.query<Record<string, unknown>>(
    `select s.id, s.${source.keyColumn} as search_key, s.tenant_id, s.organization_id, ${joinKind}, ${cols}
       from ${source.table} s${join}
      where s.id = any(?::uuid[])`,
    [unique],
  )
  const result = await refreshSearchTokensFromRows(db, service, source, rows)
  // Ids that no longer exist lose their tokens.
  const found = new Set(rows.map((r) => String(r.id)))
  const missing = unique.filter((id) => !found.has(id))
  if (missing.length && source.keyColumn === 'id') {
    await deleteSearchTokensForEntities(db, missing, { entityTypes: source.entityType ? [source.entityType] : undefined })
  }
  return result
}

/**
 * Tokens for rows already read from `source.table`, each carrying search_key,
 * tenant_id, organization_id, kind, parent_deleted_at and the source's field
 * columns (stored values: envelopes or legacy plaintext).
 */
export async function refreshSearchTokensFromRows(
  db: SearchSql,
  service: DecryptService,
  source: SearchSource,
  rows: Array<Record<string, unknown>>,
): Promise<{ refreshed: number; skipped: number }> {
  let refreshed = 0
  let skipped = 0
  for (const row of rows) {
    const entityId = str(row.search_key)
    const tenantId = str(row.tenant_id)
    const organizationId = str(row.organization_id)
    const entityType = (source.entityType ?? str(row.kind)) as SearchEntityType | null
    if (!entityId || !tenantId || !organizationId || !entityType) { skipped++; continue }
    if (row.parent_deleted_at) {
      const fields = source.keyColumn === 'id' ? undefined : source.fields.map((f) => f.column)
      await deleteSearchTokensForEntities(db, [entityId], { entityTypes: [entityType], fields })
      refreshed++
      continue
    }
    const payload: Record<string, unknown> = {}
    for (const f of source.fields) payload[f.column] = row[f.column] ?? null
    let values = payload
    if (typeof service.decryptEntityPayloadForDisplay === 'function') {
      const res = await service.decryptEntityPayloadForDisplay(source.entityId, payload, tenantId, organizationId)
      values = res.payload
    }
    const key = await resolveSearchKey(tenantId, service)
    if (!key) { skipped++; continue }
    const scope: SearchTokenScope = { tenantId, organizationId, entityType, entityId }
    const readable = readableValues(source, values)
    await replaceSearchTokens(db, scope, Object.keys(readable), buildSearchTokenRows(key, source, scope, readable))
    refreshed++
  }
  return { refreshed, skipped }
}

/**
 * For raw writers that just wrote plaintext `values` (column -> value) of a
 * search source through encryptRowForRawWrite: replace those fields' tokens.
 * Best-effort: never throws, logs names only.
 */
export async function syncSearchTokensForValues(
  db: SearchSql,
  sourceEntityId: string,
  scope: SearchTokenScope,
  values: Record<string, unknown>,
  dekSource?: DekSource | null,
): Promise<void> {
  const source = SEARCH_SOURCES_BY_ENTITY_ID[sourceEntityId]
  if (!source) return
  try {
    if (!(await searchTokensTableExists(db))) return
    const key = await resolveSearchKey(scope.tenantId, dekSource ?? undefined)
    if (!key) return
    const readable = readableValues(source, values)
    await replaceSearchTokens(db, scope, Object.keys(readable), buildSearchTokenRows(key, source, scope, readable))
  } catch (err) {
    console.error('[search-index] raw_sync_failed', {
      entityId: sourceEntityId,
      code: (err as { code?: string })?.code ?? (err as Error)?.name ?? 'error',
    })
  }
}
