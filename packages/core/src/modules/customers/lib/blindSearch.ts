import { resolveSearchKey } from '@open-mercato/shared/lib/encryption/searchKey'
import {
  searchBlindIndex,
  searchSqlFromKnex,
  type BlindSearchHit,
  type SearchEntityType,
} from '@open-mercato/shared/lib/encryption/searchIndex'

/**
 * Server-side search over encrypted contact / company / deal fields, through
 * the blind index (customer_search_tokens). The only supported way to match a
 * name, email, phone, job title, company name/domain or deal title: SQL LIKE
 * on those columns compares ciphertext and never matches (a guard test fails
 * the build on it).
 *
 * Callers pass the ids on to their normal query (CRUD `id $in`, a knex
 * whereIn) and decrypt only the page they return.
 *
 * Package imports only (no `@/`): reachable from worker bundles.
 */

/** Most ids one search hands to an `id IN (...)` filter; totals above this are capped. */
export const BLIND_SEARCH_ID_CAP = 5000
/** A uuid no row has: `id = NO_MATCH_ID` matches nothing. */
export const NO_MATCH_ID = '00000000-0000-0000-0000-000000000000'

type KnexLike = { raw: (sql: string, bindings: any) => any }

function knexFrom(source: unknown): KnexLike | null {
  const s = source as any
  if (!s) return null
  if (typeof s.raw === 'function') return s as KnexLike
  if (typeof s.getKnex === 'function') return s.getKnex() as KnexLike
  return null
}

export type BlindSearchIdsOptions = {
  tenantId: string | null | undefined
  organizationIds: Array<string | null | undefined>
  entityTypes: readonly SearchEntityType[]
  query: string
  fields?: string[]
  cap?: number
  offset?: number
}

export type BlindSearchIdsResult = { ids: string[]; hits: BlindSearchHit[]; total: number; truncated: boolean }

/** Ranked matching ids (best first). Empty when nothing matches or no key/org is available. */
export async function blindSearchIds(source: unknown, opts: BlindSearchIdsOptions): Promise<BlindSearchIdsResult> {
  const empty: BlindSearchIdsResult = { ids: [], hits: [], total: 0, truncated: false }
  const knex = knexFrom(source)
  const organizationIds = Array.from(new Set(opts.organizationIds.filter((v): v is string => typeof v === 'string' && v.length > 0)))
  if (!knex || !opts.tenantId || !organizationIds.length || !opts.query?.trim()) return empty
  const key = await resolveSearchKey(opts.tenantId)
  if (!key) {
    console.error('[customers.search] no_search_key', { tenantId: opts.tenantId })
    return empty
  }
  const cap = Math.max(1, Math.min(opts.cap ?? BLIND_SEARCH_ID_CAP, BLIND_SEARCH_ID_CAP))
  const res = await searchBlindIndex(searchSqlFromKnex(knex), key, {
    tenantId: opts.tenantId,
    organizationIds,
    entityTypes: opts.entityTypes,
    fields: opts.fields,
    query: opts.query,
    limit: cap,
    offset: opts.offset ?? 0,
  })
  return { ids: res.hits.map((h) => h.entityId), hits: res.hits, total: res.total, truncated: res.total > cap + (opts.offset ?? 0) }
}

/** The organizations a CRUD list is scoped to (never empty-means-all: empty matches nothing). */
export function crudSearchOrganizationIds(ctx: any): string[] {
  const ids: string[] = []
  if (Array.isArray(ctx?.organizationIds) && ctx.organizationIds.length) ids.push(...ctx.organizationIds)
  else if (ctx?.selectedOrganizationId) ids.push(ctx.selectedOrganizationId)
  else if (ctx?.auth?.orgId) ids.push(ctx.auth.orgId)
  return ids.filter((v) => typeof v === 'string' && v.length > 0)
}

/**
 * Narrow a CRUD filter object to `ids`, intersecting with an id filter that is
 * already there ($eq / $in) instead of overwriting it.
 */
export function restrictFiltersToIds(filters: Record<string, any>, ids: string[]): void {
  let allowed = ids
  const current = filters.id
  if (current && typeof current === 'object') {
    const existing: string[] | null = Array.isArray(current.$in)
      ? current.$in.map(String)
      : current.$eq !== undefined ? [String(current.$eq)] : null
    if (existing) {
      const set = new Set(existing)
      allowed = ids.filter((id) => set.has(id))
    }
  }
  filters.id = allowed.length ? { $in: allowed } : { $eq: NO_MATCH_ID }
}

/**
 * The contact list filters that look at encrypted columns, for the people and
 * companies CRUD routes:
 *   search            name, email, phone, job title, company name/domain
 *   email             exact address
 *   emailStartsWith   token prefix of the address (local-part words, domain)
 *   emailContains     same as emailStartsWith: a blind index matches whole
 *                     tokens and their edge prefixes, not arbitrary substrings
 * Each narrows `filters.id` (intersected across filters). Returns true when a
 * filter was applied.
 */
export async function applyContactSearchFilters(
  filters: Record<string, any>,
  query: { search?: unknown; email?: unknown; emailStartsWith?: unknown; emailContains?: unknown },
  ctx: any,
  kind: 'person' | 'company',
): Promise<boolean> {
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const lookups: Array<{ query: string; fields?: string[] }> = []
  if (text(query.search)) lookups.push({ query: text(query.search) })
  const email = text(query.email) || text(query.emailStartsWith) || text(query.emailContains)
  if (email) lookups.push({ query: email, fields: ['primary_email'] })
  if (!lookups.length) return false
  const em = ctx?.container?.resolve?.('em')
  const tenantId = ctx?.auth?.tenantId ?? null
  const organizationIds = crudSearchOrganizationIds(ctx)
  for (const lookup of lookups) {
    let ids: string[] = []
    try {
      ids = (await blindSearchIds(em, { tenantId, organizationIds, entityTypes: [kind], query: lookup.query, fields: lookup.fields })).ids
    } catch (err) {
      console.error('[customers.search] blind_search_failed', { code: (err as { code?: string })?.code ?? 'error' })
      ids = []
    }
    restrictFiltersToIds(filters, ids)
  }
  return true
}
