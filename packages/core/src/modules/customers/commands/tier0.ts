/**
 * Tier 0 commands for the SPEC-061 mercato rebuild.
 *
 * Why this is one consolidated file (deviation from per-entity-file convention):
 * tier 0 promotes 9 entities at once and they're simpler than the existing
 * customers commands (no addresses, no nested custom fields, no complex
 * linking). Putting them in one file keeps the migration PR diff focused.
 * Tier 0 retrospective decides whether to split per-entity later.
 *
 * Compared to commands/people.ts and commands/comments.ts, this file omits:
 *   - buildLog audit-log entries (can be added in follow-up)
 *   - Custom field handling (tier 0 entities don't expose custom fields)
 *   - Cross-entity tag/address sync (tier 0 entities aren't taggable)
 *
 * What it KEEPS from the canonical pattern (the load-bearing parts):
 *   - Tenant + organization scope enforcement on every read and write
 *   - emitCrudSideEffects on every write (drives query index, events, cache)
 *   - emitCrudUndoSideEffects on every undo
 *   - Snapshot capture for delete (so undo can recreate the row)
 *   - Snapshot capture for update (so undo can restore prior values)
 *   - Type-safe registerCommand wiring
 *
 * Engagement events and contact_open_times are append-only — they have
 * create commands only (no update/delete) and no undo.
 *
 * Business profile is 1:1 with org and is functionally upsert-only — it has
 * an upsert command and no delete.
 */

import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { emitCrudSideEffects, emitCrudUndoSideEffects, requireId } from '@open-mercato/shared/lib/commands/helpers'
import { ensureOrganizationScope, ensureTenantScope } from '@open-mercato/shared/lib/commands/scope'
import { extractUndoPayload } from '@open-mercato/shared/lib/commands/undo'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { CrudIndexerConfig, CrudEventsConfig } from '@open-mercato/shared/lib/crud/types'
import { E } from '#generated/entities.ids.generated'
import {
  CustomerTask,
  CustomerContactNote,
  CustomerContactAttachment,
  CustomerContactEngagementScore,
  CustomerEngagementEvent,
  CustomerContactOpenTime,
  CustomerReminder,
  CustomerTaskTemplate,
  CustomerBusinessProfile,
} from '../data/entities'
import {
  taskCreateSchema,
  taskUpdateSchema,
  type TaskCreateInput,
  type TaskUpdateInput,
  contactNoteCreateSchema,
  contactNoteUpdateSchema,
  type ContactNoteCreateInput,
  type ContactNoteUpdateInput,
  contactAttachmentCreateSchema,
  type ContactAttachmentCreateInput,
  reminderCreateSchema,
  reminderUpdateSchema,
  type ReminderCreateInput,
  type ReminderUpdateInput,
  taskTemplateCreateSchema,
  taskTemplateUpdateSchema,
  type TaskTemplateCreateInput,
  type TaskTemplateUpdateInput,
  engagementEventCreateSchema,
  type EngagementEventCreateInput,
  contactOpenTimeCreateSchema,
  type ContactOpenTimeCreateInput,
  businessProfileUpsertSchema,
  type BusinessProfileUpsertInput,
} from '../data/validators'

// ---------------------------------------------------------------------------
// Indexer + event configs (one per entity)
// ---------------------------------------------------------------------------

