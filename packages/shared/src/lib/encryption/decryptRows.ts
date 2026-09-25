import { TenantDataEncryptionService, isTenantDataDecryptError } from './tenantDataEncryptionService'
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
        // The service JSON-parses what it decrypts, so a stored JSON body (form
        // submission activity) or a digits-only phone comes back as an object
        // or a number. A raw-read caller expects the column's text, and leaving
        // the field alone would leave the ciphertext in the row.
        else if (value !== null && value !== undefined && value !== payload[field]) {
          (row as Record<string, unknown>)[field] = JSON.stringify(value)
        }
      }
    } catch (err) {
      // A decrypt failure on a raw-read path is how a key swap hides for weeks,
      // so it is never silent. These rows go straight into list views, so the
      // unreadable fields carry the plain message instead of the ciphertext
      // they held a moment ago.
      if (isTenantDataDecryptError(err)) {
        console.error('[encryption] decrypt_rows_failed', {
          entityKey,
          tenantId,
          fields: err.fields,
          stampedKeyId: err.stampedKeyId,
          activeKeyId: err.activeKeyId,
        })
        for (const field of fields) {
          const value = (err.partial as Record<string, unknown>)?.[field]
          if (typeof value === 'string') (row as Record<string, unknown>)[field] = value
        }
        continue
      }
      console.error('[encryption] decrypt_rows_failed', { entityKey, tenantId, error: (err as Error)?.message || String(err) })
    }
  }
  return rows
}

/**
 * decryptRowFields for rows whose encrypted columns were selected under an
 * alias (`display_name as contact_name`, `d.title as deal_title`).
 * `aliases` maps the key in the row to the mapped field name.
 */
export async function decryptAliasedRowFields<T extends Record<string, any>>(
  em: unknown,
  entityKey: string,
  rows: T[],
  aliases: Record<string, string>,
  tenantId: string | null | undefined,
  orgId: string | null | undefined,
): Promise<T[]> {
  if (!rows?.length) return rows
  const entries = Object.entries(aliases)
  const shadows = rows.map((row) => {
    const shadow: Record<string, unknown> = {}
    for (const [alias, field] of entries) if (row && alias in row) shadow[field] = row[alias]
    return shadow
  })
  await decryptRowFields(em, entityKey, shadows, Array.from(new Set(entries.map(([, f]) => f))), tenantId, orgId)
  rows.forEach((row, i) => {
    if (!row) return
    for (const [alias, field] of entries) {
      if (alias in row) (row as Record<string, unknown>)[alias] = shadows[i]![field]
    }
  })
  return rows
}

/**
 * decryptRowFields for a result set that spans tenants/organizations (cron
 * jobs, webhooks). Each row is decrypted in its own scope, read from
 * `tenant_id` / `organization_id` (or the given column names).
 */
export async function decryptRowFieldsByRowScope<T extends Record<string, any>>(
  em: unknown,
  entityKey: string,
  rows: T[],
  fields: readonly string[],
  opts: { tenantColumn?: string; orgColumn?: string; aliases?: Record<string, string> } = {},
): Promise<T[]> {
  if (!rows?.length) return rows
  const tenantColumn = opts.tenantColumn ?? 'tenant_id'
  const orgColumn = opts.orgColumn ?? 'organization_id'
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    if (!row) continue
    const key = `${row[tenantColumn] ?? ''}|${row[orgColumn] ?? ''}`
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }
  for (const [key, list] of groups) {
    const [tenantId, orgId] = key.split('|')
    if (opts.aliases) await decryptAliasedRowFields(em, entityKey, list, opts.aliases, tenantId || null, orgId || null)
    else await decryptRowFields(em, entityKey, list, fields, tenantId || null, orgId || null)
  }
  return rows
}

/** Contact fields encrypted at rest (`customers:customer_entity`). */
export const CONTACT_ENTITY_KEY = 'customers:customer_entity'
export const CONTACT_ENCRYPTED_FIELDS = ['display_name', 'primary_email', 'primary_phone'] as const

/** Activity fields encrypted at rest (`customers:customer_activity`). */
export const ACTIVITY_ENTITY_KEY = 'customers:customer_activity'
export const ACTIVITY_ENCRYPTED_FIELDS = ['subject', 'body'] as const

/** Person profile fields encrypted at rest (`customers:customer_person_profile`). */
export const PERSON_ENTITY_KEY = 'customers:customer_person_profile'
export const PERSON_ENCRYPTED_FIELDS = ['first_name', 'last_name', 'preferred_name', 'job_title', 'department', 'seniority', 'timezone', 'linked_in_url', 'twitter_url'] as const

/** Company profile fields encrypted at rest (`customers:customer_company_profile`). */
export const COMPANY_ENTITY_KEY = 'customers:customer_company_profile'
export const COMPANY_ENCRYPTED_FIELDS = ['legal_name', 'brand_name', 'domain', 'website_url', 'industry'] as const

/** Comment fields encrypted at rest (`customers:customer_comment`). */
export const COMMENT_ENTITY_KEY = 'customers:customer_comment'
export const COMMENT_ENCRYPTED_FIELDS = ['body'] as const

/** Deal fields encrypted at rest (`customers:customer_deal`). */
export const DEAL_ENTITY_KEY = 'customers:customer_deal'
export const DEAL_ENCRYPTED_FIELDS = ['title', 'description'] as const
