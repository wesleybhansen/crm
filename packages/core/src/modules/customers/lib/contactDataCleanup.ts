import { randomUUID } from 'node:crypto'
import { CONTACT_DEPENDENT_ENTITY_TYPES } from './contactDependents'

// ORG-FILTER-EXEMPT-FILE: platform-wide repair script; every write targets ids selected above (optionally narrowed by --org/--tenant).
/**
 * One-off repairs after the MCP sweep (2026-09-25), run by
 * scripts/cleanup-contact-orphans.ts (bundled to /app/scripts/*.cjs). Both are
 * dry runs (counts only) unless `apply` is set.
 *
 * 1. cleanupOrphanedContactData: deleting a contact used to leave its tasks,
 *    legacy notes and reminders behind (listed, searchable, their search links
 *    pointing at a contact that no longer existed), and contacts removed by a
 *    soft delete (privacy anonymization) kept their comments and activities.
 *    Live rows whose contact is gone are removed: soft-deleted where the table
 *    has deleted_at (tasks, legacy notes, reminders, comments), hard-deleted
 *    otherwise (activities), and their search/query index entries dropped.
 *
 * 2. mergeLegacyNotesIntoComments: contact notes written to the old
 *    contact_notes table (MCP tool, notes API, card scans, debriefs, Stripe
 *    event payments) never showed on the contact's Notes tab, which reads
 *    customer_comments. Each live legacy note whose contact still exists is
 *    re-created as a comment (encrypted like any other comment, with its
 *    original author and timestamps) and the legacy row is soft-deleted in the
 *    same transaction, so nothing is shown twice and a re-run moves nothing.
 *    This is a script, not a migration: comment bodies are encrypted per
 *    tenant, which plain migration SQL cannot do.
 *
 * SQL uses `?` placeholders (the caller maps them to its driver). No `@/`
 * imports: bundled by esbuild.
 */

export type CleanupSql = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}
export type CleanupDb = CleanupSql & {
  transaction<T>(fn: (tx: CleanupSql) => Promise<T>): Promise<T>
}

export type CleanupScope = { organizationId?: string | null; tenantId?: string | null }

type ScopedRow = { id: string; organization_id: string; tenant_id: string }

async function tableExists(db: CleanupSql, table: string): Promise<boolean> {
  const rows = await db.query<{ ok: boolean }>(`select to_regclass(?) is not null as ok`, [table])
  return rows[0]?.ok === true
}

function scopeSql(scope: CleanupScope, alias: string): { sql: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []
  if (scope.organizationId) {
    parts.push(`${alias}.organization_id = ?`)
    params.push(scope.organizationId)
  }
  if (scope.tenantId) {
    parts.push(`${alias}.tenant_id = ?`)
    params.push(scope.tenantId)
  }
  return { sql: parts.length ? ` and ${parts.join(' and ')}` : '', params }
}

/** Rows of `table` whose `column` names no live contact. */
async function orphanRows(
  db: CleanupSql,
  table: string,
  column: string,
  scope: CleanupScope,
  opts: { softDeletable: boolean; extraSql?: string; extraParams?: unknown[] },
): Promise<ScopedRow[]> {
  if (!(await tableExists(db, table))) return []
  const s = scopeSql(scope, 't')
  return db.query<ScopedRow>(
    `select t.id, t.organization_id, t.tenant_id from ${table} t
      where t.${column} is not null
        ${opts.softDeletable ? 'and t.deleted_at is null' : ''}
        and not exists (select 1 from customer_entities ce where ce.id = t.${column} and ce.deleted_at is null)
        ${opts.extraSql ?? ''}${s.sql}`,
    [...(opts.extraParams ?? []), ...s.params],
  )
}

export type OrphanReport = {
  tasks: number
  notes: number
  reminders: number
  comments: number
  activities: number
  indexEntriesRemoved: number
  applied: boolean
}

const COMMENT_ENTITY_TYPE = 'customers:customer_comment'
const ACTIVITY_ENTITY_TYPE = 'customers:customer_activity'