const taskIndexer: CrudIndexerConfig<CustomerTask> = { entityType: E.customers.customer_task }
const taskEvents: CrudEventsConfig = {
  module: 'customers',
  entity: 'task',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const noteIndexer: CrudIndexerConfig<CustomerContactNote> = { entityType: E.customers.customer_contact_note }
const noteEvents: CrudEventsConfig = {
  module: 'customers',
  entity: 'note',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const attachmentIndexer: CrudIndexerConfig<CustomerContactAttachment> = { entityType: E.customers.customer_contact_attachment }
const attachmentEvents: CrudEventsConfig = {
  module: 'customers',
  entity: 'attachment',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const engagementEventIndexer: CrudIndexerConfig<CustomerEngagementEvent> = { entityType: E.customers.customer_engagement_event }
const engagementEventEvents: CrudEventsConfig = {
  module: 'customers',
  entity: 'engagement',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const openTimeIndexer: CrudIndexerConfig<CustomerContactOpenTime> = { entityType: E.customers.customer_contact_open_time }

const reminderIndexer: CrudIndexerConfig<CustomerReminder> = { entityType: E.customers.customer_reminder }
const reminderEvents: CrudEventsConfig = {
  module: 'customers',
  entity: 'reminder',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const taskTemplateIndexer: CrudIndexerConfig<CustomerTaskTemplate> = { entityType: E.customers.customer_task_template }
const taskTemplateEvents: CrudEventsConfig = {
  module: 'customers',
  entity: 'task_template',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const businessProfileIndexer: CrudIndexerConfig<CustomerBusinessProfile> = { entityType: E.customers.customer_business_profile }
const businessProfileEvents: CrudEventsConfig = {
  module: 'customers',
  entity: 'business_profile',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

// ---------------------------------------------------------------------------
// Snapshot helpers — captured before update/delete so undo can restore
// ---------------------------------------------------------------------------

type TaskSnapshot = {
  id: string
  tenantId: string
  organizationId: string
  title: string
  description: string | null
  contactId: string | null
  dealId: string | null
  dueDate: Date | null
  isDone: boolean
  completedAt: Date | null
}

async function loadTaskSnapshot(em: EntityManager, id: string): Promise<TaskSnapshot | null> {
  const task = await em.findOne(CustomerTask, { id, deletedAt: null })
  if (!task) return null
  return {
    id: task.id,
    tenantId: task.tenantId,
    organizationId: task.organizationId,
    title: task.title,
    description: task.description ?? null,
    contactId: task.contactId ?? null,
    dealId: task.dealId ?? null,
    dueDate: task.dueDate ?? null,
    isDone: task.isDone,
    completedAt: task.completedAt ?? null,
  }
}

type NoteSnapshot = {
  id: string
  tenantId: string
  organizationId: string
  contactId: string
  content: string
  authorUserId: string | null
}

async function loadNoteSnapshot(em: EntityManager, id: string): Promise<NoteSnapshot | null> {
  const note = await em.findOne(CustomerContactNote, { id, deletedAt: null })
  if (!note) return null
  return {
    id: note.id,
    tenantId: note.tenantId,
    organizationId: note.organizationId,
    contactId: note.contactId,
    content: note.content,
    authorUserId: note.authorUserId ?? null,
  }
}

type AttachmentSnapshot = {
  id: string
  tenantId: string
  organizationId: string
  contactId: string
  filename: string
  fileUrl: string
  fileSize: number
  mimeType: string | null
  uploadedBy: string | null
}

async function loadAttachmentSnapshot(em: EntityManager, id: string): Promise<AttachmentSnapshot | null> {
  const att = await em.findOne(CustomerContactAttachment, { id, deletedAt: null })
  if (!att) return null
  return {
    id: att.id,
    tenantId: att.tenantId,
    organizationId: att.organizationId,
    contactId: att.contactId,
    filename: att.filename,
    fileUrl: att.fileUrl,
    fileSize: att.fileSize,
    mimeType: att.mimeType ?? null,
    uploadedBy: att.uploadedBy ?? null,
  }
}

type ReminderSnapshot = {
  id: string
  tenantId: string
  organizationId: string
  userId: string
  entityType: string
  entityId: string
  message: string
  remindAt: Date
  sent: boolean
  sentAt: Date | null
}

async function loadReminderSnapshot(em: EntityManager, id: string): Promise<ReminderSnapshot | null> {
  const r = await em.findOne(CustomerReminder, { id, deletedAt: null })
  if (!r) return null
  return {
    id: r.id,
    tenantId: r.tenantId,
    organizationId: r.organizationId,
    userId: r.userId,
    entityType: r.entityType,
    entityId: r.entityId,
    message: r.message,
    remindAt: r.remindAt,
    sent: r.sent,
    sentAt: r.sentAt ?? null,
  }
}

type TaskTemplateSnapshot = {
  id: string
  tenantId: string
  organizationId: string
  name: string
  description: string | null
  triggerType: string
  triggerConfig: Record<string, unknown> | null
  tasks: unknown[]
}

async function loadTaskTemplateSnapshot(em: EntityManager, id: string): Promise<TaskTemplateSnapshot | null> {
  const t = await em.findOne(CustomerTaskTemplate, { id, deletedAt: null })
  if (!t) return null
  return {
    id: t.id,
    tenantId: t.tenantId,
    organizationId: t.organizationId,
    name: t.name,
    description: t.description ?? null,
    triggerType: t.triggerType,
    triggerConfig: (t.triggerConfig ?? null) as Record<string, unknown> | null,
    tasks: t.tasks ?? [],
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

type TaskUndoPayload = { before?: TaskSnapshot | null; after?: TaskSnapshot | null }

const createTaskCommand: CommandHandler<TaskCreateInput, { taskId: string }> = {
  id: 'customers.tasks.create',
  async execute(rawInput, ctx) {
    const parsed = taskCreateSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const task = em.create(CustomerTask, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      title: parsed.title,
      description: parsed.description ?? null,
      contactId: parsed.contactId ?? null,
      dealId: parsed.dealId ?? null,
      dueDate: parsed.dueDate ?? null,
      isDone: parsed.isDone ?? false,
      completedAt: parsed.completedAt ?? null,
    })
    em.persist(task)
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de,
      action: 'created',
      entity: task,
      identifiers: { id: task.id, organizationId: task.organizationId, tenantId: task.tenantId },
      indexer: taskIndexer,
      events: taskEvents,
    })
    return { taskId: task.id }
  },
  captureAfter: async (_input, result, ctx) => {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return await loadTaskSnapshot(em, result.taskId)
  },
  buildLog: async ({ result, snapshots }) => ({
    actionLabel: 'Create task',
    resourceKind: 'customers.task',
    resourceId: result.taskId,
    tenantId: (snapshots.after as TaskSnapshot | undefined)?.tenantId ?? null,
    organizationId: (snapshots.after as TaskSnapshot | undefined)?.organizationId ?? null,
    snapshotAfter: snapshots.after ?? null,
    payload: { undo: { after: snapshots.after ?? null } satisfies TaskUndoPayload },
  }),
  undo: async ({ logEntry, ctx }) => {
    const id = logEntry?.resourceId ?? null
    if (!id) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const task = await em.findOne(CustomerTask, { id })
    if (task) {
      em.remove(task)
      await em.flush()
    }
  },
}

const updateTaskCommand: CommandHandler<TaskUpdateInput, { taskId: string }> = {
  id: 'customers.tasks.update',
  async prepare(rawInput, ctx) {
    const parsed = taskUpdateSchema.parse(rawInput)
    const em = ctx.container.resolve('em') as EntityManager
    const snapshot = await loadTaskSnapshot(em, parsed.id)
    return snapshot ? { before: snapshot } : {}
  },
  async execute(rawInput, ctx) {
    const parsed = taskUpdateSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const task = await em.findOne(CustomerTask, { id: parsed.id, deletedAt: null })
    if (!task) throw new CrudHttpError(404, { error: 'Task not found' })
    ensureTenantScope(ctx, task.tenantId)
    ensureOrganizationScope(ctx, task.organizationId)
    if (parsed.title !== undefined) task.title = parsed.title
    if (parsed.description !== undefined) task.description = parsed.description ?? null
    if (parsed.contactId !== undefined) task.contactId = parsed.contactId ?? null
    if (parsed.dealId !== undefined) task.dealId = parsed.dealId ?? null
    if (parsed.dueDate !== undefined) task.dueDate = parsed.dueDate ?? null
    if (parsed.isDone !== undefined) {
      task.isDone = parsed.isDone
      task.completedAt = parsed.isDone ? new Date() : null
    }
    if (parsed.completedAt !== undefined) task.completedAt = parsed.completedAt ?? null
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de,
      action: 'updated',
      entity: task,
      identifiers: { id: task.id, organizationId: task.organizationId, tenantId: task.tenantId },
      indexer: taskIndexer,
      events: taskEvents,
    })
    return { taskId: task.id }
  },
  captureAfter: async (_input, result, ctx) => {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return await loadTaskSnapshot(em, result.taskId)
  },
  buildLog: async ({ snapshots }) => {
    const before = snapshots.before as TaskSnapshot | undefined
    if (!before) return null
    return {
      actionLabel: 'Update task',
      resourceKind: 'customers.task',
      resourceId: before.id,
      tenantId: before.tenantId,
      organizationId: before.organizationId,
      snapshotBefore: before,
      snapshotAfter: snapshots.after ?? null,
      payload: {
        undo: { before, after: snapshots.after ?? null } satisfies TaskUndoPayload,
      },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<TaskUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const task = await em.findOne(CustomerTask, { id: before.id })
    if (!task) return
    task.title = before.title
    task.description = before.description
    task.contactId = before.contactId
    task.dealId = before.dealId
    task.dueDate = before.dueDate
    task.isDone = before.isDone
    task.completedAt = before.completedAt
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudUndoSideEffects({
      dataEngine: de,
      action: 'updated',
      entity: task,
      identifiers: { id: task.id, organizationId: task.organizationId, tenantId: task.tenantId },
      indexer: taskIndexer,
      events: taskEvents,
    })
  },
}

const deleteTaskCommand: CommandHandler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, { taskId: string }> = {
  id: 'customers.tasks.delete',
  async prepare(input, ctx) {
    const id = requireId(input, 'Task id required')
    const em = ctx.container.resolve('em') as EntityManager
    const snapshot = await loadTaskSnapshot(em, id)
    return snapshot ? { before: snapshot } : {}
  },
  async execute(input, ctx) {
    const id = requireId(input, 'Task id required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const task = await em.findOne(CustomerTask, { id, deletedAt: null })
    if (!task) throw new CrudHttpError(404, { error: 'Task not found' })
    ensureTenantScope(ctx, task.tenantId)
    ensureOrganizationScope(ctx, task.organizationId)
    task.deletedAt = new Date()
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de,
      action: 'deleted',
      entity: task,
      identifiers: { id: task.id, organizationId: task.organizationId, tenantId: task.tenantId },
      indexer: taskIndexer,
      events: taskEvents,
    })
    return { taskId: task.id }
  },
  buildLog: async ({ snapshots }) => {
    const before = snapshots.before as TaskSnapshot | undefined
    if (!before) return null
    return {
      actionLabel: 'Delete task',
      resourceKind: 'customers.task',
      resourceId: before.id,
      tenantId: before.tenantId,
      organizationId: before.organizationId,
      snapshotBefore: before,
      payload: { undo: { before } satisfies TaskUndoPayload },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<TaskUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const task = await em.findOne(CustomerTask, { id: before.id })
    if (task) {
      task.deletedAt = null
      await em.flush()
      const de = ctx.container.resolve('dataEngine') as DataEngine
      await emitCrudUndoSideEffects({
        dataEngine: de,
        action: 'deleted',
        entity: task,
        identifiers: { id: task.id, organizationId: task.organizationId, tenantId: task.tenantId },
        indexer: taskIndexer,
        events: taskEvents,
      })
    }
  },
}

// ---------------------------------------------------------------------------
// Contact notes
// ---------------------------------------------------------------------------

type NoteUndoPayload = { before?: NoteSnapshot | null; after?: NoteSnapshot | null }

const createNoteCommand: CommandHandler<ContactNoteCreateInput, { noteId: string }> = {
  id: 'customers.notes.create',
  async execute(rawInput, ctx) {
    const parsed = contactNoteCreateSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const note = em.create(CustomerContactNote, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      contactId: parsed.contactId,
      content: parsed.content,
      authorUserId: parsed.authorUserId ?? ctx.auth?.sub ?? null,
    })
    em.persist(note)
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de,
      action: 'created',
      entity: note,
      identifiers: { id: note.id, organizationId: note.organizationId, tenantId: note.tenantId },
      indexer: noteIndexer,
      events: noteEvents,
    })
    return { noteId: note.id }
  },
  captureAfter: async (_input, result, ctx) => {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return await loadNoteSnapshot(em, result.noteId)
  },
  buildLog: async ({ result, snapshots }) => ({
    actionLabel: 'Create contact note',
    resourceKind: 'customers.note',
    resourceId: result.noteId,
    tenantId: (snapshots.after as NoteSnapshot | undefined)?.tenantId ?? null,
    organizationId: (snapshots.after as NoteSnapshot | undefined)?.organizationId ?? null,
    snapshotAfter: snapshots.after ?? null,
    payload: { undo: { after: snapshots.after ?? null } satisfies NoteUndoPayload },
  }),
  undo: async ({ logEntry, ctx }) => {
    const id = logEntry?.resourceId ?? null
    if (!id) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const note = await em.findOne(CustomerContactNote, { id })
    if (note) {
      em.remove(note)
      await em.flush()
    }
  },
}

const updateNoteCommand: CommandHandler<ContactNoteUpdateInput, { noteId: string }> = {
  id: 'customers.notes.update',
  async prepare(rawInput, ctx) {
    const parsed = contactNoteUpdateSchema.parse(rawInput)
    const em = ctx.container.resolve('em') as EntityManager
    const snapshot = await loadNoteSnapshot(em, parsed.id)
    return snapshot ? { before: snapshot } : {}
  },
  async execute(rawInput, ctx) {
    const parsed = contactNoteUpdateSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const note = await em.findOne(CustomerContactNote, { id: parsed.id, deletedAt: null })
    if (!note) throw new CrudHttpError(404, { error: 'Note not found' })
    ensureTenantScope(ctx, note.tenantId)
    ensureOrganizationScope(ctx, note.organizationId)
    if (parsed.content !== undefined) note.content = parsed.content
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de,
      action: 'updated',
      entity: note,
      identifiers: { id: note.id, organizationId: note.organizationId, tenantId: note.tenantId },
      indexer: noteIndexer,
      events: noteEvents,
    })
    return { noteId: note.id }
  },
  captureAfter: async (_input, result, ctx) => {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return await loadNoteSnapshot(em, result.noteId)
  },
  buildLog: async ({ snapshots }) => {
    const before = snapshots.before as NoteSnapshot | undefined
    if (!before) return null
    return {
      actionLabel: 'Update contact note',
      resourceKind: 'customers.note',
      resourceId: before.id,
      tenantId: before.tenantId,
      organizationId: before.organizationId,
      snapshotBefore: before,
      snapshotAfter: snapshots.after ?? null,
      payload: { undo: { before, after: snapshots.after ?? null } satisfies NoteUndoPayload },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<NoteUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const note = await em.findOne(CustomerContactNote, { id: before.id })
    if (!note) return
    note.content = before.content
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudUndoSideEffects({
      dataEngine: de,
      action: 'updated',
      entity: note,
      identifiers: { id: note.id, organizationId: note.organizationId, tenantId: note.tenantId },
      indexer: noteIndexer,
      events: noteEvents,
    })
  },
}

const deleteNoteCommand: CommandHandler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, { noteId: string }> = {
  id: 'customers.notes.delete',
  async prepare(input, ctx) {
    const id = requireId(input, 'Note id required')
    const em = ctx.container.resolve('em') as EntityManager
    const snapshot = await loadNoteSnapshot(em, id)
    return snapshot ? { before: snapshot } : {}
  },
  async execute(input, ctx) {
    const id = requireId(input, 'Note id required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const note = await em.findOne(CustomerContactNote, { id, deletedAt: null })
    if (!note) throw new CrudHttpError(404, { error: 'Note not found' })
    ensureTenantScope(ctx, note.tenantId)
    ensureOrganizationScope(ctx, note.organizationId)
    note.deletedAt = new Date()
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de,
      action: 'deleted',
      entity: note,
      identifiers: { id: note.id, organizationId: note.organizationId, tenantId: note.tenantId },
      indexer: noteIndexer,
      events: noteEvents,
    })
    return { noteId: note.id }
  },
  buildLog: async ({ snapshots }) => {
    const before = snapshots.before as NoteSnapshot | undefined
    if (!before) return null
    return {
      actionLabel: 'Delete contact note',
      resourceKind: 'customers.note',
      resourceId: before.id,
      tenantId: before.tenantId,
      organizationId: before.organizationId,
      snapshotBefore: before,
      payload: { undo: { before } satisfies NoteUndoPayload },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<NoteUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const note = await em.findOne(CustomerContactNote, { id: before.id })
    if (note) {
      note.deletedAt = null
      await em.flush()
      const de = ctx.container.resolve('dataEngine') as DataEngine
      await emitCrudUndoSideEffects({
        dataEngine: de,
        action: 'deleted',
        entity: note,
        identifiers: { id: note.id, organizationId: note.organizationId, tenantId: note.tenantId },
        indexer: noteIndexer,
        events: noteEvents,
      })
    }
  },
}

// ---------------------------------------------------------------------------
// Contact attachments — create + delete only (no update; replace by delete+create)
// ---------------------------------------------------------------------------

type AttachmentUndoPayload = { before?: AttachmentSnapshot | null; after?: AttachmentSnapshot | null }

const createAttachmentCommand: CommandHandler<ContactAttachmentCreateInput, { attachmentId: string }> = {
  id: 'customers.attachments.create',
  async execute(rawInput, ctx) {
    const parsed = contactAttachmentCreateSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const att = em.create(CustomerContactAttachment, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      contactId: parsed.contactId,
      filename: parsed.filename,
      fileUrl: parsed.fileUrl,
      fileSize: parsed.fileSize ?? 0,
      mimeType: parsed.mimeType ?? null,
      uploadedBy: parsed.uploadedBy ?? ctx.auth?.sub ?? null,
    })
    em.persist(att)
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de,
      action: 'created',
      entity: att,
      identifiers: { id: att.id, organizationId: att.organizationId, tenantId: att.tenantId },
      indexer: attachmentIndexer,
      events: attachmentEvents,
    })
    return { attachmentId: att.id }
  },
  captureAfter: async (_input, result, ctx) => {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return await loadAttachmentSnapshot(em, result.attachmentId)
  },
  buildLog: async ({ result, snapshots }) => ({
    actionLabel: 'Upload contact attachment',
    resourceKind: 'customers.attachment',
    resourceId: result.attachmentId,
    tenantId: (snapshots.after as AttachmentSnapshot | undefined)?.tenantId ?? null,
    organizationId: (snapshots.after as AttachmentSnapshot | undefined)?.organizationId ?? null,
    snapshotAfter: snapshots.after ?? null,
    payload: { undo: { after: snapshots.after ?? null } satisfies AttachmentUndoPayload },
  }),
  undo: async ({ logEntry, ctx }) => {
    const id = logEntry?.resourceId ?? null
    if (!id) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const att = await em.findOne(CustomerContactAttachment, { id })
    if (att) {
      em.remove(att)
      await em.flush()
    }
  },
}

