import type { Knex } from 'knex'
import { DEFAULT_ENCRYPTION_MAPS } from '../../entities/lib/encryptionDefaults'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'

/**
 * Which index-document fields are encrypted-by-design, so the query index
 * never derives searchable data from them.
 *
 * The query index used to tokenize the DECRYPTED document into search_tokens
 * with an unkeyed SHA-256 per word and per 3+ char prefix, and to aggregate
 * every string field into doc.search_text. For contact names, emails, phones,
 * deal titles, activity bodies and encrypted custom fields that is a
 * plaintext-equivalent copy: an unkeyed hash of "john" is reversed by hashing
 * a name list. Those fields are now skipped (customer search runs on the keyed
 * blind index, customer_search_tokens), and Migration20260925120000 purges
 * what was already written.
 *
 * A field is excluded when:
 * - the default encryption map lists it for the entity (customer profiles also
 *   carry their parent customer_entities fields in the same document),
 * - its stored value in the document is an encryption envelope (covers tenant
 *   maps that encrypt more, and encrypted custom fields), or
 * - it is an encrypted custom field (config_json.encrypted) of the entity.
 */

const PROFILE_PARENT = new Set(['customers:customer_person_profile', 'customers:customer_company_profile'])

const STATIC: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>()
  for (const entry of DEFAULT_ENCRYPTION_MAPS) {
    map.set(entry.entityId, new Set(entry.fields.map((f) => f.field)))
  }
  const parent = map.get('customers:customer_entity') ?? new Set<string>()
  for (const id of PROFILE_PARENT) {
    map.set(id, new Set([...(map.get(id) ?? []), ...parent]))
  }
  return map
})()

/** Entity types whose documents carry encrypted-by-design fields. */
export const ENCRYPTED_INDEX_ENTITY_TYPES: readonly string[] = Array.from(STATIC.keys())

export function staticEncryptedIndexFields(entityType: string): Set<string> {
  return new Set(STATIC.get(entityType) ?? [])
}

export function hasEncryptedIndexFields(entityType: string): boolean {
  return (STATIC.get(entityType)?.size ?? 0) > 0
}

function holdsEnvelope(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((v) => isEncryptedEnvelope(v))
  return isEncryptedEnvelope(value)
}

/** Keys of a stored (encrypted-at-rest) document whose value is an envelope. */
export function fieldsEncryptedInDoc(doc: Record<string, unknown> | null | undefined): Set<string> {
  const out = new Set<string>()
  if (!doc) return out
  for (const [key, value] of Object.entries(doc)) if (holdsEnvelope(value)) out.add(key)
  return out
}

const CF_CACHE_TTL_MS = 60_000
const cfCache = new Map<string, { keys: Set<string>; expiresAt: number }>()

/** `cf:<key>` / `cf_<key>` names of the entity's encrypted custom fields (definitions are not secret). */
export async function encryptedCustomFieldKeys(knex: Knex, entityType: string, tenantId: string | null | undefined): Promise<Set<string>> {
  const cacheKey = `${entityType}|${tenantId ?? ''}`
  const hit = cfCache.get(cacheKey)
  if (hit && hit.expiresAt > Date.now()) return hit.keys
  const keys = new Set<string>()
  try {
    const rows = await knex('custom_field_defs')
      .select('key')
      .where('entity_id', entityType)
      .whereNull('deleted_at')
      .whereRaw(`(config_json::jsonb ->> 'encrypted') = 'true'`)
      .andWhere((qb) => { qb.whereNull('tenant_id'); if (tenantId) qb.orWhere('tenant_id', tenantId) })
    for (const row of rows as Array<{ key: string }>) {
      keys.add(`cf:${row.key}`)
      keys.add(`cf_${row.key}`)
    }
  } catch {
    // table missing or config not JSON: nothing more to exclude
  }
  cfCache.set(cacheKey, { keys, expiresAt: Date.now() + CF_CACHE_TTL_MS })
  return keys
}

/** Everything the index must not tokenize or aggregate for this document. */
export async function resolveIndexExclusions(
  knex: Knex | null,
  entityType: string,
  tenantId: string | null | undefined,
  storedDoc?: Record<string, unknown> | null,
): Promise<Set<string>> {
  const out = staticEncryptedIndexFields(entityType)
  for (const k of fieldsEncryptedInDoc(storedDoc)) out.add(k)
  if (knex) for (const k of await encryptedCustomFieldKeys(knex, entityType, tenantId)) out.add(k)
  return out
}
