import type { Knex } from 'knex'
import { contactLookupHasher, type ContactLookupHasher } from '@open-mercato/shared/lib/encryption/lookupKey'

/**
 * Value lookups on contact email / phone.
 *
 * primary_email and primary_phone are encrypted at rest with a random IV, so
 * `where('primary_email', email)` can never match an encrypted row. The
 * identity is the lookup hash (HMAC of the normalized plaintext under a
 * per-tenant key, written by the encryption subscriber, encryptRowForRawWrite
 * and the backfills; the legacy unkeyed sha256 is still matched while the
 * rehash rollout runs, see lookupKey.ts). The plaintext comparison stays as a second arm only for legacy
 * rows that were written before the hash existed and have not been backfilled.
 *
 * Package imports only (no `@/`): reachable from worker bundles.
 */

export function normalizeEmailForLookup(email: string | null | undefined): string {
  return String(email ?? '').trim().toLowerCase()
}

export function normalizePhoneForLookup(phone: string | null | undefined): string {
  return String(phone ?? '').replace(/\D/g, '')
}

/**
 * The per-tenant hasher for one organisation's contacts (lookup hashes are
 * keyed per tenant, see packages/shared/src/lib/encryption/lookupKey.ts).
 */
export async function contactLookupForTenant(tenantId: string): Promise<ContactLookupHasher> {
  return contactLookupHasher(tenantId)
}

/** Same, when only the organisation id is at hand. */
export async function contactLookupForOrganization(knex: Knex, organizationId: string): Promise<ContactLookupHasher> {
  const row = await knex('organizations').where('id', organizationId).first('tenant_id')
  const tenantId = row?.tenant_id ? String(row.tenant_id) : ''
  if (!tenantId) throw new Error(`[contact-lookup] organization ${organizationId} has no tenant`)
  return contactLookupHasher(tenantId)
}

/** Every stored hash an email may carry in this tenant (keyed, then legacy). */
export function emailLookupHashes(hasher: ContactLookupHasher, email: string | null | undefined): string[] {
  return hasher.candidates(normalizeEmailForLookup(email))
}

export function phoneLookupHashes(hasher: ContactLookupHasher, phone: string | null | undefined): string[] {
  return hasher.candidates(normalizePhoneForLookup(phone))
}

/**
 * Restrict a customer_entities query to rows whose primary_email is `email`.
 * The query must already be (or will be) scoped to the hasher's tenant: the
 * keyed hash only means something inside it. `alias` is the table alias when
 * the query joins (`ce`). Matches nothing for an empty email.
 */
export function whereContactEmail<T extends Knex.QueryBuilder>(qb: T, email: string | null | undefined, hasher: ContactLookupHasher, alias?: string): T {
  const col = (name: string) => (alias ? `${alias}.${name}` : name)
  const normalized = normalizeEmailForLookup(email)
  if (!normalized) return qb.whereRaw('false') as T
  return qb.where(function (this: Knex.QueryBuilder) {
    this.whereIn(col('primary_email_hash'), hasher.candidates(normalized))
      .orWhere(function (this: Knex.QueryBuilder) {
        this.whereNull(col('primary_email_hash')).whereRaw(`lower(${col('primary_email')}) = ?`, [normalized])
      })
  }).where(col('tenant_id'), hasher.tenantId) as T
}

/** Same as whereContactEmail for a set of addresses. */
export function whereContactEmailIn<T extends Knex.QueryBuilder>(qb: T, emails: Array<string | null | undefined>, hasher: ContactLookupHasher, alias?: string): T {
  const col = (name: string) => (alias ? `${alias}.${name}` : name)
  const normalized = Array.from(new Set(emails.map(normalizeEmailForLookup).filter(Boolean)))
  if (!normalized.length) return qb.whereRaw('false') as T
  return qb.where(function (this: Knex.QueryBuilder) {
    this.whereIn(col('primary_email_hash'), normalized.flatMap((e) => hasher.candidates(e)))
      .orWhere(function (this: Knex.QueryBuilder) {
        this.whereNull(col('primary_email_hash')).whereRaw(`lower(${col('primary_email')}) = any(?)`, [normalized])
      })
  }).where(col('tenant_id'), hasher.tenantId) as T
}

/** Restrict a customer_entities query to rows whose primary_phone has the same digits as `phone`. */
export function whereContactPhone<T extends Knex.QueryBuilder>(qb: T, phone: string | null | undefined, hasher: ContactLookupHasher, alias?: string): T {
  const col = (name: string) => (alias ? `${alias}.${name}` : name)
  const digits = normalizePhoneForLookup(phone)
  if (!digits) return qb.whereRaw('false') as T
  return qb.where(function (this: Knex.QueryBuilder) {
    this.whereIn(col('primary_phone_hash'), hasher.candidates(digits))
      .orWhere(function (this: Knex.QueryBuilder) {
        this.whereNull(col('primary_phone_hash')).whereRaw(`regexp_replace(coalesce(${col('primary_phone')}, ''), '\\D', '', 'g') = ?`, [digits])
      })
  }).where(col('tenant_id'), hasher.tenantId) as T
}

/**
 * Contacts with this email in ANY tenant (an ESP webhook knows only the
 * address). The keyed hash differs per tenant, so one arm per tenant.
 */
export async function contactsByEmailAcrossTenants(
  knex: Knex,
  email: string | null | undefined,
  columns: string[],
): Promise<Array<Record<string, unknown>>> {
  const normalized = normalizeEmailForLookup(email)
  if (!normalized) return []
  const tenants = (await knex('tenants').whereNull('deleted_at').select('id')) as Array<{ id: string }>
  const out: Array<Record<string, unknown>> = []
  for (const tenant of tenants) {
    const hasher = await contactLookupHasher(String(tenant.id))
    const rows = await whereContactEmail(knex('customer_entities'), normalized, hasher).select(columns)
    out.push(...(rows as Array<Record<string, unknown>>))
  }
  return out
}

export type { ContactLookupHasher }