const deleteAttachmentCommand: CommandHandler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, { attachmentId: string }> = {
  id: 'customers.attachments.delete',
  async prepare(input, ctx) {
    const id = requireId(input, 'Attachment id required')
    const em = ctx.container.resolve('em') as EntityManager
    const snapshot = await loadAttachmentSnapshot(em, id)
    return snapshot ? { before: snapshot } : {}
  },
  async execute(input, ctx) {
    const id = requireId(input, 'Attachment id required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const att = await em.findOne(CustomerContactAttachment, { id, deletedAt: null })
    if (!att) throw new CrudHttpError(404, { error: 'Attachment not found' })
    ensureTenantScope(ctx, att.tenantId)
    ensureOrganizationScope(ctx, att.organizationId)
    att.deletedAt = new Date()
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de,
      action: 'deleted',
      entity: att,
      identifiers: { id: att.id, organizationId: att.organizationId, tenantId: att.tenantId },
      indexer: attachmentIndexer,
      events: attachmentEvents,
    })
    return { attachmentId: att.id }
  },
  buildLog: async ({ snapshots }) => {
    const before = snapshots.before as AttachmentSnapshot | undefined
    if (!before) return null
    return {
      actionLabel: 'Delete contact attachment',
      resourceKind: 'customers.attachment',
      resourceId: before.id,
      tenantId: before.tenantId,
      organizationId: before.organizationId,
      snapshotBefore: before,
      payload: { undo: { before } satisfies AttachmentUndoPayload },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<AttachmentUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const att = await em.findOne(CustomerContactAttachment, { id: before.id })
    if (att) {
      att.deletedAt = null
      await em.flush()
      const de = ctx.container.resolve('dataEngine') as DataEngine
      await emitCrudUndoSideEffects({
        dataEngine: de,
        action: 'deleted',
        entity: att,
        identifiers: { id: att.id, organizationId: att.organizationId, tenantId: att.tenantId },
        indexer: attachmentIndexer,
        events: attachmentEvents,
      })
    }
  },
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

type ReminderUndoPayload = { before?: ReminderSnapshot | null; after?: ReminderSnapshot | null }

const createReminderCommand: CommandHandler<ReminderCreateInput, { reminderId: string }> = {
  id: 'customers.reminders.create',
  async execute(rawInput, ctx) {
    const parsed = reminderCreateSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const r = em.create(CustomerReminder, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      userId: parsed.userId,
      entityType: parsed.entityType,
      entityId: parsed.entityId,
      message: parsed.message,
      remindAt: parsed.remindAt,
      sent: false,
      sentAt: null,
    })
    em.persist(r)
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de,
      action: 'created',
      entity: r,
      identifiers: { id: r.id, organizationId: r.organizationId, tenantId: r.tenantId },
      indexer: reminderIndexer,
      events: reminderEvents,
    })
    return { reminderId: r.id }
  },
  captureAfter: async (_input, result, ctx) => {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return await loadReminderSnapshot(em, result.reminderId)
  },
  buildLog: async ({ result, snapshots }) => ({
    actionLabel: 'Create reminder',
    resourceKind: 'customers.reminder',
    resourceId: result.reminderId,
    tenantId: (snapshots.after as ReminderSnapshot | undefined)?.tenantId ?? null,
    organizationId: (snapshots.after as ReminderSnapshot | undefined)?.organizationId ?? null,
    snapshotAfter: snapshots.after ?? null,
    payload: { undo: { after: snapshots.after ?? null } satisfies ReminderUndoPayload },
  }),
  undo: async ({ logEntry, ctx }) => {
    const id = logEntry?.resourceId ?? null
    if (!id) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const r = await em.findOne(CustomerReminder, { id })
    if (r) {
      em.remove(r)
      await em.flush()
    }
  },
}

