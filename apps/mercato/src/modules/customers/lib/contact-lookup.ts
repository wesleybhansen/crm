import type { Knex } from 'knex'
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'

/**
 * Value lookups on contact email / phone.
 *
 * primary_email and primary_phone are encrypted at rest with a random IV, so
 * `where('primary_email', email)` can never match an encrypted row. The
 * identity is the lookup hash (sha256 of the normalized plaintext, written by
 * the encryption subscriber, encryptRowForRawWrite and the plaintext
 * backfill). The plaintext comparison stays as a second arm only for legacy
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

export function emailLookupHash(email: string | null | undefined): string | null {
  const normalized = normalizeEmailForLookup(email)
  return normalized ? hashForLookup(normalized) : null
}

export function phoneLookupHash(phone: string | null | undefined): string | null {
  const normalized = normalizePhoneForLookup(phone)
  return normalized ? hashForLookup(normalized) : null
}

/**
 * Restrict a customer_entities query to rows whose primary_email is `email`.
 * `alias` is the table alias when the query joins (`ce`). Matches nothing for
 * an empty email.
 */
export function whereContactEmail<T extends Knex.QueryBuilder>(qb: T, email: string | null | undefined, alias?: string): T {
  const col = (name: string) => (alias ? `${alias}.${name}` : name)
  const normalized = normalizeEmailForLookup(email)
  if (!normalized) return qb.whereRaw('false') as T
  return qb.where(function (this: Knex.QueryBuilder) {
    this.where(col('primary_email_hash'), hashForLookup(normalized))
      .orWhere(function (this: Knex.QueryBuilder) {
        this.whereNull(col('primary_email_hash')).whereRaw(`lower(${col('primary_email')}) = ?`, [normalized])
      })
  }) as T
}

/** Same as whereContactEmail for a set of addresses. */
export function whereContactEmailIn<T extends Knex.QueryBuilder>(qb: T, emails: Array<string | null | undefined>, alias?: string): T {
  const col = (name: string) => (alias ? `${alias}.${name}` : name)
  const normalized = Array.from(new Set(emails.map(normalizeEmailForLookup).filter(Boolean)))
  if (!normalized.length) return qb.whereRaw('false') as T
  return qb.where(function (this: Knex.QueryBuilder) {
    this.whereIn(col('primary_email_hash'), normalized.map((e) => hashForLookup(e)))
      .orWhere(function (this: Knex.QueryBuilder) {
        this.whereNull(col('primary_email_hash')).whereRaw(`lower(${col('primary_email')}) = any(?)`, [normalized])
      })
  }) as T
}

/** Restrict a customer_entities query to rows whose primary_phone has the same digits as `phone`. */
export function whereContactPhone<T extends Knex.QueryBuilder>(qb: T, phone: string | null | undefined, alias?: string): T {
  const col = (name: string) => (alias ? `${alias}.${name}` : name)
  const digits = normalizePhoneForLookup(phone)
  if (!digits) return qb.whereRaw('false') as T
  return qb.where(function (this: Knex.QueryBuilder) {
    this.where(col('primary_phone_hash'), hashForLookup(digits))
      .orWhere(function (this: Knex.QueryBuilder) {
        this.whereNull(col('primary_phone_hash')).whereRaw(`regexp_replace(coalesce(${col('primary_phone')}, ''), '\\D', '', 'g') = ?`, [digits])
      })
  }) as T
}
