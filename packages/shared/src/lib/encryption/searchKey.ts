import crypto from 'node:crypto'
import { keyIdForDek } from './aes'
import { createKmsService } from './kms'
import { deriveSearchKey } from './searchTokens'
import type { TenantDek } from './kms'
import { TenantDataEncryptionService } from './tenantDataEncryptionService'
import { isTenantDataEncryptionEnabled } from './toggles'

/**
 * The per-tenant key for the blind search index (see searchTokens.ts).
 *
 * Derived from the tenant data key (the same DEK that encrypts the columns)
 * with HKDF and a search-only label. When tenant data encryption is switched
 * off the columns are plaintext anyway and there is no DEK; the index then
 * uses a fixed per-tenant key so search keeps working. Turning encryption on
 * later changes the key, and `reindex-customer-search --execute` rebuilds the
 * index under it (the consistency check reports the drift until then).
 *
 * With encryption ON and no key available this returns null: callers write no
 * tokens and search matches nothing rather than index under a wrong key.
 *
 * Relative imports only: reachable from worker bundles and the backfill script.
 */

type DekSource = { getDek(tenantId: string | null | undefined): Promise<TenantDek | null> }

let sharedService: TenantDataEncryptionService | null = null
function defaultDekSource(): DekSource {
  // getDek only needs the KMS; the EntityManager is used for encryption maps,
  // which this service never loads. The DEK cache is process-wide (static).
  if (!sharedService) sharedService = new TenantDataEncryptionService(null as any, { kms: createKmsService() })
  return sharedService
}

const keyCache = new Map<string, { keyId: string; key: Buffer }>()

export const UNENCRYPTED_SEARCH_KEY_LABEL = 'noli:crm:customer-search-index:unencrypted-tenant:v1'

export async function resolveSearchKey(tenantId: string | null | undefined, source?: DekSource | null): Promise<Buffer | null> {
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
    const key = deriveSearchKey(dek.key)
    keyCache.set(tenantId, { keyId, key })
    return key
  }
  if (!isTenantDataEncryptionEnabled()) {
    return crypto.createHmac('sha256', UNENCRYPTED_SEARCH_KEY_LABEL).update(tenantId).digest()
  }
  return null
}

/** Test seam. */
export function resetSearchKeyCacheForTests(): void {
  keyCache.clear()
  sharedService = null
}
