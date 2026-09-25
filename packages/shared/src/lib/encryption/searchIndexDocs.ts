import { DEFAULT_ENCRYPTION_MAPS } from '@open-mercato/core/modules/entities/lib/encryptionDefaults'
import { isEncryptedEnvelope } from './envelopeFormat'
import type { SearchBackfillDb } from './searchIndexBackfill'

/**
 * Encrypt plaintext copies of encrypted-by-design fields inside query-index
 * documents (entity_indexes.doc). A document indexed while its row was still
 * plaintext (before encryption was on, or a legacy row) kept display_name,
 * primary_email, titles ... in clear even after the backfill encrypted the
 * row. The index writer encrypts documents with the same service
 * (encryptIndexDocForStorage); this does the same for the old ones, and drops
 * the search_text aggregate the migration also purges.
 *
 * Counts only in a dry run; never prints a value. Relative / package imports
 * only (no `@/`): bundled into scripts/reindex-customer-search.ts.
 */

type EncryptService = {
  encryptEntityPayload(
    entityId: string,
    payload: Record<string, unknown>,
    tenantId: string | null | undefined,
    organizationId?: string | null,
  ): Promise<Record<string, unknown>>
}

const PROFILE_TYPES = new Set(['customers:customer_person_profile', 'customers:customer_company_profile'])
const CONTACT_ENTITY = 'customers:customer_entity'

function mappedFields(entityId: string): string[] {
  return DEFAULT_ENCRYPTION_MAPS.find((m) => m.entityId === entityId)?.fields.map((f) => f.field) ?? []
}

export type IndexDocReport = {
  docs: number
  docsWithPlaintext: number
  plaintextFields: number
  docsWithSearchText: number
  docsNoTenant: number
  docsWritten: number
  fieldsStillPlaintext: number
  lastId: string | null
}

function plaintextKeys(doc: Record<string, unknown>, fields: string[]): string[] {
  return fields.filter((f) => typeof doc[f] === 'string' && (doc[f] as string).length > 0 && !isEncryptedEnvelope(doc[f]))
}

export async function runIndexDocEncryption(
  db: SearchBackfillDb,
  service: EncryptService,
  opts: { dryRun: boolean; batchSize?: number; tenantId?: string | null; organizationId?: string | null; afterId?: string | null; log?: (l: string) => void },
): Promise<IndexDocReport> {
  const report: IndexDocReport = {
    docs: 0, docsWithPlaintext: 0, plaintextFields: 0, docsWithSearchText: 0,
    docsNoTenant: 0, docsWritten: 0, fieldsStillPlaintext: 0, lastId: null,
  }
  const exists = await db.query<{ t: string | null }>(`select to_regclass('entity_indexes')::text as t`, [])
  if (!exists[0]?.t) return report
  const types = DEFAULT_ENCRYPTION_MAPS.map((m) => m.entityId)
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 200, 5000))
  let after: string | null = opts.afterId ?? null
  for (;;) {
    const params: unknown[] = [types, after, after]
    let where = `entity_type = any(?::text[]) and (?::uuid is null or id > ?::uuid)`
    if (opts.tenantId) { where += ' and tenant_id = ?'; params.push(opts.tenantId) }
    if (opts.organizationId) { where += ' and organization_id = ?'; params.push(opts.organizationId) }
    params.push(batchSize)
    const rows = await db.query<{ id: string; entity_type: string; tenant_id: string | null; organization_id: string | null; doc: unknown }>(
      `select id, entity_type, tenant_id, organization_id, doc from entity_indexes where ${where} order by id limit ?`,
      params,
    )
    if (!rows.length) break
    const updates: Array<{ id: string; doc: Record<string, unknown> }> = []
    for (const row of rows) {
      report.docs++
      const doc = (typeof row.doc === 'string' ? JSON.parse(row.doc) : row.doc) as Record<string, unknown> | null
      if (!doc || typeof doc !== 'object') continue
      const own = mappedFields(row.entity_type)
      const parent = PROFILE_TYPES.has(row.entity_type) ? mappedFields(CONTACT_ENTITY) : []
      const ownPlain = plaintextKeys(doc, own)
      const parentPlain = plaintextKeys(doc, parent.filter((f) => !own.includes(f)))
      const hasSearchText = Object.prototype.hasOwnProperty.call(doc, 'search_text')
      if (hasSearchText) report.docsWithSearchText++
      if (!ownPlain.length && !parentPlain.length && !hasSearchText) continue
      if (ownPlain.length || parentPlain.length) {
        report.docsWithPlaintext++
        report.plaintextFields += ownPlain.length + parentPlain.length
      }
      if (opts.dryRun) continue
      let next: Record<string, unknown> = { ...doc }
      delete next.search_text
      if (ownPlain.length || parentPlain.length) {
        if (!row.tenant_id) { report.docsNoTenant++; continue }
        const pick = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, next[k]]))
        if (ownPlain.length) next = { ...next, ...(await service.encryptEntityPayload(row.entity_type, pick(ownPlain), row.tenant_id, row.organization_id)) }
        if (parentPlain.length) next = { ...next, ...(await service.encryptEntityPayload(CONTACT_ENTITY, pick(parentPlain), row.tenant_id, row.organization_id)) }
        report.fieldsStillPlaintext += plaintextKeys(next, [...ownPlain, ...parentPlain]).length
      }
      updates.push({ id: row.id, doc: next })
    }
    if (updates.length) {
      await db.transaction(async (tx) => {
        for (const u of updates) {
          await tx.query(`update entity_indexes set doc = ?::jsonb, updated_at = now() where id = ?`, [JSON.stringify(u.doc), u.id])
        }
      })
      report.docsWritten += updates.length
    }
    after = String(rows[rows.length - 1]!.id)
    report.lastId = after
    opts.log?.(`[index-docs] batch up to ${after}: docs=${rows.length} rewritten=${updates.length}`)
    if (rows.length < batchSize) break
  }
  return report
}

export function formatIndexDocReport(r: IndexDocReport, dryRun: boolean): string {
  return `[index-docs] docs=${r.docs} with_plaintext=${r.docsWithPlaintext} plaintext_fields=${r.plaintextFields}`
    + ` with_search_text=${r.docsWithSearchText}`
    + (dryRun ? '' : ` rewritten=${r.docsWritten} no_tenant=${r.docsNoTenant} still_plaintext_fields=${r.fieldsStillPlaintext}`)
    + (r.lastId ? ` last_id=${r.lastId}` : '')
}
