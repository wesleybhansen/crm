import { TenantDataEncryptionService } from './tenantDataEncryptionService'
import { isTenantDataEncryptionEnabled } from './toggles'
import { createKmsService } from './kms'

/**
 * Decrypt encrypted-at-rest fields on rows that were read through raw knex.
 *
 * Raw knex reads bypass the ORM subscriber that decrypts these columns, so any
 * route that selects them directly gets `iv:ct:tag:v1` ciphertext instead of the
 * value. That is invisible in list views full of ids, and actively harmful on
 * outbound paths, where it becomes the name in a customer's inbox.
 *
 * Prefer the ORM `find*WithDecryption` helpers when a route can use them. This
 * exists for routes that must keep their knex query (complex filters, joins,
 * pagination) and only need the values decrypted afterwards.
 *
 * Mutates and returns the same row objects. Decryption is per-row and
 * best-effort: one unreadable record leaves its own fields untouched rather
 * than failing the whole page.
 */
export async function decryptRowFields<T extends Record<string, any>>(
  /** Pass the request EntityManager when you have one. Many call sites only
   *  hold a knex handle (helpers that take `knex` and nothing else), so pass
   *  null/undefined and one is resolved from the request container instead. */
  em: unknown,
  entityKey: string,
  rows: T[],
  fields: readonly string[],
  tenantId: string | null | undefined,
  orgId: string | null | undefined,
): Promise<T[]> {
  if (!rows?.length || !tenantId || !isTenantDataEncryptionEnabled()) return rows

  let manager = em
  if (!manager) {
    try {
      const { createRequestContainer } = await import('../di/container')
      manager = (await createRequestContainer()).resolve('em')
    } catch {
      // No request container in this execution context. Returning the rows
      // untouched keeps the caller working exactly as it did before this helper
      // existed, rather than turning a display problem into a 500.
      return rows
    }
  }
  const svc = new TenantDataEncryptionService(manager as any, { kms: createKmsService() })
  for (const row of rows) {
    if (!row) continue
    const payload: Record<string, unknown> = {}
    for (const field of fields) {
      if (typeof row[field] === 'string') payload[field] = row[field]
    }
    if (!Object.keys(payload).length) continue
    try {
      const decrypted = await svc.decryptEntityPayload(entityKey, payload, tenantId, orgId as any)
      for (const field of fields) {
        const value = (decrypted as Record<string, unknown>)?.[field]
        if (typeof value === 'string') (row as Record<string, unknown>)[field] = value
      }
    } catch {
      /* leave this row's stored values alone */
    }
  }
  return rows
}

/** Contact fields encrypted at rest (`customers:customer_entity`). */
export const CONTACT_ENTITY_KEY = 'customers:customer_entity'
export const CONTACT_ENCRYPTED_FIELDS = ['display_name', 'primary_email', 'primary_phone'] as const

/** Deal fields encrypted at rest (`customers:customer_deal`). */
export const DEAL_ENTITY_KEY = 'customers:customer_deal'
export const DEAL_ENCRYPTED_FIELDS = ['title', 'description'] as const
