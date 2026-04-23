/**
 * Cross-entry duplicate detection and merge for CRM contacts.
 *
 * findOrMergeContact — checks if a contact with the same primary_email already exists.
 * mergeContacts     — moves all related records from secondary to primary, then soft-deletes secondary.
 */

import type { Knex } from 'knex'

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
  const normalized = email.toLowerCase()

  // 1) Fast path: exact match on plaintext primary_email.
  const plain = await knex('customer_entities')
    .whereRaw('LOWER(primary_email) = ?', [normalized])
    .where('organization_id', orgId)
    .whereNull('deleted_at')
    .first()
  if (plain) return { existing: { id: plain.id, primary_email: plain.primary_email } }

  // 2) Encrypted-email fallback: the ORM-write path stores primary_email as
  // ciphertext, so LOWER(primary_email) will never match a plaintext needle.
  // When encryption is on, scan candidates and decrypt their primary_email
  // in-memory to find the match.
  try {
    if (!em) return { existing: null }
    const { isTenantDataEncryptionEnabled } = await import('@open-mercato/shared/lib/encryption/toggles')
    if (!isTenantDataEncryptionEnabled()) return { existing: null }
    const { TenantDataEncryptionService } = await import('@open-mercato/shared/lib/encryption/tenantDataEncryptionService')
    const { createKmsService } = await import('@open-mercato/shared/lib/encryption/kms')
    const svc = new TenantDataEncryptionService(em, { kms: createKmsService() })

    const candidates = await knex('customer_entities')
      .where('organization_id', orgId)
      .whereNull('deleted_at')
      .whereNotNull('primary_email')
      .limit(2000)
      .select('id', 'primary_email')
    for (const row of candidates) {
      try {
        const dec = await svc.decryptEntityPayload(
          'customers:customer_entity',
          { primary_email: row.primary_email },
          tenantId,
          orgId,
        )
        const decrypted = typeof dec.primary_email === 'string' ? dec.primary_email.toLowerCase() : ''
        if (decrypted && decrypted === normalized) {
          return { existing: { id: row.id, primary_email: row.primary_email } }
        }
      } catch { /* skip rows we can't decrypt */ }
    }
  } catch { /* fall through */ }

  return { existing: null }
}

type MergeResult = { merged: true; primaryId: string; secondaryId: string }

