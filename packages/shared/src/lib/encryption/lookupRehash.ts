/**
 * Rewrite contact lookup hashes (customer_entities.primary_email_hash,
 * primary_phone_hash) to the per-tenant keyed format (lookupKey.ts,
 * 2026-09-25 review M10).
 *
 * For every row it opens the stored email / phone (decrypting envelopes with
 * the row's own tenant and organisation), computes the hash a writer would
 * store now, and rewrites the column when it differs: legacy unkeyed hashes,
 * missing hashes on rows that have a value, and keyed hashes left stale by a
 * tenant split (a new tenant key). Idempotent: a second run changes nothing.
 *
 * Rules:
 * - Never prints a value. Counts per tenant, and row ids of duplicates.
 * - A dry run writes nothing. A real run is one transaction per batch; every
 *   update is compare-and-set on the old hash, so a row the app changed in
 *   between is left alone (and counted).
 * - A tenant with no key (encryption on, no data key) is refused, never
 *   rehashed with the legacy function.
 * - Unique email hashes: when another live contact of the organisation already
 *   holds the keyed hash (a duplicate created during the rollout), this row
 *   keeps its current hash (dual read still finds it) and is reported for the
 *   owner to merge. Nothing is nulled.
 *
 * Relative imports only: bundled into a standalone script.
 */
import { isEncryptedEnvelope } from './aes'
import { contactLookupHasher, type ContactLookupHasher } from './lookupKey'
import type { BackfillDb, BackfillQuery, BackfillRow } from './plaintextBackfill'
import type { TenantDek } from './kms'

const UNDECRYPTABLE_PLACEHOLDER = 'This record could not be decrypted. Contact support.'

export type RehashDecrypt = (
  tenantId: string,
  organizationId: string,
  stored: { primary_email: unknown; primary_phone: unknown },
) => Promise<{ primary_email: unknown; primary_phone: unknown }>

export type RehashDeps = {
  decrypt: RehashDecrypt
  /** DEK source for the keyed hash (the TenantDataEncryptionService). */
  keys: { getDek(tenantId: string | null | undefined): Promise<TenantDek | null> }
}

export type RehashTenantCounts = {
  scanned: number
  emailRehashed: number
  phoneRehashed: number
  alreadyKeyed: number
  unreadable: number
  duplicates: number
  changedUnderLock: number
}

export type RehashReport = {
  dryRun: boolean
  tenants: Map<string, RehashTenantCounts>
  refusedTenants: string[]
  duplicateIds: string[]
}

export type RehashOptions = {
  dryRun: boolean
  tenantId?: string | null
  batchSize?: number
  log?: (line: string) => void
}

const emptyCounts = (): RehashTenantCounts => ({
  scanned: 0, emailRehashed: 0, phoneRehashed: 0, alreadyKeyed: 0, unreadable: 0, duplicates: 0, changedUnderLock: 0,
})

const normalizeEmail = (v: string) => v.trim().toLowerCase()
const normalizePhone = (v: string) => v.replace(/\D/g, '')

function readable(value: unknown): string | null | 'unreadable' {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') return 'unreadable'
  if (value === UNDECRYPTABLE_PLACEHOLDER || isEncryptedEnvelope(value)) return 'unreadable'
  return value
}

type Planned = {
  id: string
  email?: { from: string | null; to: string | null }
  phone?: { from: string | null; to: string | null }
}