const updateReminderCommand: CommandHandler<ReminderUpdateInput, { reminderId: string }> = {
  id: 'customers.reminders.update',
  async prepare(rawInput, ctx) {
    const parsed = reminderUpdateSchema.parse(rawInput)
    const em = ctx.container.resolve('em') as EntityManager
    const snapshot = await loadReminderSnapshot(em, parsed.id)
    return snapshot ? { before: snapshot } : {}
  },
  async execute(rawInput, ctx) {
    const parsed = reminderUpdateSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const r = await em.findOne(CustomerReminder, { id: parsed.id, deletedAt: null })
    if (!r) throw new CrudHttpError(404, { error: 'Reminder not found' })
    ensureTenantScope(ctx, r.tenantId)
    ensureOrganizationScope(ctx, r.organizationId)
    if (parsed.message !== undefined) r.message = parsed.message
    if (parsed.remindAt !== undefined) r.remindAt = parsed.remindAt
    if (parsed.sent !== undefined) {
      r.sent = parsed.sent
      if (parsed.sent && r.sentAt == null) r.sentAt = new Date()
      if (!parsed.sent) r.sentAt = null
    }
    if (parsed.sentAt !== undefined) r.sentAt = parsed.sentAt ?? null
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de,
      action: 'updated',
      entity: r,
      identifiers: { id: r.id, organizationId: r.organizationId, tenantId: r.tenantId },
      indexer: reminderIndexer,
      events: reminderEvents,
    })
    return { reminderId: r.id }
  },
  captureAfter: async (_input, result, ctx) => {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return await loadReminderSnapshot(em, result.reminderId)
  },
  buildLog: async ({ snapshots }) => {
    const before = snapshots.before as ReminderSnapshot | undefined
    if (!before) return null
    return {
      actionLabel: 'Update reminder',
      resourceKind: 'customers.reminder',
      resourceId: before.id,
      tenantId: before.tenantId,
      organizationId: before.organizationId,
      snapshotBefore: before,
      snapshotAfter: snapshots.after ?? null,
      payload: { undo: { before, after: snapshots.after ?? null } satisfies ReminderUndoPayload },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<ReminderUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const r = await em.findOne(CustomerReminder, { id: before.id })
    if (!r) return
    r.message = before.message
    r.remindAt = before.remindAt
    r.sent = before.sent
    r.sentAt = before.sentAt
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudUndoSideEffects({
      dataEngine: de,
      action: 'updated',
      entity: r,
      identifiers: { id: r.id, organizationId: r.organizationId, tenantId: r.tenantId },
      indexer: reminderIndexer,
      events: reminderEvents,
    })
  },
}

