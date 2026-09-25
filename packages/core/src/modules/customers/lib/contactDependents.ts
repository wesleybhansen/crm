import type { EntityManager } from '@mikro-orm/postgresql'

/**
 * Rows that hang off a contact by a plain `contact_id` / `entity_id` column
 * (no foreign key), so deleting the contact used to leave them behind: its
 * tasks, legacy contact notes and reminders stayed listed and searchable, and
 * their search links pointed at a contact that no longer existed (MCP sweep
 * 2026-09-25). Comments, activities, addresses, tags and to-do links are
 * already removed by the contact delete commands.
 *
 * Deleting a person or company now soft-deletes these too (and drops their
 * search index entries); undoing the delete restores exactly the rows it
 * removed. A privacy erasure hard-deletes all of them instead
 * (purgeContactDependents), and the org-wide GDPR purge deletes the tables
 * outright. Rows orphaned before this existed are repaired by
 * scripts/cleanup-contact-orphans.ts.
 */
export type ContactDependentIds = {
  taskIds: string[]
  noteIds: string[]
  reminderIds: string[]
}

export const CONTACT_DEPENDENT_ENTITY_TYPES = {
  task: 'customers:customer_task',
  note: 'customers:customer_contact_note',
} as const

type Scope = { tenantId: string; organizationId: string }

export function emptyContactDependents(): ContactDependentIds {
  return { taskIds: [], noteIds: [], reminderIds: [] }
}

async function liveIds(em: EntityManager, table: string, column: string, values: string[], scope: Scope): Promise<string[]> {
  if (values.length === 0) return []
  const rows = (await em
    .getKnex()(table)
    .select('id')
    .whereIn(column, values)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .whereNull('deleted_at')) as Array<{ id: string }>
  return rows.map((row) => String(row.id))
}

/** The live (not yet deleted) dependents of one contact, in its own org. */
export async function findContactDependents(em: EntityManager, contactId: string, scope: Scope): Promise<ContactDependentIds> {
  const taskIds = await liveIds(em, 'tasks', 'contact_id', [contactId], scope)
  const noteIds = await liveIds(em, 'contact_notes', 'contact_id', [contactId], scope)
  // Reminders point at the contact itself or at one of its tasks.
  const reminderIds = await liveIds(em, 'reminders', 'entity_id', [contactId, ...taskIds], scope)
  return { taskIds, noteIds, reminderIds }
}

async function setDeletedAt(em: EntityManager, table: string, ids: string[], scope: Scope, deletedAt: Date | null): Promise<number> {
  if (ids.length === 0) return 0
  const query = em
    .getKnex()(table)
    .whereIn('id', ids)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
  const scoped = deletedAt ? query.whereNull('deleted_at') : query.whereNotNull('deleted_at')
  return Number(await scoped.update({ deleted_at: deletedAt, updated_at: new Date() }))
}

/** Soft-delete the given dependents. Returns how many rows changed per kind. */
export async function softDeleteContactDependents(
  em: EntityManager,
  ids: ContactDependentIds,
  scope: Scope,
  at: Date = new Date(),
): Promise<{ tasks: number; notes: number; reminders: number }> {
  return {
    tasks: await setDeletedAt(em, 'tasks', ids.taskIds, scope, at),
    notes: await setDeletedAt(em, 'contact_notes', ids.noteIds, scope, at),
    reminders: await setDeletedAt(em, 'reminders', ids.reminderIds, scope, at),
  }
}

/** Undo: bring back exactly the dependents a contact delete removed. */
export async function restoreContactDependents(em: EntityManager, ids: ContactDependentIds | null | undefined, scope: Scope): Promise<void> {
  if (!ids) return
  await setDeletedAt(em, 'tasks', ids.taskIds ?? [], scope, null)
  await setDeletedAt(em, 'contact_notes', ids.noteIds ?? [], scope, null)
  await setDeletedAt(em, 'reminders', ids.reminderIds ?? [], scope, null)
}

/** Query-index (and search) entries to drop or restore for these dependents. */
export function contactDependentIndexEntries(
  ids: ContactDependentIds | null | undefined,
  scope: Scope,
): Array<{ entityType: string; recordId: string; tenantId: string; organizationId: string }> {
  if (!ids) return []
  return [
    ...(ids.taskIds ?? []).map((recordId) => ({ entityType: CONTACT_DEPENDENT_ENTITY_TYPES.task, recordId, ...scope })),
    ...(ids.noteIds ?? []).map((recordId) => ({ entityType: CONTACT_DEPENDENT_ENTITY_TYPES.note, recordId, ...scope })),
  ]
}

export type ContactPurgeCounts = {
  tasks: number
  notes: number
  reminders: number
  comments: number
  activities: number
  indexEntries: number
}

/**
 * Privacy erasure: HARD-delete everything hanging off these contacts (tasks,
 * legacy notes, reminders on the contact or its tasks, comments, activities)
 * and their search/query index entries. Scoped to one organization. Unlike
 * the undoable delete above, nothing is kept to restore. Tables missing in a
 * given database are skipped.
 */
export async function purgeContactDependents(
  em: EntityManager,
  contactIds: string[],
  scope: Scope,
): Promise<ContactPurgeCounts> {
  const counts: ContactPurgeCounts = { tasks: 0, notes: 0, reminders: 0, comments: 0, activities: 0, indexEntries: 0 }
  if (contactIds.length === 0) return counts
  const knex = em.getKnex()
  const exists = async (table: string) => {
    const res = (await knex.raw('select to_regclass(?) is not null as ok', [table])) as { rows?: Array<{ ok: boolean }> }
    return res.rows?.[0]?.ok === true
  }
  const scoped = (table: string) => knex(table).where('organization_id', scope.organizationId).where('tenant_id', scope.tenantId)
  const idsOf = async (table: string, column: string, values: string[]) =>
    values.length && (await exists(table))
      ? ((await scoped(table).whereIn(column, values).select('id')) as Array<{ id: string }>).map((r) => String(r.id))
      : []

  const taskIds = await idsOf('tasks', 'contact_id', contactIds)
  const noteIds = await idsOf('contact_notes', 'contact_id', contactIds)
  const reminderIds = await idsOf('reminders', 'entity_id', [...contactIds, ...taskIds])
  const commentIds = await idsOf('customer_comments', 'entity_id', contactIds)
  const activityIds = await idsOf('customer_activities', 'entity_id', contactIds)

  const del = async (table: string, ids: string[]) => (ids.length ? Number(await scoped(table).whereIn('id', ids).del()) : 0)
  counts.reminders = await del('reminders', reminderIds)
  counts.tasks = await del('tasks', taskIds)
  counts.notes = await del('contact_notes', noteIds)
  counts.comments = await del('customer_comments', commentIds)
  counts.activities = await del('customer_activities', activityIds)

  const indexTargets: Array<[string, string[]]> = [
    [CONTACT_DEPENDENT_ENTITY_TYPES.task, taskIds],
    [CONTACT_DEPENDENT_ENTITY_TYPES.note, noteIds],
    ['customers:customer_comment', commentIds],
    ['customers:customer_activity', activityIds],
  ]
  for (const [entityType, ids] of indexTargets) {
    if (!ids.length) continue
    for (const table of ['entity_indexes', 'search_tokens'] as const) {
      if (await exists(table)) counts.indexEntries += Number(await knex(table).where('entity_type', entityType).whereIn('entity_id', ids).del())
    }
    if (await exists('vector_search')) {
      counts.indexEntries += Number(await knex('vector_search').where('entity_id', entityType).whereIn('record_id', ids).del())
    }
  }
  return counts
}
