/**
 * Cross-entry duplicate detection and merge for CRM contacts.
 *
 * (An uncalled findOrMergeContact that compared LOWER(primary_email), which
 * can never match ciphertext, was removed on 2026-09-24; the live lookup is
 * customers/lib/dedup.ts.)
 * mergeContacts     — moves all related records from secondary to primary, then soft-deletes secondary.
 */

import type { Knex } from 'knex'
import { decryptRowFields, CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { encryptRowForRawWrite } from '@open-mercato/shared/lib/encryption/rawWrite'
import { UNDECRYPTABLE_DISPLAY_TEXT } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'

type MergeResult = { merged: true; primaryId: string; secondaryId: string }

export async function mergeContacts(
  knex: Knex,
  orgId: string,
  primaryId: string,
  secondaryId: string,
): Promise<MergeResult> {
  const now = new Date()

  // All ~14 writes run in ONE transaction: a mid-merge failure rolls the whole
  // merge back instead of leaving a half-merged pair. The old per-statement
  // `.catch(() => {})` swallows are gone deliberately — inside a Postgres
  // transaction a failed statement aborts the transaction anyway, so any error
  // now surfaces to the caller (the route 500s) and nothing is mutated.
  await knex.transaction(async (trx) => {
    // 1. contact_notes: update contact_id
    await trx('contact_notes')
      .where('contact_id', secondaryId)
      .where('organization_id', orgId)
      .update({ contact_id: primaryId, updated_at: now })

    // 2. tasks: update contact_id
    await trx('tasks')
      .where('contact_id', secondaryId)
      .where('organization_id', orgId)
      .update({ contact_id: primaryId, updated_at: now })

    // 3. email_messages: update contact_id
    await trx('email_messages')
      .where('contact_id', secondaryId)
      .where('organization_id', orgId)
      .update({ contact_id: primaryId })

    // 4. form_submissions: update contact_id
    await trx('form_submissions')
      .where('contact_id', secondaryId)
      .where('organization_id', orgId)
      .update({ contact_id: primaryId })

    // 5. invoices: update contact_id
    await trx('invoices')
      .where('contact_id', secondaryId)
      .where('organization_id', orgId)
      .update({ contact_id: primaryId, updated_at: now })

    // 6. sms_messages: update contact_id
    await trx('sms_messages')
      .where('contact_id', secondaryId)
      .where('organization_id', orgId)
      .update({ contact_id: primaryId })

    // 7. customer_activities: update entity_id
    await trx('customer_activities')
      .where('entity_id', secondaryId)
      .where('organization_id', orgId)
      .update({ entity_id: primaryId })

    // 8. customer_tag_assignments: update entity_id, skip if tag already on primary
    const secondaryTags = await trx('customer_tag_assignments')
      .where('entity_id', secondaryId)
      .where('organization_id', orgId)

    const primaryTags = await trx('customer_tag_assignments')
      .where('entity_id', primaryId)
      .where('organization_id', orgId)
      .select('tag_id')

    const primaryTagIds = new Set(primaryTags.map((t: any) => t.tag_id))

    for (const tag of secondaryTags) {
      if (primaryTagIds.has(tag.tag_id)) {
        // Duplicate tag — just delete the secondary assignment
        await trx('customer_tag_assignments').where('id', tag.id).del()
      } else {
        await trx('customer_tag_assignments')
          .where('id', tag.id)
          .update({ entity_id: primaryId })
      }
    }

    // 9. sequence_enrollments: update contact_id, skip if already enrolled in same sequence
    const secondaryEnrollments = await trx('sequence_enrollments')
      .where('contact_id', secondaryId)
      .where('organization_id', orgId)

    const primaryEnrollments = await trx('sequence_enrollments')
      .where('contact_id', primaryId)
      .where('organization_id', orgId)
      .whereIn('status', ['active'])
      .select('sequence_id')

    const primarySequenceIds = new Set(primaryEnrollments.map((e: any) => e.sequence_id))

    for (const enrollment of secondaryEnrollments) {
      if (primarySequenceIds.has(enrollment.sequence_id) && enrollment.status === 'active') {
        // Already enrolled — mark secondary as completed to avoid duplicates
        await trx('sequence_enrollments')
          .where('id', enrollment.id)
          .update({ status: 'completed', contact_id: primaryId })
      } else {
        await trx('sequence_enrollments')
          .where('id', enrollment.id)
          .update({ contact_id: primaryId })
      }
    }

    // 10. engagement_events: update contact_id
    await trx('engagement_events')
      .where('contact_id', secondaryId)
      .where('organization_id', orgId)
      .update({ contact_id: primaryId })

    // 11. contact_engagement_scores: add secondary score to primary, delete secondary
    const secondaryScore = await trx('contact_engagement_scores')
      .where('contact_id', secondaryId)
      .first()

    if (secondaryScore) {
      const primaryScore = await trx('contact_engagement_scores')
        .where('contact_id', primaryId)
        .first()

      if (primaryScore) {
        await trx('contact_engagement_scores')
          .where('contact_id', primaryId)
          .update({
            score: (primaryScore.score || 0) + (secondaryScore.score || 0),
            updated_at: now,
          })
        // Secondary score was folded into primary — remove it
        await trx('contact_engagement_scores')
          .where('contact_id', secondaryId)
          .del()
      } else {
        // Move score record to primary
        await trx('contact_engagement_scores')
          .where('contact_id', secondaryId)
          .update({ contact_id: primaryId, updated_at: now })
      }
    }

    // 12. Soft-delete the secondary contact (read display_name first for the log)
    const secondaryContact = await trx('customer_entities')
      .where('id', secondaryId)
      .first()

    await trx('customer_entities')
      .where('id', secondaryId)
      .where('organization_id', orgId)
      .update({ deleted_at: now, updated_at: now })

    // 13. Log merge as activity on the primary contact. display_name is
    // stored encrypted, so open it before it goes into the subject (it used
    // to embed the ciphertext), and encrypt the activity row: subject is an
    // encrypted-by-design column and this is a raw insert.
    const tenantId = secondaryContact?.tenant_id ? String(secondaryContact.tenant_id) : null
    let secondaryName = secondaryId
    if (secondaryContact && tenantId) {
      await decryptRowFields(null, CONTACT_ENTITY_KEY, [secondaryContact], ['display_name'], tenantId, orgId)
      const name = typeof secondaryContact.display_name === 'string' ? secondaryContact.display_name : ''
      if (name && name !== UNDECRYPTABLE_DISPLAY_TEXT) secondaryName = name
    }
    const activity = await encryptRowForRawWrite('customers:customer_activity', {
      id: require('crypto').randomUUID(),
      tenant_id: tenantId,
      organization_id: orgId,
      entity_id: primaryId,
      activity_type: 'contact_merged',
      subject: `Merged with ${secondaryName}`,
      created_at: now,
    }, tenantId, orgId)
    await trx('customer_activities').insert(activity)
  })

  return { merged: true, primaryId, secondaryId }
}
