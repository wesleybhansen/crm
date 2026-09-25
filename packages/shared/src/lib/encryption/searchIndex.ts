import {
  compileSearchQuery,
  hashSearchTerms,
  hashSearchToken,
  tokensForField,
  type SearchFieldKind,
} from './searchTokens'
import { isEncryptedEnvelope } from './envelopeFormat'

/**
 * The blind search index for contacts, companies and deals:
 * customer_search_tokens (tenant_id, organization_id, entity_type, entity_id,
 * field, token_hash). How tokens are made and what the table leaks is
 * documented in searchTokens.ts.
 *
 * entity_type is the searchable thing a user gets back: 'person' / 'company'
 * (a customer_entities row, keyed by its id) or 'deal' (a customer_deals row).
 * Person and company profile fields (first/last name, job title, legal name,
 * domain ...) are indexed under their parent customer_entities id, so a
 * contact search matches them too.
 *
 * Every query here takes the tenant and a non-empty organization list and
 * applies both in SQL. Statements use `?` placeholders (knex / MikroORM
 * execute); the standalone script converts them for node-postgres.
 *
 * Relative imports only: reachable from worker bundles and the backfill script.
 */

export const SEARCH_TOKENS_TABLE = 'customer_search_tokens'

export type SearchEntityType = 'person' | 'company' | 'deal'
export const SEARCH_ENTITY_TYPES: readonly SearchEntityType[] = ['person', 'company', 'deal']
export const CONTACT_ENTITY_TYPES: readonly SearchEntityType[] = ['person', 'company']

export type SearchSourceField = {
  /** Database column. Also the `field` label stored with each token. */
  column: string
  /** ORM property name. */
  property: string
  kind: SearchFieldKind
}

export type SearchSource = {
  /** Encryption-map entity id ('customers:customer_entity' ...). */
  entityId: string
  table: string
  /** Column holding the id tokens are keyed by (the parent contact for profiles). */
  keyColumn: string
  /** ORM property for keyColumn (a relation for profiles). */
  keyProperty: string
  /** Fixed entity type, or null when it comes from the row's `kind`. */
  entityType: SearchEntityType | null
  fields: SearchSourceField[]
}

export const SEARCH_SOURCES: readonly SearchSource[] = [
  {
    entityId: 'customers:customer_entity',
    table: 'customer_entities',
    keyColumn: 'id',
    keyProperty: 'id',
    entityType: null,
    fields: [
      { column: 'display_name', property: 'displayName', kind: 'text' },
      { column: 'primary_email', property: 'primaryEmail', kind: 'email' },
      { column: 'primary_phone', property: 'primaryPhone', kind: 'phone' },
    ],
  },
  {
    entityId: 'customers:customer_person_profile',
    table: 'customer_people',
    keyColumn: 'entity_id',
    keyProperty: 'entity',
    entityType: 'person',
    fields: [
      { column: 'first_name', property: 'firstName', kind: 'text' },
      { column: 'last_name', property: 'lastName', kind: 'text' },
      { column: 'preferred_name', property: 'preferredName', kind: 'text' },
      { column: 'job_title', property: 'jobTitle', kind: 'text' },
    ],
  },
  {
    entityId: 'customers:customer_company_profile',
    table: 'customer_companies',
    keyColumn: 'entity_id',
    keyProperty: 'entity',
    entityType: 'company',
    fields: [
      { column: 'legal_name', property: 'legalName', kind: 'text' },
      { column: 'brand_name', property: 'brandName', kind: 'text' },
      { column: 'domain', property: 'domain', kind: 'domain' },
      { column: 'website_url', property: 'websiteUrl', kind: 'domain' },
    ],
  },
  {
    entityId: 'customers:customer_deal',
    table: 'customer_deals',
    keyColumn: 'id',
    keyProperty: 'id',
    entityType: 'deal',
    fields: [{ column: 'title', property: 'title', kind: 'text' }],
  },
]

export const SEARCH_SOURCES_BY_ENTITY_ID: Record<string, SearchSource> = Object.fromEntries(
  SEARCH_SOURCES.map((s) => [s.entityId, s]),
)
export const SEARCH_SOURCES_BY_TABLE: Record<string, SearchSource> = Object.fromEntries(
  SEARCH_SOURCES.map((s) => [s.table, s]),
)

/** Runs one statement with `?` placeholders and returns its rows. */
export interface SearchSql {
  query<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]>
}

/** Adapter for a knex instance or transaction. */
export function searchSqlFromKnex(knex: { raw: (sql: string, bindings: any) => any }): SearchSql {
  return {
    async query<T>(sql: string, params: unknown[]): Promise<T[]> {
      const res = await knex.raw(sql, params as any)
      return ((res?.rows ?? res ?? []) as T[])
    },
  }
}

