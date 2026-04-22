/**
 * Source tagging helper — assigns a `source:<category>:<detail>` tag to a
 * contact/company so every entity carries attribution metadata.
 *
 * Design:
 * - Reuses the existing customer_tags + customer_tag_assignments tables —
 *   no new schema. Tags are stored as regular tag rows with a reserved
 *   slug prefix of `source-`.
 * - Idempotent: calling twice with the same args is a no-op (ON CONFLICT).
 * - Fails silently. Attribution is best-effort — never crash a create flow
 *   because a tag didn't land.
 */

import type { Knex } from 'knex'
import crypto from 'node:crypto'

export type SourceCategory =
  | 'manual'
  | 'api'
  | 'ai_assistant'
  | 'voice'
  | 'landing'
  | 'form'
  | 'booking'
  | 'course'
  | 'import'
  | 'inbox'
  | 'chat'
  | 'survey'
  | 'referral'
  | 'event'
  | 'photo_scan'
  | 'purchase'
  | 'customer'

type Scope = { tenantId: string; organizationId: string }

function buildTagIdentity(category: SourceCategory, detail?: string): { slug: string; label: string } {
  const safeDetail = detail ? detail.trim().slice(0, 80) : ''
  const slug = safeDetail
    ? `source-${category}-${safeDetail.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100)}`
    : `source-${category}`
  const label = safeDetail
    ? `source:${category}:${safeDetail}`
    : `source:${category}`
  return { slug, label }
}

/**
 * Ensure a source tag exists and is assigned to the given contact.
 * Safe to call repeatedly — tag + assignment both use ON CONFLICT DO NOTHING.
 */
export async function tagContactSource(
  knex: Knex,
  scope: Scope,
  contactId: string,
  category: SourceCategory,
  detail?: string,
): Promise<void> {
  if (!contactId) return
  const { slug, label } = buildTagIdentity(category, detail)
  try {
    // Upsert the tag row (idempotent via slug unique constraint)
    const existing = await knex('customer_tags')
      .where('organization_id', scope.organizationId)
      .where('tenant_id', scope.tenantId)
      .where('slug', slug)
      .first()
    let tagId = existing?.id as string | undefined
    if (!tagId) {
      tagId = crypto.randomUUID()
      await knex('customer_tags').insert({
        id: tagId,
        organization_id: scope.organizationId,
        tenant_id: scope.tenantId,
        slug,
        label,
        color: '#6366F1',
        description: 'Auto-assigned source attribution tag',
        created_at: new Date(),
        updated_at: new Date(),
      }).onConflict(['organization_id', 'tenant_id', 'slug']).ignore()
      // Re-read in case of race
      if (!tagId) {
        const row = await knex('customer_tags')
          .where('organization_id', scope.organizationId)
          .where('tenant_id', scope.tenantId)
          .where('slug', slug)
          .first()
        tagId = row?.id
      }
    }
    if (!tagId) return

    await knex('customer_tag_assignments').insert({
      id: crypto.randomUUID(),
      organization_id: scope.organizationId,
      tenant_id: scope.tenantId,
      tag_id: tagId,
      entity_id: contactId,
      created_at: new Date(),
    }).onConflict(['tag_id', 'entity_id']).ignore()
  } catch (err) {
    // Fail silently — attribution should never break the main flow.
    console.warn('[sourceTagging] failed to tag contact', contactId, category, detail, err instanceof Error ? err.message : err)
  }
}
