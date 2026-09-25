import type { Knex } from 'knex'
import { COMMENT_ENTITY_KEY, decryptRowFields } from '@open-mercato/shared/lib/encryption/decryptRows'
import { encryptRowForRawWrite } from '@open-mercato/shared/lib/encryption/rawWrite'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

/**
 * Contact notes have ONE home: `customer_comments` (CustomerComment), the
 * table the contact page's Notes tab reads. The older `contact_notes` table
 * (CustomerContactNote) was written by the MCP tool, the notes API, card
 * scans, meeting debriefs and Stripe payments, so those notes never showed on
 * the contact (MCP sweep 2026-09-25). Every writer now writes a comment;
 * readers still include live legacy rows until
 * `node /app/scripts/cleanup-contact-orphans.cjs --phase notes --execute` has
 * moved them (it soft-deletes each legacy row it moves, so nothing shows twice).
 */

export type ContactNote = {
  id: string
  contact_id: string
  content: string
  author_user_id: string | null
  created_at: Date | string
  source: 'comment' | 'legacy'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Scope = { tenantId: string | null | undefined; organizationId: string }

/** A contact's notes, newest first: comments plus not-yet-merged legacy notes. */
export async function listContactNotes(
  knex: Knex,
  em: unknown,
  contactId: string,
  scope: Scope,
  limit = 10,
): Promise<ContactNote[]> {
  const comments = await knex('customer_comments')
    .where('entity_id', contactId)
    .where('organization_id', scope.organizationId)
    .whereNull('deleted_at')
    .orderBy('created_at', 'desc')
    .limit(limit)
    .select('id', 'entity_id', 'body', 'author_user_id', 'created_at')
  await decryptRowFields(em, COMMENT_ENTITY_KEY, comments, ['body'], scope.tenantId, scope.organizationId)
  const legacy = await knex('contact_notes')
    .where('contact_id', contactId)
    .where('organization_id', scope.organizationId)
    .whereNull('deleted_at')
    .orderBy('created_at', 'desc')
    .limit(limit)
    .select('id', 'contact_id', 'content', 'author_user_id', 'created_at')
    .catch(() => [] as Array<Record<string, unknown>>)
  const notes: ContactNote[] = [
    ...comments.map((c: Record<string, any>) => ({
      id: String(c.id),
      contact_id: String(c.entity_id),
      content: String(c.body ?? ''),
      author_user_id: (c.author_user_id as string | null) ?? null,
      created_at: c.created_at,
      source: 'comment' as const,
    })),
    ...legacy.map((n: Record<string, any>) => ({
      id: String(n.id),
      contact_id: String(n.contact_id),
      content: String(n.content ?? ''),
      author_user_id: (n.author_user_id as string | null) ?? null,
      created_at: n.created_at,
      source: 'legacy' as const,
    })),
  ]
  notes.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  return notes.slice(0, limit)
}

/** Notes per contact since a date (comments plus unmerged legacy notes). */
export async function countContactNotesSince(
  knex: Knex,
  contactIds: string[],
  organizationId: string,
  since: Date,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  if (contactIds.length === 0) return counts
  const comments = await knex('customer_comments')
    .whereIn('entity_id', contactIds)
    .where('organization_id', organizationId)
    .whereNull('deleted_at')
    .where('created_at', '>=', since)
    .groupBy('entity_id')
    .select('entity_id as contact_id')
    .count('* as cnt')
  const legacy = await knex('contact_notes')
    .whereIn('contact_id', contactIds)
    .where('organization_id', organizationId)
    .whereNull('deleted_at')
    .where('created_at', '>=', since)
    .groupBy('contact_id')
    .select('contact_id')
    .count('* as cnt')
    .catch(() => [] as Array<Record<string, unknown>>)
  for (const row of [...comments, ...legacy] as Array<{ contact_id: string; cnt: unknown }>) {
    counts[row.contact_id] = (counts[row.contact_id] || 0) + Number(row.cnt)
  }
  return counts
}

/** Add a note to a contact (a customer comment, encrypted like the ORM write). */
export async function insertContactNote(
  knex: Knex,
  em: unknown,
  input: {
    contactId: string
    organizationId: string
    tenantId: string
    content: string
    authorUserId?: string | null
    createdAt?: Date
  },
): Promise<string> {
  const id = require('crypto').randomUUID() as string
  const at = input.createdAt ?? new Date()
  const row = await encryptRowForRawWrite(
    COMMENT_ENTITY_KEY,
    {
      id,
      tenant_id: input.tenantId,
      organization_id: input.organizationId,
      entity_id: input.contactId,
      deal_id: null,
      body: input.content,
      author_user_id: input.authorUserId && UUID.test(input.authorUserId) ? input.authorUserId : null,
      created_at: at,
      updated_at: at,
    },
    input.tenantId,
    input.organizationId,
    em,
  )
  await knex('customer_comments').insert(row)
  // Index it like the ORM command does, so the Notes tab (served from the
  // query index when coverage is complete) lists it straight away.
  try {
    const container = await createRequestContainer()
    const bus = container.resolve('eventBus') as { emitEvent?: (event: string, payload: unknown) => Promise<void> } | null
    await bus?.emitEvent?.('query_index.upsert_one', {
      entityType: COMMENT_ENTITY_KEY,
      recordId: id,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      crudAction: 'created',
    })
  } catch {
    // The index catches up on its next coverage check; never fail the write.
  }
  return id
}