async function removeIndexEntries(db: CleanupSql, entityType: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  let removed = 0
  const count = async (sql: string, params: unknown[]) =>
    Number((await db.query<{ n: string | number }>(`with d as (${sql} returning 1) select count(*) as n from d`, params))[0]?.n ?? 0)
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    if (await tableExists(db, 'entity_indexes')) {
      removed += await count(`delete from entity_indexes where entity_type = ? and entity_id = any(?::text[])`, [entityType, chunk])
    }
    if (await tableExists(db, 'search_tokens')) {
      removed += await count(`delete from search_tokens where entity_type = ? and entity_id = any(?::text[])`, [entityType, chunk])
    }
    if (await tableExists(db, 'vector_search')) {
      removed += await count(`delete from vector_search where entity_id = ? and record_id = any(?::text[])`, [entityType, chunk])
    }
  }
  return removed
}

/** Find (and with `apply`, remove) contact dependents whose contact is gone. */
export async function cleanupOrphanedContactData(
  db: CleanupDb,
  options: CleanupScope & { apply?: boolean } = {},
): Promise<OrphanReport> {
  const tasks = await orphanRows(db, 'tasks', 'contact_id', options, { softDeletable: true })
  const notes = await orphanRows(db, 'contact_notes', 'contact_id', options, { softDeletable: true })
  // Reminders on a contact that is gone, or on one of its orphaned tasks.
  // Reminders on a deal are not contact reminders and are left alone.
  const contactReminders = await orphanRows(db, 'reminders', 'entity_id', options, {
    softDeletable: true,
    extraSql: `and t.entity_type in ('contact', 'person', 'company')`,
  })
  const taskIds = tasks.map((r) => r.id)
  const taskReminders =
    taskIds.length && (await tableExists(db, 'reminders'))
      ? await db.query<ScopedRow>(
          `select t.id, t.organization_id, t.tenant_id from reminders t
            where t.deleted_at is null and t.entity_type = 'task' and t.entity_id::text = any(?::text[])`,
          [taskIds],
        )
      : []
  const reminders = [...new Map([...contactReminders, ...taskReminders].map((r) => [r.id, r])).values()]
  const comments = await orphanRows(db, 'customer_comments', 'entity_id', options, { softDeletable: true })
  const activities = await orphanRows(db, 'customer_activities', 'entity_id', options, { softDeletable: false })

  const report: OrphanReport = {
    tasks: tasks.length,
    notes: notes.length,
    reminders: reminders.length,
    comments: comments.length,
    activities: activities.length,
    indexEntriesRemoved: 0,
    applied: !!options.apply,
  }
  if (!options.apply) return report

  await db.transaction(async (tx) => {
    const now = new Date()
    const softDelete = async (table: string, rows: ScopedRow[]) => {
      for (let i = 0; i < rows.length; i += 500) {
        const ids = rows.slice(i, i + 500).map((r) => r.id)
        await tx.query(`update ${table} set deleted_at = ?, updated_at = ? where id = any(?::uuid[]) and deleted_at is null`, [now, now, ids])
      }
    }
    await softDelete('tasks', tasks)
    await softDelete('contact_notes', notes)
    await softDelete('reminders', reminders)
    await softDelete('customer_comments', comments)
    for (let i = 0; i < activities.length; i += 500) {
      const ids = activities.slice(i, i + 500).map((r) => r.id)
      await tx.query(`delete from customer_activities where id = any(?::uuid[])`, [ids])
    }
    report.indexEntriesRemoved += await removeIndexEntries(tx, CONTACT_DEPENDENT_ENTITY_TYPES.task, taskIds)
    report.indexEntriesRemoved += await removeIndexEntries(tx, CONTACT_DEPENDENT_ENTITY_TYPES.note, notes.map((r) => r.id))
    report.indexEntriesRemoved += await removeIndexEntries(tx, COMMENT_ENTITY_TYPE, comments.map((r) => r.id))
    report.indexEntriesRemoved += await removeIndexEntries(tx, ACTIVITY_ENTITY_TYPE, activities.map((r) => r.id))
  })
  return report
}