const deleteReminderCommand: CommandHandler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, { reminderId: string }> = {
  id: 'customers.reminders.delete',
  async prepare(input, ctx) {
    const id = requireId(input, 'Reminder id required')
    const em = ctx.container.resolve('em') as EntityManager
    const snapshot = await loadReminderSnapshot(em, id)
    return snapshot ? { before: snapshot } : {}
  },
  async execute(input, ctx) {
    const id = requireId(input, 'Reminder id required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const r = await em.findOne(CustomerReminder, { id, deletedAt: null })
    if (!r) throw new CrudHttpError(404, { error: 'Reminder not found' })
    ensureTenantScope(ctx, r.tenantId)
    ensureOrganizationScope(ctx, r.organizationId)
    r.deletedAt = new Date()
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de,
      action: 'deleted',
      entity: r,
      identifiers: { id: r.id, organizationId: r.organizationId, tenantId: r.tenantId },
      indexer: reminderIndexer,
      events: reminderEvents,
    })
    return { reminderId: r.id }
  },
  buildLog: async ({ snapshots }) => {
    const before = snapshots.before as ReminderSnapshot | undefined
    if (!before) return null
    return {
      actionLabel: 'Delete reminder',
      resourceKind: 'customers.reminder',
      resourceId: before.id,
      tenantId: before.tenantId,
      organizationId: before.organizationId,
      snapshotBefore: before,
      payload: { undo: { before } satisfies ReminderUndoPayload },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<ReminderUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const r = await em.findOne(CustomerReminder, { id: before.id })
    if (r) {
      r.deletedAt = null
      await em.flush()
      const de = ctx.container.resolve('dataEngine') as DataEngine
      await emitCrudUndoSideEffects({
        dataEngine: de,
        action: 'deleted',
        entity: r,
        identifiers: { id: r.id, organizationId: r.organizationId, tenantId: r.tenantId },
        indexer: reminderIndexer,
        events: reminderEvents,
      })
    }
  },
}

