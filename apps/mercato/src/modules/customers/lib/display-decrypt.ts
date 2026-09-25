import { decryptAliasedRowFields } from '@open-mercato/shared/lib/encryption/decryptRows'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'
import { UNDECRYPTABLE_DISPLAY_TEXT } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'

/** True for a value that is still unreadable after decryption: an envelope of
 *  any version (shared parser) or the placeholder left by a failed decrypt. */
export function isUnreadableValue(value: unknown): boolean {
  return isEncryptedEnvelope(value) || value === UNDECRYPTABLE_DISPLAY_TEXT
}

/**
 * Decrypt encrypted-at-rest columns that a raw (knex) read put on rows under
 * the given aliases (`{ contact_name: 'display_name' }`), then replace
 * anything still unreadable with `fallback` (default null). Rows are mutated
 * and returned. For list/detail responses: ciphertext never reaches a screen.
 *
 * Package imports only: safe for worker bundles.
 */
export async function decryptRowsForDisplay<T extends Record<string, any>>(
  em: unknown,
  entityKey: string,
  rows: T[],
  aliases: Record<string, string>,
  tenantId: string | null | undefined,
  orgId: string | null | undefined,
  fallback: string | null = null,
): Promise<T[]> {
  if (!rows?.length) return rows
  await decryptAliasedRowFields(em, entityKey, rows, aliases, tenantId, orgId)
  for (const row of rows) {
    if (!row) continue
    for (const alias of Object.keys(aliases)) {
      if (isUnreadableValue(row[alias])) (row as Record<string, unknown>)[alias] = fallback
    }
  }
  return rows
}