export async function runLookupRehash(db: BackfillDb, deps: RehashDeps, options: RehashOptions): Promise<RehashReport> {
  const log = options.log ?? (() => {})
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 200, 5000))
  const report: RehashReport = { dryRun: options.dryRun, tenants: new Map(), refusedTenants: [], duplicateIds: [] }

  const tenantRows = options.tenantId
    ? [{ tenant_id: options.tenantId }]
    : (await db.query<{ tenant_id: string }>(
        `select distinct tenant_id from customer_entities where tenant_id is not null order by tenant_id`,
      )).rows

  for (const { tenant_id } of tenantRows) {
    const tenantId = String(tenant_id)
    const hasher: ContactLookupHasher = await contactLookupHasher(tenantId, deps.keys)
    if (!hasher.keyed) {
      report.refusedTenants.push(tenantId)
      log(`[refused] tenant=${tenantId} has no data key; its hashes were left as they are`)
      continue
    }
    const counts = emptyCounts()
    report.tenants.set(tenantId, counts)

    const plan = async (q: BackfillQuery, rows: BackfillRow[]): Promise<Planned[]> => {
      const out: Planned[] = []
      for (const row of rows) {
        counts.scanned += 1
        const id = String(row.id)
        const organizationId = row.organization_id ? String(row.organization_id) : ''
        if (!organizationId) continue
        let opened: { primary_email: unknown; primary_phone: unknown }
        try {
          opened = await deps.decrypt(tenantId, organizationId, { primary_email: row.primary_email, primary_phone: row.primary_phone })
        } catch {
          counts.unreadable += 1
          continue
        }
        const email = readable(opened.primary_email)
        const phone = readable(opened.primary_phone)
        if (email === 'unreadable' || phone === 'unreadable') {
          counts.unreadable += 1
          continue
        }
        const planned: Planned = { id }
        const storedEmailHash = (row.primary_email_hash as string | null) ?? null
        const wantEmail = email ? hasher.write(normalizeEmail(email)) : null
        if (email && wantEmail && storedEmailHash !== wantEmail) {
          if (row.deleted_at == null) {
            const { rows: holders } = await q.query(
              `select id from customer_entities where organization_id = $1 and primary_email_hash = $2 and deleted_at is null and id <> $3 limit 1`,
              [organizationId, wantEmail, id],
            )
            if (holders.length) {
              counts.duplicates += 1
              report.duplicateIds.push(id)
            } else {
              planned.email = { from: storedEmailHash, to: wantEmail }
            }
          } else {
            planned.email = { from: storedEmailHash, to: wantEmail }
          }
        }
        const storedPhoneHash = (row.primary_phone_hash as string | null) ?? null
        const wantPhone = phone ? hasher.write(normalizePhone(phone)) : null
        if (phone && wantPhone && storedPhoneHash !== wantPhone) planned.phone = { from: storedPhoneHash, to: wantPhone }
        if (planned.email || planned.phone) out.push(planned)
        else if ((email || phone) && !planned.email && !planned.phone && !report.duplicateIds.includes(id)) counts.alreadyKeyed += 1
      }
      return out
    }

    const fetch = async (q: BackfillQuery, afterId: string | null, lock: boolean): Promise<BackfillRow[]> => {
      const params: unknown[] = [tenantId]
      let where = 'tenant_id = $1 and (primary_email is not null or primary_phone is not null)'
      if (afterId) { params.push(afterId); where += ` and id > $${params.length}` }
      params.push(batchSize)
      const { rows } = await q.query(
        `select id, organization_id, primary_email, primary_phone, primary_email_hash, primary_phone_hash, deleted_at
           from customer_entities where ${where} order by id limit $${params.length}${lock ? ' for update' : ''}`,
        params,
      )
      return rows
    }

    let afterId: string | null = null
    for (;;) {
      if (options.dryRun) {
        const rows = await fetch(db, afterId, false)
        if (!rows.length) break
        const planned = await plan(db, rows)
        for (const p of planned) {
          if (p.email) counts.emailRehashed += 1
          if (p.phone) counts.phoneRehashed += 1
        }
        afterId = String(rows[rows.length - 1]!.id)
        continue
      }
      const outcome = await db.transaction(async (tx) => {
        await tx.query(`set local lock_timeout = '5000ms'`)
        const rows = await fetch(tx, afterId, true)
        if (!rows.length) return null
        const planned = await plan(tx, rows)
        for (const p of planned) {
          const sets: string[] = []
          const guards: string[] = []
          const params: unknown[] = []
          if (p.email) {
            params.push(p.email.to); sets.push(`primary_email_hash = $${params.length}`)
            params.push(p.email.from); guards.push(`primary_email_hash is not distinct from $${params.length}`)
          }
          if (p.phone) {
            params.push(p.phone.to); sets.push(`primary_phone_hash = $${params.length}`)
            params.push(p.phone.from); guards.push(`primary_phone_hash is not distinct from $${params.length}`)
          }
          params.push(p.id)
          const result = await tx.query(
            `update customer_entities set ${sets.join(', ')} where id = $${params.length} and ${guards.join(' and ')}`,
            params,
          )
          if (result.rowCount !== 1) { counts.changedUnderLock += 1; continue }
          if (p.email) counts.emailRehashed += 1
          if (p.phone) counts.phoneRehashed += 1
        }
        return rows
      })
      if (!outcome) break
      afterId = String(outcome[outcome.length - 1]!.id)
      log(`[committed] tenant=${tenantId} last_id=${afterId}`)
    }
  }
  return report
}

export function formatRehashReport(report: RehashReport): string[] {
  const tag = report.dryRun ? '[dry-run] ' : ''
  const lines = [`${tag}tenant | scanned | email_${report.dryRun ? 'would_rehash' : 'rehashed'} | phone_${report.dryRun ? 'would_rehash' : 'rehashed'} | already_keyed | unreadable | duplicates | changed_under_lock`]
  for (const [tenantId, c] of report.tenants) {
    lines.push(`${tag}${tenantId} | ${c.scanned} | ${c.emailRehashed} | ${c.phoneRehashed} | ${c.alreadyKeyed} | ${c.unreadable} | ${c.duplicates} | ${c.changedUnderLock}`)
  }
  if (report.refusedTenants.length) lines.push(`${tag}tenants with no data key (left as they are): ${report.refusedTenants.join(',')}`)
  if (report.duplicateIds.length) lines.push(`${tag}contacts sharing an email with another live contact (kept their hash; merge them): ${report.duplicateIds.join(',')}`)
  return lines
}

/** True when a post-run dry run shows nothing left to rewrite (duplicates excepted). */
export function rehashComplete(report: RehashReport): boolean {
  for (const c of report.tenants.values()) if (c.emailRehashed || c.phoneRehashed) return false
  return report.refusedTenants.length === 0
}