export async function mergeContacts(
  knex: Knex,
  orgId: string,
  primaryId: string,
  secondaryId: string,
): Promise<MergeResult> {
  const now = new Date()

  // 1. contact_notes: update contact_id
  await knex('contact_notes')
    .where('contact_id', secondaryId)
    .where('organization_id', orgId)
    .update({ contact_id: primaryId, updated_at: now })
    .catch(() => {})

  // 2. tasks: update contact_id
  await knex('tasks')
    .where('contact_id', secondaryId)
    .where('organization_id', orgId)
    .update({ contact_id: primaryId, updated_at: now })
    .catch(() => {})

  // 3. email_messages: update contact_id
  await knex('email_messages')
    .where('contact_id', secondaryId)
    .where('organization_id', orgId)
    .update({ contact_id: primaryId })
    .catch(() => {})

  // 4. form_submissions: update contact_id
  await knex('form_submissions')
    .where('contact_id', secondaryId)
    .where('organization_id', orgId)
    .update({ contact_id: primaryId })
    .catch(() => {})

  // 5. invoices: update contact_id
  await knex('invoices')
    .where('contact_id', secondaryId)
    .where('organization_id', orgId)
    .update({ contact_id: primaryId, updated_at: now })
    .catch(() => {})

  // 6. sms_messages: update contact_id
  await knex('sms_messages')
    .where('contact_id', secondaryId)
    .where('organization_id', orgId)
    .update({ contact_id: primaryId })
    .catch(() => {})

  // 7. customer_activities: update entity_id
  await knex('customer_activities')
    .where('entity_id', secondaryId)
    .where('organization_id', orgId)
    .update({ entity_id: primaryId })
    .catch(() => {})

  // 8. customer_tag_assignments: update entity_id, skip if tag already on primary
  const secondaryTags = await knex('customer_tag_assignments')
    .where('entity_id', secondaryId)
    .where('organization_id', orgId)
    .catch(() => [] as any[])

  const primaryTags = await knex('customer_tag_assignments')
    .where('entity_id', primaryId)
    .where('organization_id', orgId)
    .select('tag_id')
    .catch(() => [] as any[])

  const primaryTagIds = new Set(primaryTags.map((t: any) => t.tag_id))

  for (const tag of secondaryTags) {
    if (primaryTagIds.has(tag.tag_id)) {
      // Duplicate tag — just delete the secondary assignment
      await knex('customer_tag_assignments').where('id', tag.id).del().catch(() => {})
    } else {
      await knex('customer_tag_assignments')
        .where('id', tag.id)
        .update({ entity_id: primaryId })
        .catch(() => {})
    }
  }

  // 9. sequence_enrollments: update contact_id, skip if already enrolled in same sequence
  const secondaryEnrollments = await knex('sequence_enrollments')
    .where('contact_id', secondaryId)
    .where('organization_id', orgId)
    .catch(() => [] as any[])

  const primaryEnrollments = await knex('sequence_enrollments')
    .where('contact_id', primaryId)
    .where('organization_id', orgId)
    .whereIn('status', ['active'])
    .select('sequence_id')
    .catch(() => [] as any[])

  const primarySequenceIds = new Set(primaryEnrollments.map((e: any) => e.sequence_id))

  for (const enrollment of secondaryEnrollments) {
    if (primarySequenceIds.has(enrollment.sequence_id) && enrollment.status === 'active') {
      // Already enrolled — mark secondary as completed to avoid duplicates
      await knex('sequence_enrollments')
        .where('id', enrollment.id)
        .update({ status: 'completed', contact_id: primaryId })
        .catch(() => {})
    } else {
      await knex('sequence_enrollments')
        .where('id', enrollment.id)
        .update({ contact_id: primaryId })
        .catch(() => {})
    }
  }

  // 10. engagement_events: update contact_id
  await knex('engagement_events')
    .where('contact_id', secondaryId)
    .where('organization_id', orgId)
    .update({ contact_id: primaryId })
    .catch(() => {})

  // 11. contact_engagement_scores: add secondary score to primary, delete secondary
  const secondaryScore = await knex('contact_engagement_scores')
    .where('contact_id', secondaryId)
    .first()
    .catch(() => null)

  if (secondaryScore) {
    const primaryScore = await knex('contact_engagement_scores')
      .where('contact_id', primaryId)
      .first()
      .catch(() => null)

    if (primaryScore) {
      await knex('contact_engagement_scores')
        .where('contact_id', primaryId)
        .update({
          score: (primaryScore.score || 0) + (secondaryScore.score || 0),
          updated_at: now,
        })
        .catch(() => {})
    } else {
      // Move score record to primary
      await knex('contact_engagement_scores')
        .where('contact_id', secondaryId)
        .update({ contact_id: primaryId, updated_at: now })
        .catch(() => {})
    }

    // Delete secondary score if it still exists (was merged into primary above)
    if (primaryScore) {
      await knex('contact_engagement_scores')
        .where('contact_id', secondaryId)
        .del()
        .catch(() => {})
    }
  }

  // 12. Soft-delete the secondary contact
  await knex('customer_entities')
    .where('id', secondaryId)
    .where('organization_id', orgId)
    .update({ deleted_at: now, updated_at: now })

  // 13. Log merge as activity on the primary contact
  const secondaryContact = await knex('customer_entities')
    .where('id', secondaryId)
    .first()

  await knex('customer_activities').insert({
    id: require('crypto').randomUUID(),
    organization_id: orgId,
    entity_id: primaryId,
    activity_type: 'contact_merged',
    subject: `Merged with ${secondaryContact?.display_name || secondaryId}`,
    created_at: now,
  }).catch(() => {})

  return { merged: true, primaryId, secondaryId }
}
