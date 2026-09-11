import { decryptWithAesGcm, encryptWithAesGcm, isV1Version } from './aes'
import { isTenantDataEncryptionEnabled } from './toggles'

/**
 * Seal/open helpers for third-party credential columns written through raw knex.
 *
 * The transparent MikroORM subscriber only fires on ORM writes for entities
 * listed in the encryption maps. Integration credentials (mailbox OAuth tokens,
 * SMTP passwords, ESP API keys, Stripe Connect tokens, Twilio auth tokens) live
 * in tables that are almost always written with raw knex, so they never reached
 * the subscriber and sat in the database as plaintext.
 *
 * These helpers put the same per-tenant AES-GCM envelope on those columns at the
 * write, and take it off at the read. `open` is deliberately TOLERANT: rows
 * written before this existed hold bare plaintext, and those must keep working
 * without a migration. A value that is not an envelope is handed back unchanged.
 */

export type TenantEncryptionLike = {
  isEnabled?: () => boolean
  getDek: (tenantId: string) => Promise<{ key: string } | null>
}

/** True when the stored string carries our `iv:ct:tag:v1[.keyId]` envelope. */
export function isSealedSecret(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const parts = value.split(':')
  return parts.length === 4 && isV1Version(parts[3])
}

/**
 * Read the tenant encryption service off a container the call site already has.
 * Never throws: bootstrap registers the service inside a try/catch, so a
 * degraded environment can leave the name unresolvable, and a credential write
 * must not 500 because of that (seal falls back to storing plaintext, exactly
 * as before this helper existed).
 */
export function tenantEncryptionFromContainer(
  container: { resolve: (name: string) => unknown } | null | undefined,
): TenantEncryptionLike | null {
  if (!container) return null
  try {
    return (container.resolve('tenantEncryptionService') as TenantEncryptionLike | null) ?? null
  } catch {
    return null
  }
}

/**
 * Resolve the tenant encryption service the same way decryptRows.ts resolves an
 * EntityManager: prefer whatever the call site already holds, otherwise build a
 * request container. Returns null when there is no container in this execution
 * context (scripts, some worker paths) rather than throwing.
 */
export async function resolveTenantEncryptionService(
  container?: { resolve: (name: string) => unknown } | null,
): Promise<TenantEncryptionLike | null> {
  if (container) {
    try {
      const svc = container.resolve('tenantEncryptionService') as TenantEncryptionLike | null
      if (svc) return svc
    } catch {
      // fall through to a fresh container
    }
  }
  try {
    const { createRequestContainer } = await import('../di/container')
    const c = await createRequestContainer()
    return (c.resolve('tenantEncryptionService') as TenantEncryptionLike | null) ?? null
  } catch {
    return null
  }
}

/*
 * Library call sites (token refreshers, IMAP readers) hold no container, and
 * createRequestContainer() forks an EntityManager and re-bootstraps the module
 * graph — far too heavy to pay per secret. Only getDek()/isEnabled() are used
 * here, and neither touches the EntityManager (the DEK cache is static on the
 * service class), so one resolved service can be reused. Only successful
 * resolutions are cached, so an early call outside a request context does not
 * poison later ones.
 */
let cachedService: TenantEncryptionLike | null = null

/** Test seam: drop the memoized service. */
export function resetTenantEncryptionServiceCache(): void {
  cachedService = null
}

async function dekFor(
  service: TenantEncryptionLike | null | undefined,
  tenantId: string | null | undefined,
): Promise<string | null> {
  if (!tenantId) return null
  let svc = service ?? null
  if (!svc) {
    if (!cachedService) cachedService = await resolveTenantEncryptionService(null)
    svc = cachedService
  }
  if (!svc) return null
  try {
    if (typeof svc.isEnabled === 'function' && !svc.isEnabled()) return null
    const dek = await svc.getDek(tenantId)
    return dek?.key ?? null
  } catch (err) {
    console.error('[encryption] secret_dek_unavailable', {
      tenantId,
      error: (err as Error)?.message || String(err),
    })
    return null
  }
}