export type MergeReport = {
  legacyNotes: number
  merged: number
  skippedNoContact: number
  skippedEmpty: number
  applied: boolean
}

type LegacyNote = {
  id: string
  tenant_id: string
  organization_id: string
  contact_id: string
  content: string | null
  author_user_id: string | null
  created_at: Date
  updated_at: Date | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COMMENT_BODY_MAX = 50_000

/**
 * Encrypts a customer_comments row (snake_case columns) for its tenant and
 * organization, e.g. TenantDataEncryptionService.encryptEntityPayload for
 * 'customers:customer_comment' with requireMap. Must fail closed.
 */
export type EncryptCommentRow = (
  row: Record<string, unknown>,
  tenantId: string,
  organizationId: string,
) => Promise<Record<string, unknown>>

/** Move live contact_notes rows into customer_comments (dry run unless `apply`). */
export async function mergeLegacyNotesIntoComments(
  db: CleanupDb,
  encryptComment: EncryptCommentRow,
  options: CleanupScope & { apply?: boolean; batchSize?: number } = {},
): Promise<MergeReport> {
  const report: MergeReport = { legacyNotes: 0, merged: 0, skippedNoContact: 0, skippedEmpty: 0, applied: !!options.apply }
  if (!(await tableExists(db, 'contact_notes'))) return report
  const s = scopeSql(options, 'n')
  const notes = await db.query<LegacyNote & { contact_live: boolean }>(
    `select n.id, n.tenant_id, n.organization_id, n.contact_id, n.content, n.author_user_id, n.created_at, n.updated_at,
            exists (select 1 from customer_entities ce
                     where ce.id = n.contact_id and ce.organization_id = n.organization_id and ce.deleted_at is null) as contact_live
       from contact_notes n
      where n.deleted_at is null${s.sql}
      order by n.created_at asc, n.id asc`,
    s.params,
  )
  report.legacyNotes = notes.length
  const mergeable: LegacyNote[] = []
  for (const note of notes) {
    if (!note.contact_live) report.skippedNoContact += 1
    else if (!(note.content ?? '').trim()) report.skippedEmpty += 1
    else mergeable.push(note)
  }
  if (!options.apply) {
    report.merged = mergeable.length
    return report
  }

  const batchSize = options.batchSize ?? 200
  for (let i = 0; i < mergeable.length; i += batchSize) {
    const batch = mergeable.slice(i, i + batchSize)
    const rows: Array<Record<string, unknown>> = []
    for (const note of batch) {
      const createdAt = new Date(note.created_at)
      rows.push(
        await encryptComment(
          {
            id: randomUUID(),
            tenant_id: note.tenant_id,
            organization_id: note.organization_id,
            entity_id: note.contact_id,
            deal_id: null,
            body: String(note.content).slice(0, COMMENT_BODY_MAX),
            author_user_id: note.author_user_id && UUID_RE.test(note.author_user_id) ? note.author_user_id : null,
            created_at: createdAt,
            updated_at: note.updated_at ? new Date(note.updated_at) : createdAt,
          },
          note.tenant_id,
          note.organization_id,
        ),
      )
    }
    const moved = await db.transaction(async (tx) => {
      // Claim the legacy rows first: a concurrent or repeated run finds them
      // already soft-deleted and inserts nothing for them.
      const now = new Date()
      const claimed = await tx.query<{ id: string }>(
        `update contact_notes set deleted_at = ?, updated_at = ? where id = any(?::uuid[]) and deleted_at is null returning id`,
        [now, now, batch.map((n) => n.id)],
      )
      const claimedIds = new Set(claimed.map((r) => String(r.id)))
      let inserted = 0
      for (let j = 0; j < batch.length; j++) {
        if (!claimedIds.has(batch[j]!.id)) continue
        const row = rows[j]!
        await tx.query(
          `insert into customer_comments (id, tenant_id, organization_id, entity_id, deal_id, body, author_user_id, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.id, row.tenant_id, row.organization_id, row.entity_id, row.deal_id, row.body, row.author_user_id, row.created_at, row.updated_at],
        )
        inserted += 1
      }
      return inserted
    })
    report.merged += moved
  }
  return report
}