// ---------------------------------------------------------------------------
// Task templates
// ---------------------------------------------------------------------------

type TaskTemplateUndoPayload = { before?: TaskTemplateSnapshot | null; after?: TaskTemplateSnapshot | null }

const createTaskTemplateCommand: CommandHandler<TaskTemplateCreateInput, { taskTemplateId: string }> = {
  id: 'customers.task_templates.create',
  async execute(rawInput, ctx) {
    const parsed = taskTemplateCreateSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const t = em.create(CustomerTaskTemplate, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      name: parsed.name,
      description: parsed.description ?? null,
      triggerType: parsed.triggerType ?? 'manual',
      triggerConfig: parsed.triggerConfig ?? null,
      tasks: parsed.tasks ?? [],
    })
    em.persist(t)
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de,
      action: 'created',
      entity: t,
      identifiers: { id: t.id, organizationId: t.organizationId, tenantId: t.tenantId },
      indexer: taskTemplateIndexer,
      events: taskTemplateEvents,
    })
    return { taskTemplateId: t.id }
  },
  captureAfter: async (_input, result, ctx) => {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return await loadTaskTemplateSnapshot(em, result.taskTemplateId)
  },
  buildLog: async ({ result, snapshots }) => ({
    actionLabel: 'Create task template',
    resourceKind: 'customers.task_template',
    resourceId: result.taskTemplateId,
    tenantId: (snapshots.after as TaskTemplateSnapshot | undefined)?.tenantId ?? null,
    organizationId: (snapshots.after as TaskTemplateSnapshot | undefined)?.organizationId ?? null,
    snapshotAfter: snapshots.after ?? null,
    payload: { undo: { after: snapshots.after ?? null } satisfies TaskTemplateUndoPayload },
  }),
  undo: async ({ logEntry, ctx }) => {
    const id = logEntry?.resourceId ?? null
    if (!id) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const t = await em.findOne(CustomerTaskTemplate, { id })
    if (t) {
      em.remove(t)
      await em.flush()
    }
  },
}