/**
 * Adapter for a MikroORM EntityManager, optionally inside its transaction
 * context. Goes through the connection's knex (not `connection.execute`, which
 * inlines parameters and turns an array into a list, breaking `= any(?)`).
 */
export function searchSqlFromEm(em: any, ctx?: unknown): SearchSql {
  return {
    async query<T>(sql: string, params: unknown[]): Promise<T[]> {
      const conn = em?.getConnection?.()
      const knex = conn?.getKnex?.()
      if (knex && typeof knex.raw === 'function') {
        const q = knex.raw(sql, params as any)
        if (ctx) q.transacting(ctx)
        const res = await q
        return ((res?.rows ?? res ?? []) as T[])
      }
      // Test doubles expose only execute().
      if (!conn || typeof conn.execute !== 'function') throw new Error('[search-index] no connection')
      const rows = await conn.execute(sql, params, 'all', ctx)
      return (Array.isArray(rows) ? rows : []) as T[]
    },
  }
}

/** Adapter for a node-postgres style `query(sql, params)` ($1..$n placeholders). */
export function searchSqlFromPg(
  run: (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>,
): SearchSql {
  return {
    async query<T>(sql: string, params: unknown[]): Promise<T[]> {
      let n = 0
      const text = sql.replace(/\?/g, () => `$${++n}`)
      const res = await run(text, params)
      return (res?.rows ?? []) as T[]
    },
  }
}

let tableSeenAt = 0
let tableMissingAt = 0
const TABLE_RECHECK_MS = 60_000

/**
 * Whether customer_search_tokens exists yet (the code can be deployed before
 * the migration is applied). Cached: true for the process lifetime, false for
 * a minute. Writers skip silently while it is missing.
 */
export async function searchTokensTableExists(db: SearchSql): Promise<boolean> {
  if (tableSeenAt) return true
  if (tableMissingAt && Date.now() - tableMissingAt < TABLE_RECHECK_MS) return false
  try {
    const rows = await db.query<{ t: string | null }>(`select to_regclass('${SEARCH_TOKENS_TABLE}')::text as t`, [])
    if (rows[0]?.t) { tableSeenAt = Date.now(); return true }
  } catch {
    // fall through: treat as missing
  }
  tableMissingAt = Date.now()
  return false
}

/** Test seam. */
export function resetSearchTokensTableCacheForTests(): void {
  tableSeenAt = 0
  tableMissingAt = 0
}

export type SearchTokenScope = {
  tenantId: string
  organizationId: string
  entityType: SearchEntityType
  entityId: string
}

export type SearchTokenRow = SearchTokenScope & { field: string; tokenHash: string }

/** True when a value must not be tokenized: an envelope that did not open, or the display placeholder. */
export function isUnindexableValue(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return isEncryptedEnvelope(value) || value === 'This record could not be decrypted. Contact support.'
}

/**
 * Hash the tokens of the given plaintext values. `values` is keyed by column;
 * only columns present in `values` are produced (others are left alone by
 * replaceSearchTokens). An unreadable value yields no tokens.
 */
export function buildSearchTokenRows(
  key: Buffer,
  source: SearchSource,
  scope: SearchTokenScope,
  values: Record<string, unknown>,
): SearchTokenRow[] {
  const rows: SearchTokenRow[] = []
  for (const field of source.fields) {
    if (!Object.prototype.hasOwnProperty.call(values, field.column)) continue
    const value = values[field.column]
    if (isUnindexableValue(value)) continue
    for (const token of tokensForField(field.kind, value)) {
      rows.push({ ...scope, field: field.column, tokenHash: hashSearchToken(key, token) })
    }
  }
  return rows
}

/**
 * Replace the tokens of `fields` for one searchable entity with `rows`.
 * Idempotent (delete then insert on conflict do nothing). Rows whose value
 * could not be read must not be passed as a field to replace (see
 * refreshFieldsFor), or the existing tokens would be dropped.
 */
export async function replaceSearchTokens(
  db: SearchSql,
  scope: SearchTokenScope,
  fields: string[],
  rows: SearchTokenRow[],
): Promise<void> {
  if (fields.length) {
    await db.query(
      `delete from ${SEARCH_TOKENS_TABLE} where entity_id = ? and entity_type = ? and tenant_id = ? and field = any(?::text[])`,
      [scope.entityId, scope.entityType, scope.tenantId, fields],
    )
  }
  await insertSearchTokenRows(db, rows)
}

export async function insertSearchTokenRows(db: SearchSql, rows: SearchTokenRow[]): Promise<void> {
  if (!rows.length) return
  const CHUNK = 5000
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    await db.query(
      `insert into ${SEARCH_TOKENS_TABLE} (tenant_id, organization_id, entity_type, entity_id, field, token_hash)
       select * from unnest(?::uuid[], ?::uuid[], ?::text[], ?::uuid[], ?::text[], ?::text[])
       on conflict (entity_id, entity_type, field, token_hash) do nothing`,
      [
        chunk.map((r) => r.tenantId),
        chunk.map((r) => r.organizationId),
        chunk.map((r) => r.entityType),
        chunk.map((r) => r.entityId),
        chunk.map((r) => r.field),
        chunk.map((r) => r.tokenHash),
      ],
    )
  }
}

