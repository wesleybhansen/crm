import { decryptRowFields, CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'
import { UNDECRYPTABLE_DISPLAY_TEXT } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'

/**
 * The contact fields an automation condition can read (the builder's Source,
 * Lifecycle Stage, Email and Name, plus tags for the installed templates),
 * loaded for one contact inside one organization and tenant. Name, email and
 * phone are encrypted at rest and decrypted here; a value that stays
 * ciphertext is treated as missing, never compared.
 *
 * Relative imports only: the dispatch subscribers bundle this into the queue workers.
 */
export type ContactFacts = {
  contact_id: string
  display_name: string | null
  primary_email: string | null
  primary_phone: string | null
  source: string | null
  lifecycle_stage: string | null
  tags: string[]
  name: string | null
  email: string | null
  phone: string | null
}

function readable(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  if (isEncryptedEnvelope(value) || value === UNDECRYPTABLE_DISPLAY_TEXT) return null
  return value
}

export async function loadContactFacts(
  knex: any,
  scope: { organizationId: string; tenantId: string },
  contactId: unknown,
): Promise<ContactFacts | null> {
  if (typeof contactId !== 'string' || !contactId) return null
  const row = await knex('customer_entities')
    .where('id', contactId)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .whereNull('deleted_at')
    .first('id', 'display_name', 'primary_email', 'primary_phone', 'source', 'lifecycle_stage')
  if (!row) return null
  try {
    await decryptRowFields(null, CONTACT_ENTITY_KEY, [row], ['display_name', 'primary_email', 'primary_phone'], scope.tenantId, scope.organizationId)
  } catch {
    // Unreadable fields fall out as null below.
  }
  const tagRows: Array<{ slug?: string | null; label?: string | null }> = await knex('customer_tag_assignments as cta')
    .join('customer_tags as ct', 'ct.id', 'cta.tag_id')
    .where('cta.entity_id', contactId)
    .where('cta.organization_id', scope.organizationId)
    .where('ct.organization_id', scope.organizationId)
    .select('ct.slug', 'ct.label')
  const tags = new Set<string>()
  for (const tag of tagRows) {
    if (typeof tag.slug === 'string' && tag.slug) tags.add(tag.slug)
    if (typeof tag.label === 'string' && tag.label) tags.add(tag.label)
  }
  const displayName = readable(row.display_name)
  const email = readable(row.primary_email)
  const phone = readable(row.primary_phone)
  return {
    contact_id: row.id,
    display_name: displayName,
    primary_email: email,
    primary_phone: phone,
    source: typeof row.source === 'string' && row.source ? row.source : null,
    lifecycle_stage: typeof row.lifecycle_stage === 'string' && row.lifecycle_stage ? row.lifecycle_stage : null,
    tags: [...tags],
    name: displayName,
    email,
    phone,
  }
}