/**
 * Encrypt a credential for storage.
 *
 * - null/undefined in, null out (callers null the column to scrub it).
 * - An empty string stays an empty string: there is nothing to protect, and
 *   some of these columns are NOT NULL so '' is how they get scrubbed.
 * - An already-sealed value is returned untouched, so re-saving a row that was
 *   read back sealed cannot double-wrap it.
 * - No key available (encryption switched off, KMS unhealthy, no tenant) means
 *   the plaintext is stored exactly as it was before this helper existed. A
 *   write must never fail because the key service is down.
 */
export async function sealSecretForTenant(
  service: TenantEncryptionLike | null | undefined,
  tenantId: string | null | undefined,
  plain: string | null | undefined,
): Promise<string | null> {
  if (plain == null) return null
  if (plain === '') return ''
  if (isSealedSecret(plain)) return plain
  if (!isTenantDataEncryptionEnabled()) return plain
  const key = await dekFor(service, tenantId)
  if (!key) return plain
  try {
    const sealed = encryptWithAesGcm(plain, key).value
    return sealed || plain
  } catch (err) {
    console.error('[encryption] secret_seal_failed', {
      tenantId,
      error: (err as Error)?.message || String(err),
    })
    return plain
  }
}

/**
 * Decrypt a credential read back from storage.
 *
 * - null/undefined or '' in, the same value out.
 * - A non-envelope value is legacy plaintext and comes back unchanged.
 * - An envelope we cannot open (wrong key, sealed Vault, corrupt row) returns
 *   null and logs, redacted. Handing the ciphertext to a provider would show up
 *   as a confusing auth failure; null makes the caller take its "not connected"
 *   path instead.
 */
export async function openSecretForTenant(
  service: TenantEncryptionLike | null | undefined,
  tenantId: string | null | undefined,
  stored: string | null | undefined,
): Promise<string | null> {
  if (stored == null || stored === '') return stored ?? null
  if (!isSealedSecret(stored)) return stored
  const key = await dekFor(service, tenantId)
  if (!key) {
    console.error('[encryption] secret_open_no_key', { tenantId, length: stored.length })
    return null
  }
  const opened = decryptWithAesGcm(stored, key)
  if (opened == null) {
    console.error('[encryption] secret_open_failed', { tenantId, length: stored.length })
    return null
  }
  return opened
}

/**
 * Open several sealed columns on one row. Returns a shallow copy; the row read
 * from the database is left alone so a caller that echoes it cannot leak a
 * decrypted secret it did not ask for.
 */
export async function openSecretsOnRow<T extends Record<string, any>>(
  service: TenantEncryptionLike | null | undefined,
  tenantId: string | null | undefined,
  row: T | null | undefined,
  fields: readonly string[],
): Promise<T | null> {
  if (!row) return row ?? null
  const out = { ...row } as Record<string, any>
  for (const field of fields) {
    if (!(field in out)) continue
    const value = out[field]
    if (value == null || typeof value !== 'string') continue
    out[field] = await openSecretForTenant(service, tenantId, value)
  }
  return out as T
}

/** Open the same fields across a list of rows (each row keeps its own tenant). */
export async function openSecretsOnRows<T extends Record<string, any>>(
  service: TenantEncryptionLike | null | undefined,
  tenantId: string | null | undefined,
  rows: T[] | null | undefined,
  fields: readonly string[],
): Promise<T[]> {
  if (!rows?.length) return rows ?? []
  const out: T[] = []
  for (const row of rows) {
    out.push((await openSecretsOnRow(service, (row as any)?.tenant_id ?? tenantId, row, fields)) as T)
  }
  return out
}

/** Columns holding third-party credentials, by table. */
export const EMAIL_CONNECTION_SECRETS = ['access_token', 'refresh_token', 'smtp_pass'] as const
export const ESP_CONNECTION_SECRETS = ['api_key'] as const
export const STRIPE_CONNECTION_SECRETS = ['access_token', 'refresh_token'] as const
export const GOOGLE_CALENDAR_CONNECTION_SECRETS = ['access_token', 'refresh_token'] as const
export const TWILIO_CONNECTION_SECRETS = ['auth_token'] as const