/** Remove every token of the given entities (a contact or deal deleted, merged away or purged). */
export async function deleteSearchTokensForEntities(
  db: SearchSql,
  entityIds: string[],
  opts: { entityTypes?: readonly SearchEntityType[]; fields?: string[] } = {},
): Promise<void> {
  const ids = Array.from(new Set(entityIds.filter(Boolean)))
  if (!ids.length) return
  const params: unknown[] = [ids]
  let sql = `delete from ${SEARCH_TOKENS_TABLE} where entity_id = any(?::uuid[])`
  if (opts.entityTypes?.length) { sql += ' and entity_type = any(?::text[])'; params.push([...opts.entityTypes]) }
  if (opts.fields?.length) { sql += ' and field = any(?::text[])'; params.push(opts.fields) }
  await db.query(sql, params)
}

export type BlindSearchOptions = {
  tenantId: string
  /** Always applied in SQL. An empty list matches nothing. */
  organizationIds: string[]
  entityTypes?: readonly SearchEntityType[]
  /** Restrict matching to these stored fields (e.g. ['primary_email']). */
  fields?: string[]
  query: string
  limit?: number
  offset?: number
  /** Drop hits whose row is deleted (default true). */
  liveOnly?: boolean
}

export type BlindSearchHit = { entityId: string; entityType: SearchEntityType; rank: number }
export type BlindSearchResult = { hits: BlindSearchHit[]; total: number; terms: number }

/**
 * Org-scoped search: every query term must match (AND); hits are ranked by how
 * many distinct fields matched, then by id for a stable order; paginated.
 */
export async function searchBlindIndex(db: SearchSql, key: Buffer, opts: BlindSearchOptions): Promise<BlindSearchResult> {
  const orgIds = Array.from(new Set((opts.organizationIds ?? []).filter(Boolean)))
  const terms = compileSearchQuery(opts.query)
  if (!opts.tenantId || !orgIds.length || !terms.length) return { hits: [], total: 0, terms: terms.length }
  const hashed = hashSearchTerms(key, terms)
  const all = Array.from(new Set(hashed.flat()))
  const entityTypes = [...(opts.entityTypes?.length ? opts.entityTypes : SEARCH_ENTITY_TYPES)]
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 10000))
  const offset = Math.max(0, opts.offset ?? 0)

  const params: unknown[] = [opts.tenantId, orgIds, entityTypes, all]
  let fieldFilter = ''
  if (opts.fields?.length) { fieldFilter = ' and t.field = any(?::text[])'; params.push(opts.fields) }
  const having = hashed.map(() => 'bool_or(t.token_hash = any(?::text[]))').join(' and ')
  params.push(...hashed)
  const live = opts.liveOnly === false
    ? ''
    : `where (m.entity_type = 'deal' and exists (select 1 from customer_deals d where d.id = m.entity_id and d.deleted_at is null))
          or (m.entity_type <> 'deal' and exists (select 1 from customer_entities ce where ce.id = m.entity_id and ce.deleted_at is null))`
  params.push(limit, offset)
  const rows = await db.query<{ entity_id: string; entity_type: SearchEntityType; rank: number | string; total: number | string }>(
    `select m.entity_id, m.entity_type, m.rank, count(*) over () as total
       from (
         select t.entity_id, t.entity_type, count(distinct t.field) as rank
           from ${SEARCH_TOKENS_TABLE} t
          where t.tenant_id = ?
            and t.organization_id = any(?::uuid[])
            and t.entity_type = any(?::text[])
            and t.token_hash = any(?::text[])${fieldFilter}
          group by t.entity_id, t.entity_type
         having ${having}
       ) m
       ${live}
      order by m.rank desc, m.entity_id
      limit ? offset ?`,
    params,
  )
  let total = rows.length ? Number(rows[0]!.total) : 0
  if (!rows.length && offset > 0) {
    // Past the last page: the window count is gone with the rows, count again.
    const again = await searchBlindIndex(db, key, { ...opts, limit: 1, offset: 0 })
    total = again.total
  }
  return {
    hits: rows.map((r) => ({ entityId: String(r.entity_id), entityType: r.entity_type, rank: Number(r.rank) })),
    total,
    terms: terms.length,
  }
}
