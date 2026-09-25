import crypto from 'node:crypto'
import { hashForLookup, keyIdForDek } from './aes'
import { createKmsService } from './kms'
import type { TenantDek } from './kms'
import { TenantDataEncryptionService } from './tenantDataEncryptionService'
import { isTenantDataEncryptionEnabled } from './toggles'

/**
 * Per-tenant keyed lookup hashes for contact email / phone
 * (customer_entities.primary_email_hash, primary_phone_hash).
 *
 * These used to be unkeyed SHA-256 of the normalised value (aes.ts
 * hashForLookup): a leaked table gives up every phone number by brute force
 * in seconds, and the same person hashes identically in every tenant
 * (2026-09-25 review, M10). They are now HMAC-SHA256 under a key derived with
 * HKDF from the tenant data key (the DEK that encrypts the columns), with a
 * lookup-only label, stored as `k1:<hex>` so the two formats never collide.
 *
 * Rollout (dual read): writers store the keyed hash; every reader matches the
 * keyed hash OR the legacy unkeyed one, until `rehash-contact-lookups
 * --execute` has rewritten every row (then LOOKUP_HASH_LEGACY_READ=0 drops the
 * legacy arm). A tenant split changes the tenant key: run the rehash for the
 * new tenant afterwards (it rewrites any hash that is not the expected one).
 *
 * users.email_hash is NOT keyed per tenant: sign-in resolves an email to a
 * user before any tenant is known, so that hash must be tenant-independent.
 *
 * With encryption off there is no DEK; a fixed per-tenant key is used (the
 * columns are plaintext anyway). With encryption on and no key available, the
 * hasher has no key: writers fall back to the legacy hash rather than failing
 * a write, and readers match the legacy hash only.
 *
 * Relative imports only: reachable from worker bundles and scripts.
 */

export const LOOKUP_KEY_INFO = 'noli:crm:contact-lookup-hash:v1'
export const UNENCRYPTED_LOOKUP_KEY_LABEL = 'noli:crm:contact-lookup-hash:unencrypted-tenant:v1'
export const KEYED_LOOKUP_PREFIX = 'k1:'

type DekSource = { getDek(tenantId: string | null | undefined): Promise<TenantDek | null> }

let sharedService: TenantDataEncryptionService | null = null
function defaultDekSource(): DekSource {
  if (!sharedService) sharedService = new TenantDataEncryptionService(null as any, { kms: createKmsService() })
  return sharedService
}

const keyCache = new Map<string, { keyId: string; key: Buffer }>()

export function deriveLookupKey(tenantDekBase64: string): Buffer {
  const ikm = Buffer.from(tenantDekBase64, 'base64')
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(LOOKUP_KEY_INFO, 'utf8'), 32))
}

export async function resolveLookupKey(tenantId: string | null | undefined, source?: DekSource | null): Promise<Buffer | null> {
  if (!tenantId) return null
  let dek: TenantDek | null = null
  try {
    dek = await (source ?? defaultDekSource()).getDek(tenantId)
  } catch {
    dek = null
  }
  if (dek?.key) {
    const keyId = keyIdForDek(dek.key)
    const cached = keyCache.get(tenantId)
    if (cached && cached.keyId === keyId) return cached.key
    const key = deriveLookupKey(dek.key)
    keyCache.set(tenantId, { keyId, key })
    return key
  }
  if (!isTenantDataEncryptionEnabled()) {
    return crypto.createHmac('sha256', UNENCRYPTED_LOOKUP_KEY_LABEL).update(tenantId).digest()
  }
  return null
}

/** The keyed hash of an already normalised value. */
export function keyedLookupHash(key: Buffer, normalized: string): string {
  return KEYED_LOOKUP_PREFIX + crypto.createHmac('sha256', key).update(normalized, 'utf8').digest('hex')
}

export function isKeyedLookupHash(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(KEYED_LOOKUP_PREFIX)
}

/** Whether readers still match the legacy unkeyed hash (default on until the rehash has run everywhere). */
export function legacyLookupReadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.LOOKUP_HASH_LEGACY_READ ?? '').trim().toLowerCase()
  return !['0', 'false', 'no', 'off'].includes(raw)
}

export type ContactLookupHasher = {
  tenantId: string
  /** True when a tenant key is available (writes are keyed). */
  keyed: boolean
  /** The hash to store for a normalised value ('' -> null). */
  write(normalized: string): string | null
  /** Every hash a stored row for this value may carry (keyed first, then legacy). */
  candidates(normalized: string): string[]
}

export async function contactLookupHasher(tenantId: string, source?: DekSource | null): Promise<ContactLookupHasher> {
  const key = await resolveLookupKey(tenantId, source)
  const legacy = legacyLookupReadEnabled()
  return {
    tenantId,
    keyed: Boolean(key),
    write(normalized) {
      if (!normalized) return null
      return key ? keyedLookupHash(key, normalized) : hashForLookup(normalized)
    },
    candidates(normalized) {
      if (!normalized) return []
      const out: string[] = []
      if (key) out.push(keyedLookupHash(key, normalized))
      if (legacy || !key) out.push(hashForLookup(normalized))
      return out
    },
  }
}

/** Test seam. */
export function resetLookupKeyCacheForTests(): void {
  keyCache.clear()
  sharedService = null
}
