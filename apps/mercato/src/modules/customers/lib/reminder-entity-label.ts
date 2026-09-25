import type { Knex } from 'knex'
import {
  decryptRowFieldsByRowScope,
  CONTACT_ENTITY_KEY,
  DEAL_ENTITY_KEY,
} from '@open-mercato/shared/lib/encryption/decryptRows'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'
import { UNDECRYPTABLE_DISPLAY_TEXT } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'

/**
 * The human label a reminder email shows for its contact or deal.
 *
 * Contact names and deal titles are encrypted at rest, and the reminder
 * senders read them raw, so the email carried ciphertext. The row is read in
 * the reminder's own organization (the old lookup was by id alone) and
 * decrypted in its own tenant scope; anything unreadable falls back to the
 * generic label, never ciphertext.
 *
 * Package imports only: reachable from cron and worker code.
 */
export async function reminderEntityLabel(
  knex: Knex,
  entityType: 'contact' | 'deal',
  entityId: string,
  organizationId: string,
  em?: unknown,
): Promise<string> {
  const fallback = entityType === 'contact' ? 'Contact' : 'Deal'
  const table = entityType === 'contact' ? 'customer_entities' : 'customer_deals'
  const field = entityType === 'contact' ? 'display_name' : 'title'
  const row = await knex(table)
    .where('id', entityId)
    .where('organization_id', organizationId)
    .select(field, 'tenant_id', 'organization_id')
    .first()
  if (!row) return fallback
  await decryptRowFieldsByRowScope(em ?? null, entityType === 'contact' ? CONTACT_ENTITY_KEY : DEAL_ENTITY_KEY, [row], [field])
  const value = row[field]
  if (typeof value !== 'string' || !value.trim() || isEncryptedEnvelope(value) || value === UNDECRYPTABLE_DISPLAY_TEXT) return fallback
  return value
}
