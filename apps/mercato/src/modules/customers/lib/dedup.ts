/**
 * Cross-entry duplicate detection and merge for CRM contacts.
 *
 * findOrMergeContact — checks if a contact with the same primary_email already exists.
 *
 * Merging lives in api/contacts/dedup.ts (the only merge the app calls). A
 * second, uncalled copy here wrote the merge activity in plaintext and was
 * removed on 2026-09-24.
 */

import type { Knex } from 'knex'
import { contactLookupHasher } from '@open-mercato/shared/lib/encryption/lookupKey'
import { blindSearchIds } from '@open-mercato/core/modules/customers/lib/blindSearch'

/**
 * Return the matched contact row (or null) so callers can use the
 * natural `if (dedupResult.existing) { dedupResult.existing.id }` pattern.
 * Prior signature returned a discriminated union which callers were
 * accessing incorrectly (`dedupResult.existing.id` when existing was a
 * boolean), silently producing duplicates instead of finding the match.
 */
type FindResult = { existing: { id: string; primary_email?: string | null } | null }

export async function findOrMergeContact(
  knex: Knex,
  orgId: string,
  tenantId: string,
  email: string,
  name?: string,
  phone?: string,
  em?: any,
): Promise<FindResult> {
  if (!email) return { existing: null }
  // Same normalisation the writers hash (lookupHashRules: lower + trim).
  const normalized = email.trim().toLowerCase()
  if (!normalized) return { existing: null }

  // 1) Fast path: exact match on plaintext primary_email.
  const plain = await knex('customer_entities')
    .whereRaw('LOWER(primary_email) = ?', [normalized])
    .where('organization_id', orgId)
    .whereNull('deleted_at')
    .first()
  if (plain) return { existing: { id: plain.id, primary_email: plain.primary_email } }

  // 1b) Hash fast path: primary_email_hash is the per-tenant keyed hash of the
  // normalized plaintext (or the legacy sha256 until the rehash has run),
  // written by the encryption subscriber and backfilled. This is
  // what makes encrypted contacts O(1) instead of the decrypt-scan below —
  // the scan stays only as a fallback for rows written before the hash existed.
  const hasher = await contactLookupHasher(tenantId)
  const hashed = await knex('customer_entities')
    .whereIn('primary_email_hash', hasher.candidates(normalized))
    .where('organization_id', orgId)
    .whereNull('deleted_at')
    .first()
  if (hashed) return { existing: { id: hashed.id, primary_email: hashed.primary_email } }

  // 2) Encrypted rows without a lookup hash (written before the hash
  // existed): the blind index finds the candidates (exact-address token), and
  // decrypting just those confirms the match. This replaced a decrypt-scan of
  // the org's first 2,000 contacts, which missed everything past that window.
  try {
    if (!em) return { existing: null }
    const { ids } = await blindSearchIds(em, {
      tenantId, organizationIds: [orgId], entityTypes: ['person', 'company'],
      query: normalized, fields: ['primary_email'], cap: 25,
    })
    if (!ids.length) return { existing: null }
    const candidates = await knex('customer_entities')
      .where('organization_id', orgId)
      .whereIn('id', ids)
      .whereNull('deleted_at')
      .select('id', 'primary_email')
    const { TenantDataEncryptionService } = await import('@open-mercato/shared/lib/encryption/tenantDataEncryptionService')
    const { createKmsService } = await import('@open-mercato/shared/lib/encryption/kms')
    const svc = new TenantDataEncryptionService(em, { kms: createKmsService() })
    for (const row of candidates) {
      try {
        const dec = await svc.decryptEntityPayload('customers:customer_entity', { primary_email: row.primary_email }, tenantId, orgId)
        const decrypted = typeof dec.primary_email === 'string' ? dec.primary_email.toLowerCase().trim() : ''
        if (decrypted && decrypted === normalized) {
          return { existing: { id: row.id, primary_email: row.primary_email } }
        }
      } catch { /* skip rows we can't decrypt */ }
    }
  } catch { /* fall through */ }

  return { existing: null }
}

/**
 * Phone counterpart to findOrMergeContact.
 *
 * primary_phone is encrypted at rest on the ORM write path, so a plaintext
 * WHERE can never match those rows — callers that looked a contact up by phone
 * simply failed to find it and fell back to showing the raw number. Same shape
 * as the email path: exact plaintext match first, then decrypt candidates
 * in-memory when tenant encryption is on.
 *
 * Compares on digits only, so formatting differences (+1, spaces, dashes)
 * do not cause a miss.
 */
export async function findContactByPhone(
  knex: Knex,
  orgId: string,
  tenantId: string,
  phone: string,
  em?: any,
): Promise<{ existing: { id: string; display_name?: string | null; primary_email?: string | null } | null }> {
  if (!phone) return { existing: null }
  const digits = (value: string) => value.replace(/\D/g, '')
  const needle = digits(phone)
  if (!needle) return { existing: null }

  const plain = await knex('customer_entities')
    .where('primary_phone', phone)
    .where('organization_id', orgId)
    .whereNull('deleted_at')
    .first()
  if (plain) return { existing: { id: plain.id, display_name: plain.display_name, primary_email: plain.primary_email } }

  // Hash fast path (digits-normalized), same contract as the email one above.
  const hashed = await knex('customer_entities')
    .whereIn('primary_phone_hash', (await contactLookupHasher(tenantId)).candidates(needle))
    .where('organization_id', orgId)
    .whereNull('deleted_at')
    .first()
  if (hashed) return { existing: { id: hashed.id, display_name: hashed.display_name, primary_email: hashed.primary_email } }

  // Hash-less encrypted rows: blind-index candidates (phone digits token),
  // confirmed by decrypting only those rows.
  try {
    if (!em) return { existing: null }
    const { ids } = await blindSearchIds(em, {
      tenantId, organizationIds: [orgId], entityTypes: ['person', 'company'],
      query: needle, fields: ['primary_phone'], cap: 25,
    })
    if (!ids.length) return { existing: null }
    const candidates = await knex('customer_entities')
      .where('organization_id', orgId)
      .whereIn('id', ids)
      .whereNull('deleted_at')
      .select('id', 'primary_phone', 'display_name', 'primary_email')
    const { TenantDataEncryptionService } = await import('@open-mercato/shared/lib/encryption/tenantDataEncryptionService')
    const { createKmsService } = await import('@open-mercato/shared/lib/encryption/kms')
    const svc = new TenantDataEncryptionService(em, { kms: createKmsService() })
    for (const row of candidates) {
      try {
        const dec = await svc.decryptEntityPayload(
          'customers:customer_entity',
          { primary_phone: row.primary_phone, display_name: row.display_name, primary_email: row.primary_email },
          tenantId,
          orgId,
        )
        const decrypted = typeof dec.primary_phone === 'string' ? digits(dec.primary_phone) : ''
        if (decrypted && decrypted === needle) {
          return {
            existing: {
              id: row.id,
              display_name: typeof dec.display_name === 'string' ? dec.display_name : row.display_name,
              primary_email: typeof dec.primary_email === 'string' ? dec.primary_email : row.primary_email,
            },
          }
        }
      } catch { /* skip rows we can't decrypt */ }
    }
  } catch { /* fall through */ }

  return { existing: null }
}