const updateTaskTemplateCommand: CommandHandler<TaskTemplateUpdateInput, { taskTemplateId: string }> = {
  id: 'customers.task_templates.update',
  async prepare(rawInput, ctx) {
    const parsed = taskTemplateUpdateSchema.parse(rawInput)
    const em = ctx.container.resolve('em') as EntityManager
    const snapshot = await loadTaskTemplateSnapshot(em, parsed.id)
    return snapshot ? { before: snapshot } : {}
  },
  async execute(rawInput, ctx) {
    const parsed = taskTemplateUpdateSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const t = await em.findOne(CustomerTaskTemplate, { id: parsed.id, deletedAt: null })
    if (!t) throw new CrudHttpError(404, { error: 'Task template not found' })
    ensureTenantScope(ctx, t.tenantId)
    ensureOrganizationScope(ctx, t.organizationId)
    if (parsed.name !== undefined) t.name = parsed.name
    if (parsed.description !== undefined) t.description = parsed.description ?? null
    if (parsed.triggerType !== undefined) t.triggerType = parsed.triggerType
    if (parsed.triggerConfig !== undefined) t.triggerConfig = parsed.triggerConfig ?? null
    if (parsed.tasks !== undefined) t.tasks = parsed.tasks
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de,
      action: 'updated',
      entity: t,
      identifiers: { id: t.id, organizationId: t.organizationId, tenantId: t.tenantId },
      indexer: taskTemplateIndexer,
      events: taskTemplateEvents,
    })
    return { taskTemplateId: t.id }
  },
  captureAfter: async (_input, result, ctx) => {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return await loadTaskTemplateSnapshot(em, result.taskTemplateId)
  },
  buildLog: async ({ snapshots }) => {
    const before = snapshots.before as TaskTemplateSnapshot | undefined
    if (!before) return null
    return {
      actionLabel: 'Update task template',
      resourceKind: 'customers.task_template',
      resourceId: before.id,
      tenantId: before.tenantId,
      organizationId: before.organizationId,
      snapshotBefore: before,
      snapshotAfter: snapshots.after ?? null,
      payload: { undo: { before, after: snapshots.after ?? null } satisfies TaskTemplateUndoPayload },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<TaskTemplateUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const t = await em.findOne(CustomerTaskTemplate, { id: before.id })
    if (!t) return
    t.name = before.name
    t.description = before.description
    t.triggerType = before.triggerType
    t.triggerConfig = before.triggerConfig
    t.tasks = before.tasks
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudUndoSideEffects({
      dataEngine: de,
      action: 'updated',
      entity: t,
      identifiers: { id: t.id, organizationId: t.organizationId, tenantId: t.tenantId },
      indexer: taskTemplateIndexer,
      events: taskTemplateEvents,
    })
  },
}

const deleteTaskTemplateCommand: CommandHandler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, { taskTemplateId: string }> = {
  id: 'customers.task_templates.delete',
  async prepare(input, ctx) {
    const id = requireId(input, 'Task template id required')
    const em = ctx.container.resolve('em') as EntityManager
    const snapshot = await loadTaskTemplateSnapshot(em, id)
    return snapshot ? { before: snapshot } : {}
  },
  async execute(input, ctx) {
    const id = requireId(input, 'Task template id required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const t = await em.findOne(CustomerTaskTemplate, { id, deletedAt: null })
    if (!t) throw new CrudHttpError(404, { error: 'Task template not found' })
    ensureTenantScope(ctx, t.tenantId)
    ensureOrganizationScope(ctx, t.organizationId)
    t.deletedAt = new Date()
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de,
      action: 'deleted',
      entity: t,
      identifiers: { id: t.id, organizationId: t.organizationId, tenantId: t.tenantId },
      indexer: taskTemplateIndexer,
      events: taskTemplateEvents,
    })
    return { taskTemplateId: t.id }
  },
  buildLog: async ({ snapshots }) => {
    const before = snapshots.before as TaskTemplateSnapshot | undefined
    if (!before) return null
    return {
      actionLabel: 'Delete task template',
      resourceKind: 'customers.task_template',
      resourceId: before.id,
      tenantId: before.tenantId,
      organizationId: before.organizationId,
      snapshotBefore: before,
      payload: { undo: { before } satisfies TaskTemplateUndoPayload },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<TaskTemplateUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const t = await em.findOne(CustomerTaskTemplate, { id: before.id })
    if (t) {
      t.deletedAt = null
      await em.flush()
      const de = ctx.container.resolve('dataEngine') as DataEngine
      await emitCrudUndoSideEffects({
        dataEngine: de,
        action: 'deleted',
        entity: t,
        identifiers: { id: t.id, organizationId: t.organizationId, tenantId: t.tenantId },
        indexer: taskTemplateIndexer,
        events: taskTemplateEvents,
      })
    }
  },
}

// ---------------------------------------------------------------------------
// Engagement events — append-only, no undo. Engagement scores upserted as a
// side effect of the same command (so the score stays in sync).
// ---------------------------------------------------------------------------

const trackEngagementCommand: CommandHandler<EngagementEventCreateInput, { eventId: string; score: number }> = {
  id: 'customers.engagement.track',
  async execute(rawInput, ctx) {
    const parsed = engagementEventCreateSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const event = em.create(CustomerEngagementEvent, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      contactId: parsed.contactId,
      eventType: parsed.eventType,
      points: parsed.points,
      metadata: parsed.metadata ?? null,
    })
    em.persist(event)

    let score = await em.findOne(CustomerContactEngagementScore, { contactId: parsed.contactId })
    if (!score) {
      score = em.create(CustomerContactEngagementScore, {
        tenantId: parsed.tenantId,
        organizationId: parsed.organizationId,
        contactId: parsed.contactId,
        score: parsed.points,
        lastActivityAt: new Date(),
      })
      em.persist(score)
    } else {
      ensureTenantScope(ctx, score.tenantId)
      ensureOrganizationScope(ctx, score.organizationId)
      score.score = score.score + parsed.points
      score.lastActivityAt = new Date()
    }

    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de,
      action: 'created',
      entity: event,
      identifiers: { id: event.id, organizationId: event.organizationId, tenantId: event.tenantId },
      indexer: engagementEventIndexer,
      events: engagementEventEvents,
    })
    return { eventId: event.id, score: score.score }
  },
}

const trackOpenTimeCommand: CommandHandler<ContactOpenTimeCreateInput, { openTimeId: string }> = {
  id: 'customers.engagement.track_open_time',
  async execute(rawInput, ctx) {
    const parsed = contactOpenTimeCreateSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const ot = em.create(CustomerContactOpenTime, {
      tenantId: parsed.tenantId,
      contactId: parsed.contactId,
      organizationId: parsed.organizationId,
      hourOfDay: parsed.hourOfDay,
      dayOfWeek: parsed.dayOfWeek,
      openedAt: parsed.openedAt,
    })
    em.persist(ot)
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de,
      action: 'created',
      entity: ot,
      identifiers: { id: ot.id, organizationId: ot.organizationId, tenantId: ot.tenantId },
      indexer: openTimeIndexer,
    })
    return { openTimeId: ot.id }
  },
}

// ---------------------------------------------------------------------------
// Engagement score — direct set (admin override; bypasses event-driven track)
// ---------------------------------------------------------------------------

const setEngagementScoreCommand: CommandHandler<
  { tenantId: string; organizationId: string; contactId: string; score: number },
  { contactId: string; score: number }
> = {
  id: 'customers.engagement.set_score',
  async execute(input, ctx) {
    ensureTenantScope(ctx, input.tenantId)
    ensureOrganizationScope(ctx, input.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let score = await em.findOne(CustomerContactEngagementScore, { contactId: input.contactId })
    if (!score) {
      score = em.create(CustomerContactEngagementScore, {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        contactId: input.contactId,
        score: input.score,
        lastActivityAt: new Date(),
      })
      em.persist(score)
    } else {
      ensureTenantScope(ctx, score.tenantId)
      ensureOrganizationScope(ctx, score.organizationId)
      score.score = input.score
      score.lastActivityAt = new Date()
    }
    await em.flush()
    return { contactId: score.contactId, score: score.score }
  },
}

// ---------------------------------------------------------------------------
// Business profile — upsert (1:1 with org)
// ---------------------------------------------------------------------------

const upsertBusinessProfileCommand: CommandHandler<BusinessProfileUpsertInput, { businessProfileId: string }> = {
  id: 'customers.business_profile.upsert',
  async execute(rawInput, ctx) {
    const parsed = businessProfileUpsertSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let bp = await em.findOne(CustomerBusinessProfile, { organizationId: parsed.organizationId })
    const isCreate = !bp
    if (!bp) {
      bp = em.create(CustomerBusinessProfile, {
        tenantId: parsed.tenantId,
        organizationId: parsed.organizationId,
      })
      em.persist(bp)
    } else {
      ensureTenantScope(ctx, bp.tenantId)
    }
    const fields: (keyof BusinessProfileUpsertInput)[] = [
      'businessName', 'businessType', 'businessDescription', 'mainOffer', 'idealClients',
      'teamSize', 'aiPersonaName', 'aiPersonaStyle', 'aiCustomInstructions', 'websiteUrl',
      'pipelineMode', 'digestFrequency', 'digestDay', 'emailIntakeMode', 'interfaceMode',
      'onboardingComplete', 'brandVoiceUpdatedAt', 'brandVoiceSource',
    ]
    for (const f of fields) {
      if (parsed[f] !== undefined) (bp as any)[f] = parsed[f] ?? null
    }
    if (parsed.clientSources !== undefined) bp.clientSources = (parsed.clientSources ?? null) as unknown[] | null
    if (parsed.pipelineStages !== undefined) bp.pipelineStages = (parsed.pipelineStages ?? null) as unknown[] | null
    if (parsed.brandColors !== undefined) bp.brandColors = (parsed.brandColors ?? null) as Record<string, unknown> | null
    if (parsed.socialLinks !== undefined) bp.socialLinks = (parsed.socialLinks ?? null) as Record<string, unknown> | null
    if (parsed.detectedServices !== undefined) bp.detectedServices = parsed.detectedServices ?? null
    if (parsed.brandVoiceProfile !== undefined) bp.brandVoiceProfile = (parsed.brandVoiceProfile ?? null) as Record<string, unknown> | null
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de,
      action: isCreate ? 'created' : 'updated',
      entity: bp,
      identifiers: { id: bp.id, organizationId: bp.organizationId, tenantId: bp.tenantId },
      indexer: businessProfileIndexer,
      events: businessProfileEvents,
    })
    return { businessProfileId: bp.id }
  },
}

// ---------------------------------------------------------------------------
// Register all commands
// ---------------------------------------------------------------------------

registerCommand(createTaskCommand)
registerCommand(updateTaskCommand)
registerCommand(deleteTaskCommand)
registerCommand(createNoteCommand)
registerCommand(updateNoteCommand)
registerCommand(deleteNoteCommand)
registerCommand(createAttachmentCommand)
registerCommand(deleteAttachmentCommand)
registerCommand(createReminderCommand)
registerCommand(updateReminderCommand)
registerCommand(deleteReminderCommand)
registerCommand(createTaskTemplateCommand)
registerCommand(updateTaskTemplateCommand)
registerCommand(deleteTaskTemplateCommand)
registerCommand(trackEngagementCommand)
registerCommand(trackOpenTimeCommand)
registerCommand(setEngagementScoreCommand)
registerCommand(upsertBusinessProfileCommand)
