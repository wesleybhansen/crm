/**
 * Tier 1 commands for the SPEC-061 mercato rebuild (email module).
 *
 * Pattern reference: packages/core/src/modules/customers/commands/tier0.ts
 *
 * Single consolidated file (deviation from per-entity-file convention) for
 * the same reason as tier 0: tier 1 promotes 14 entities at once and they're
 * mostly simpler than the existing email module's send pipeline. Tier 1
 * retrospective decides whether to split per-entity later.
 *
 * Compared to a "full" mercato command implementation, this file omits:
 *   - buildLog audit-log strings (the pattern is wired but the strings
 *     aren't translated — same trade-off as tier 0)
 *   - Custom field handling (tier 1 entities don't expose custom fields yet)
 *   - Cross-entity tag/address sync (no tagged entities in tier 1)
 *
 * What it KEEPS from the canonical pattern:
 *   - Tenant + organization scope enforcement on every read and write
 *   - emitCrudSideEffects on every write (drives query index, events, cache)
 *   - emitCrudUndoSideEffects on every undo
 *   - Snapshot capture for delete (so undo can recreate the row)
 *   - Snapshot capture for update (so undo can restore prior values)
 *   - Type-safe registerCommand wiring
 *
 * System-managed entities have minimal commands and no undo:
 *   - EmailMessage (created by send pipeline; only update for status)
 *   - EmailCampaignRecipient (created by send pipeline; updated by webhook)
 *   - EmailUnsubscribe (created by webhook only)
 *
 * Upsert-pattern entities (1:1 with parent — no create/delete distinction):
 *   - EspConnection (1:1 per provider per org)
 *   - EmailRouting (1:1 per purpose per org)
 *   - EmailPreference (1:1 per (contact, category) — opt in/out toggle)
 *   - EmailIntelligenceSettings (1:1 per (org, user))
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
import { E } from '@/.mercato/generated/entities.ids.generated'
import {
  EmailAccount,
  EmailMessage,
  EmailTemplate,
  EmailCampaign,
  EmailCampaignRecipient,
  EmailUnsubscribe,
  EmailPreferenceCategory,
  EmailPreference,
  EmailStyleTemplate,
  EmailConnection,
  EspConnection,
  EspSenderAddress,
  EmailList,
  EmailListMember,
  EmailRouting,
  EmailIntelligenceSettings,
} from '../data/schema'
import {
  emailAccountCreateSchema,
  emailAccountUpdateSchema,
  type EmailAccountCreateInput,
  type EmailAccountUpdateInput,
  emailTemplateCreateSchema,
  emailTemplateUpdateSchema,
  type EmailTemplateCreateInput,
  type EmailTemplateUpdateInput,
  emailCampaignCreateSchema,
  emailCampaignUpdateSchema,
  type EmailCampaignCreateInput,
  type EmailCampaignUpdateInput,
  emailPreferenceCategoryCreateSchema,
  emailPreferenceCategoryUpdateSchema,
  type EmailPreferenceCategoryCreateInput,
  type EmailPreferenceCategoryUpdateInput,
  emailPreferenceUpsertSchema,
  type EmailPreferenceUpsertInput,
  emailStyleTemplateCreateSchema,
  emailStyleTemplateUpdateSchema,
  type EmailStyleTemplateCreateInput,
  type EmailStyleTemplateUpdateInput,
  emailConnectionCreateSchema,
  emailConnectionUpdateSchema,
  type EmailConnectionCreateInput,
  type EmailConnectionUpdateInput,
  espConnectionUpsertSchema,
  type EspConnectionUpsertInput,
  espSenderAddressCreateSchema,
  espSenderAddressUpdateSchema,
  type EspSenderAddressCreateInput,
  type EspSenderAddressUpdateInput,
  emailListCreateSchema,
  emailListUpdateSchema,
  type EmailListCreateInput,
  type EmailListUpdateInput,
  emailListMemberCreateSchema,
  type EmailListMemberCreateInput,
  emailRoutingUpsertSchema,
  type EmailRoutingUpsertInput,
  emailIntelligenceSettingsUpsertSchema,
  type EmailIntelligenceSettingsUpsertInput,
} from '../data/validators'

// ---------------------------------------------------------------------------
// Indexer + event configs (one per entity)
// ---------------------------------------------------------------------------

const accountIndexer: CrudIndexerConfig<EmailAccount> = { entityType: E.email.email_account }
const accountEvents: CrudEventsConfig = {
  module: 'email',
  entity: 'account',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const templateIndexer: CrudIndexerConfig<EmailTemplate> = { entityType: E.email.email_template }
const templateEvents: CrudEventsConfig = {
  module: 'email',
  entity: 'template',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const campaignIndexer: CrudIndexerConfig<EmailCampaign> = { entityType: E.email.email_campaign }
const campaignEvents: CrudEventsConfig = {
  module: 'email',
  entity: 'campaign',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const prefCategoryIndexer: CrudIndexerConfig<EmailPreferenceCategory> = { entityType: E.email.email_preference_category }
const prefCategoryEvents: CrudEventsConfig = {
  module: 'email',
  entity: 'preference_category',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const preferenceIndexer: CrudIndexerConfig<EmailPreference> = { entityType: E.email.email_preference }
const preferenceEvents: CrudEventsConfig = {
  module: 'email',
  entity: 'preference',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const styleTemplateIndexer: CrudIndexerConfig<EmailStyleTemplate> = { entityType: E.email.email_style_template }
const styleTemplateEvents: CrudEventsConfig = {
  module: 'email',
  entity: 'style_template',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const connectionIndexer: CrudIndexerConfig<EmailConnection> = { entityType: E.email.email_connection }
const connectionEvents: CrudEventsConfig = {
  module: 'email',
  entity: 'connection',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const espConnectionIndexer: CrudIndexerConfig<EspConnection> = { entityType: E.email.esp_connection }
const espConnectionEvents: CrudEventsConfig = {
  module: 'email',
  entity: 'esp_connection',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const senderAddressIndexer: CrudIndexerConfig<EspSenderAddress> = { entityType: E.email.esp_sender_address }
const senderAddressEvents: CrudEventsConfig = {
  module: 'email',
  entity: 'sender_address',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const listIndexer: CrudIndexerConfig<EmailList> = { entityType: E.email.email_list }
const listEvents: CrudEventsConfig = {
  module: 'email',
  entity: 'list',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const listMemberIndexer: CrudIndexerConfig<EmailListMember> = { entityType: E.email.email_list_member }
const listMemberEvents: CrudEventsConfig = {
  module: 'email',
  entity: 'list_member',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const routingIndexer: CrudIndexerConfig<EmailRouting> = { entityType: E.email.email_routing }
const routingEvents: CrudEventsConfig = {
  module: 'email',
  entity: 'routing',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

const intelligenceIndexer: CrudIndexerConfig<EmailIntelligenceSettings> = { entityType: E.email.email_intelligence_settings }
const intelligenceEvents: CrudEventsConfig = {
  module: 'email',
  entity: 'intelligence',
  persistent: true,
  buildPayload: (ctx) => ({ id: ctx.identifiers.id, organizationId: ctx.identifiers.organizationId, tenantId: ctx.identifiers.tenantId }),
}

// ---------------------------------------------------------------------------
// EmailTemplate
// ---------------------------------------------------------------------------

type EmailTemplateSnapshot = {
  id: string
  tenantId: string
  organizationId: string
  name: string
  subject: string
  bodyHtml: string
  category: string
}

async function loadEmailTemplateSnapshot(em: EntityManager, id: string): Promise<EmailTemplateSnapshot | null> {
  const t = await em.findOne(EmailTemplate, { id, deletedAt: null })
  if (!t) return null
  return {
    id: t.id,
    tenantId: t.tenantId,
    organizationId: t.organizationId,
    name: t.name,
    subject: t.subject,
    bodyHtml: t.bodyHtml,
    category: t.category,
  }
}

type EmailTemplateUndoPayload = { before?: EmailTemplateSnapshot | null; after?: EmailTemplateSnapshot | null }

const createEmailTemplateCommand: CommandHandler<EmailTemplateCreateInput, { templateId: string }> = {
  id: 'email.templates.create',
  async execute(rawInput, ctx) {
    const parsed = emailTemplateCreateSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const t = em.create(EmailTemplate, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      name: parsed.name,
      subject: parsed.subject,
      bodyHtml: parsed.bodyHtml,
      category: parsed.category ?? 'transactional',
    })
    em.persist(t)
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'created', entity: t,
      identifiers: { id: t.id, organizationId: t.organizationId, tenantId: t.tenantId },
      indexer: templateIndexer, events: templateEvents,
    })
    return { templateId: t.id }
  },
  captureAfter: async (_input, result, ctx) => {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return await loadEmailTemplateSnapshot(em, result.templateId)
  },
  buildLog: async ({ result, snapshots }) => ({
    actionLabel: 'Create email template',
    resourceKind: 'email.template',
    resourceId: result.templateId,
    tenantId: (snapshots.after as EmailTemplateSnapshot | undefined)?.tenantId ?? null,
    organizationId: (snapshots.after as EmailTemplateSnapshot | undefined)?.organizationId ?? null,
    snapshotAfter: snapshots.after ?? null,
    payload: { undo: { after: snapshots.after ?? null } satisfies EmailTemplateUndoPayload },
  }),
  undo: async ({ logEntry, ctx }) => {
    const id = logEntry?.resourceId ?? null
    if (!id) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const t = await em.findOne(EmailTemplate, { id })
    if (t) { em.remove(t); await em.flush() }
  },
}

const updateEmailTemplateCommand: CommandHandler<EmailTemplateUpdateInput, { templateId: string }> = {
  id: 'email.templates.update',
  async prepare(rawInput, ctx) {
    const parsed = emailTemplateUpdateSchema.parse(rawInput)
    const em = ctx.container.resolve('em') as EntityManager
    const snapshot = await loadEmailTemplateSnapshot(em, parsed.id)
    return snapshot ? { before: snapshot } : {}
  },
  async execute(rawInput, ctx) {
    const parsed = emailTemplateUpdateSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const t = await em.findOne(EmailTemplate, { id: parsed.id, deletedAt: null })
    if (!t) throw new CrudHttpError(404, { error: 'Email template not found' })
    ensureTenantScope(ctx, t.tenantId)
    ensureOrganizationScope(ctx, t.organizationId)
    if (parsed.name !== undefined) t.name = parsed.name
    if (parsed.subject !== undefined) t.subject = parsed.subject
    if (parsed.bodyHtml !== undefined) t.bodyHtml = parsed.bodyHtml
    if (parsed.category !== undefined) t.category = parsed.category
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'updated', entity: t,
      identifiers: { id: t.id, organizationId: t.organizationId, tenantId: t.tenantId },
      indexer: templateIndexer, events: templateEvents,
    })
    return { templateId: t.id }
  },
  captureAfter: async (_input, result, ctx) => {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return await loadEmailTemplateSnapshot(em, result.templateId)
  },
  buildLog: async ({ snapshots }) => {
    const before = snapshots.before as EmailTemplateSnapshot | undefined
    if (!before) return null
    return {
      actionLabel: 'Update email template',
      resourceKind: 'email.template',
      resourceId: before.id,
      tenantId: before.tenantId, organizationId: before.organizationId,
      snapshotBefore: before, snapshotAfter: snapshots.after ?? null,
      payload: { undo: { before, after: snapshots.after ?? null } satisfies EmailTemplateUndoPayload },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<EmailTemplateUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const t = await em.findOne(EmailTemplate, { id: before.id })
    if (!t) return
    t.name = before.name
    t.subject = before.subject
    t.bodyHtml = before.bodyHtml
    t.category = before.category as 'transactional' | 'marketing' | 'sequence'
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudUndoSideEffects({
      dataEngine: de, action: 'updated', entity: t,
      identifiers: { id: t.id, organizationId: t.organizationId, tenantId: t.tenantId },
      indexer: templateIndexer, events: templateEvents,
    })
  },
}

const deleteEmailTemplateCommand: CommandHandler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, { templateId: string }> = {
  id: 'email.templates.delete',
  async prepare(input, ctx) {
    const id = requireId(input, 'Email template id required')
    const em = ctx.container.resolve('em') as EntityManager
    const snapshot = await loadEmailTemplateSnapshot(em, id)
    return snapshot ? { before: snapshot } : {}
  },
  async execute(input, ctx) {
    const id = requireId(input, 'Email template id required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const t = await em.findOne(EmailTemplate, { id, deletedAt: null })
    if (!t) throw new CrudHttpError(404, { error: 'Email template not found' })
    ensureTenantScope(ctx, t.tenantId)
    ensureOrganizationScope(ctx, t.organizationId)
    t.deletedAt = new Date()
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'deleted', entity: t,
      identifiers: { id: t.id, organizationId: t.organizationId, tenantId: t.tenantId },
      indexer: templateIndexer, events: templateEvents,
    })
    return { templateId: t.id }
  },
  buildLog: async ({ snapshots }) => {
    const before = snapshots.before as EmailTemplateSnapshot | undefined
    if (!before) return null
    return {
      actionLabel: 'Delete email template',
      resourceKind: 'email.template',
      resourceId: before.id,
      tenantId: before.tenantId, organizationId: before.organizationId,
      snapshotBefore: before,
      payload: { undo: { before } satisfies EmailTemplateUndoPayload },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<EmailTemplateUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const t = await em.findOne(EmailTemplate, { id: before.id })
    if (t) {
      t.deletedAt = null
      await em.flush()
      const de = ctx.container.resolve('dataEngine') as DataEngine
      await emitCrudUndoSideEffects({
        dataEngine: de, action: 'deleted', entity: t,
        identifiers: { id: t.id, organizationId: t.organizationId, tenantId: t.tenantId },
        indexer: templateIndexer, events: templateEvents,
      })
    }
  },
}

// ---------------------------------------------------------------------------
// EmailCampaign — full CRUD with snapshot+undo (mirrors EmailTemplate pattern)
// ---------------------------------------------------------------------------

type EmailCampaignSnapshot = {
  id: string
  tenantId: string
  organizationId: string
  name: string
  templateId: string | null
  subject: string | null
  bodyHtml: string | null
  status: string
  segmentFilter: Record<string, unknown> | null
  category: string | null
  scheduledAt: Date | null
  scheduledFor: Date | null
  stats: Record<string, unknown>
}

async function loadEmailCampaignSnapshot(em: EntityManager, id: string): Promise<EmailCampaignSnapshot | null> {
  const c = await em.findOne(EmailCampaign, { id, deletedAt: null })
  if (!c) return null
  return {
    id: c.id,
    tenantId: c.tenantId,
    organizationId: c.organizationId,
    name: c.name,
    templateId: c.templateId ?? null,
    subject: c.subject ?? null,
    bodyHtml: c.bodyHtml ?? null,
    status: c.status,
    segmentFilter: (c.segmentFilter ?? null) as Record<string, unknown> | null,
    category: c.category ?? null,
    scheduledAt: c.scheduledAt ?? null,
    scheduledFor: c.scheduledFor ?? null,
    stats: c.stats ?? {},
  }
}

type EmailCampaignUndoPayload = { before?: EmailCampaignSnapshot | null; after?: EmailCampaignSnapshot | null }

const createEmailCampaignCommand: CommandHandler<EmailCampaignCreateInput, { campaignId: string }> = {
  id: 'email.campaigns.create',
  async execute(rawInput, ctx) {
    const parsed = emailCampaignCreateSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const c = em.create(EmailCampaign, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      name: parsed.name,
      templateId: parsed.templateId ?? null,
      subject: parsed.subject ?? null,
      bodyHtml: parsed.bodyHtml ?? null,
      status: parsed.status ?? 'draft',
      segmentFilter: parsed.segmentFilter ?? null,
      category: parsed.category ?? null,
      scheduledAt: parsed.scheduledAt ?? null,
      scheduledFor: parsed.scheduledFor ?? null,
    })
    em.persist(c)
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'created', entity: c,
      identifiers: { id: c.id, organizationId: c.organizationId, tenantId: c.tenantId },
      indexer: campaignIndexer, events: campaignEvents,
    })
    return { campaignId: c.id }
  },
}

const updateEmailCampaignCommand: CommandHandler<EmailCampaignUpdateInput, { campaignId: string }> = {
  id: 'email.campaigns.update',
  async prepare(rawInput, ctx) {
    const parsed = emailCampaignUpdateSchema.parse(rawInput)
    const em = ctx.container.resolve('em') as EntityManager
    const snapshot = await loadEmailCampaignSnapshot(em, parsed.id)
    return snapshot ? { before: snapshot } : {}
  },
  async execute(rawInput, ctx) {
    const parsed = emailCampaignUpdateSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const c = await em.findOne(EmailCampaign, { id: parsed.id, deletedAt: null })
    if (!c) throw new CrudHttpError(404, { error: 'Campaign not found' })
    ensureTenantScope(ctx, c.tenantId)
    ensureOrganizationScope(ctx, c.organizationId)
    if (parsed.name !== undefined) c.name = parsed.name
    if (parsed.templateId !== undefined) c.templateId = parsed.templateId ?? null
    if (parsed.subject !== undefined) c.subject = parsed.subject ?? null
    if (parsed.bodyHtml !== undefined) c.bodyHtml = parsed.bodyHtml ?? null
    if (parsed.status !== undefined) c.status = parsed.status
    if (parsed.segmentFilter !== undefined) c.segmentFilter = parsed.segmentFilter ?? null
    if (parsed.category !== undefined) c.category = parsed.category ?? null
    if (parsed.scheduledAt !== undefined) c.scheduledAt = parsed.scheduledAt ?? null
    if (parsed.scheduledFor !== undefined) c.scheduledFor = parsed.scheduledFor ?? null
    if (parsed.stats !== undefined) c.stats = parsed.stats
    if (parsed.sentAt !== undefined) c.sentAt = parsed.sentAt ?? null
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'updated', entity: c,
      identifiers: { id: c.id, organizationId: c.organizationId, tenantId: c.tenantId },
      indexer: campaignIndexer, events: campaignEvents,
    })
    return { campaignId: c.id }
  },
}

const deleteEmailCampaignCommand: CommandHandler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, { campaignId: string }> = {
  id: 'email.campaigns.delete',
  async prepare(input, ctx) {
    const id = requireId(input, 'Campaign id required')
    const em = ctx.container.resolve('em') as EntityManager
    const snapshot = await loadEmailCampaignSnapshot(em, id)
    return snapshot ? { before: snapshot } : {}
  },
  async execute(input, ctx) {
    const id = requireId(input, 'Campaign id required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const c = await em.findOne(EmailCampaign, { id, deletedAt: null })
    if (!c) throw new CrudHttpError(404, { error: 'Campaign not found' })
    ensureTenantScope(ctx, c.tenantId)
    ensureOrganizationScope(ctx, c.organizationId)
    c.deletedAt = new Date()
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'deleted', entity: c,
      identifiers: { id: c.id, organizationId: c.organizationId, tenantId: c.tenantId },
      indexer: campaignIndexer, events: campaignEvents,
    })
    return { campaignId: c.id }
  },
}

// ---------------------------------------------------------------------------
// EmailStyleTemplate — compact create/update/delete
// ---------------------------------------------------------------------------

const createEmailStyleTemplateCommand: CommandHandler<EmailStyleTemplateCreateInput, { styleTemplateId: string }> = {
  id: 'email.style_templates.create',
  async execute(rawInput, ctx) {
    const parsed = emailStyleTemplateCreateSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const t = em.create(EmailStyleTemplate, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      name: parsed.name,
      category: parsed.category ?? 'general',
      htmlTemplate: parsed.htmlTemplate,
      thumbnailUrl: parsed.thumbnailUrl ?? null,
      isDefault: parsed.isDefault ?? false,
      createdBy: parsed.createdBy ?? ctx.auth?.sub ?? null,
    })
    em.persist(t)
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'created', entity: t,
      identifiers: { id: t.id, organizationId: t.organizationId, tenantId: t.tenantId },
      indexer: styleTemplateIndexer, events: styleTemplateEvents,
    })
    return { styleTemplateId: t.id }
  },
}

const updateEmailStyleTemplateCommand: CommandHandler<EmailStyleTemplateUpdateInput, { styleTemplateId: string }> = {
  id: 'email.style_templates.update',
  async execute(rawInput, ctx) {
    const parsed = emailStyleTemplateUpdateSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const t = await em.findOne(EmailStyleTemplate, { id: parsed.id, deletedAt: null })
    if (!t) throw new CrudHttpError(404, { error: 'Style template not found' })
    ensureTenantScope(ctx, t.tenantId)
    ensureOrganizationScope(ctx, t.organizationId)
    if (parsed.name !== undefined) t.name = parsed.name
    if (parsed.category !== undefined) t.category = parsed.category
    if (parsed.htmlTemplate !== undefined) t.htmlTemplate = parsed.htmlTemplate
    if (parsed.thumbnailUrl !== undefined) t.thumbnailUrl = parsed.thumbnailUrl ?? null
    if (parsed.isDefault !== undefined) t.isDefault = parsed.isDefault
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'updated', entity: t,
      identifiers: { id: t.id, organizationId: t.organizationId, tenantId: t.tenantId },
      indexer: styleTemplateIndexer, events: styleTemplateEvents,
    })
    return { styleTemplateId: t.id }
  },
}

const deleteEmailStyleTemplateCommand: CommandHandler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, { styleTemplateId: string }> = {
  id: 'email.style_templates.delete',
  async execute(input, ctx) {
    const id = requireId(input, 'Style template id required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const t = await em.findOne(EmailStyleTemplate, { id, deletedAt: null })
    if (!t) throw new CrudHttpError(404, { error: 'Style template not found' })
    ensureTenantScope(ctx, t.tenantId)
    ensureOrganizationScope(ctx, t.organizationId)
    t.deletedAt = new Date()
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'deleted', entity: t,
      identifiers: { id: t.id, organizationId: t.organizationId, tenantId: t.tenantId },
      indexer: styleTemplateIndexer, events: styleTemplateEvents,
    })
    return { styleTemplateId: t.id }
  },
}

// ---------------------------------------------------------------------------
// EmailConnection — compact create/update/delete
// ---------------------------------------------------------------------------

const createEmailConnectionCommand: CommandHandler<EmailConnectionCreateInput, { connectionId: string }> = {
  id: 'email.connections.create',
  async execute(rawInput, ctx) {
    const parsed = emailConnectionCreateSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const c = em.create(EmailConnection, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      userId: parsed.userId,
      provider: parsed.provider,
      emailAddress: parsed.emailAddress,
      accessToken: parsed.accessToken ?? null,
      refreshToken: parsed.refreshToken ?? null,
      tokenExpiry: parsed.tokenExpiry ?? null,
      smtpHost: parsed.smtpHost ?? null,
      smtpPort: parsed.smtpPort ?? null,
      smtpUser: parsed.smtpUser ?? null,
      smtpPass: parsed.smtpPass ?? null,
      isPrimary: parsed.isPrimary ?? false,
      isActive: parsed.isActive ?? true,
    })
    em.persist(c)
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'created', entity: c,
      identifiers: { id: c.id, organizationId: c.organizationId, tenantId: c.tenantId },
      indexer: connectionIndexer, events: connectionEvents,
    })
    return { connectionId: c.id }
  },
}

const updateEmailConnectionCommand: CommandHandler<EmailConnectionUpdateInput, { connectionId: string }> = {
  id: 'email.connections.update',
  async execute(rawInput, ctx) {
    const parsed = emailConnectionUpdateSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const c = await em.findOne(EmailConnection, { id: parsed.id, deletedAt: null })
    if (!c) throw new CrudHttpError(404, { error: 'Connection not found' })
    ensureTenantScope(ctx, c.tenantId)
    ensureOrganizationScope(ctx, c.organizationId)
    if (parsed.accessToken !== undefined) c.accessToken = parsed.accessToken ?? null
    if (parsed.refreshToken !== undefined) c.refreshToken = parsed.refreshToken ?? null
    if (parsed.tokenExpiry !== undefined) c.tokenExpiry = parsed.tokenExpiry ?? null
    if (parsed.smtpHost !== undefined) c.smtpHost = parsed.smtpHost ?? null
    if (parsed.smtpPort !== undefined) c.smtpPort = parsed.smtpPort ?? null
    if (parsed.smtpUser !== undefined) c.smtpUser = parsed.smtpUser ?? null
    if (parsed.smtpPass !== undefined) c.smtpPass = parsed.smtpPass ?? null
    if (parsed.isPrimary !== undefined) c.isPrimary = parsed.isPrimary
    if (parsed.isActive !== undefined) c.isActive = parsed.isActive
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'updated', entity: c,
      identifiers: { id: c.id, organizationId: c.organizationId, tenantId: c.tenantId },
      indexer: connectionIndexer, events: connectionEvents,
    })
    return { connectionId: c.id }
  },
}

const deleteEmailConnectionCommand: CommandHandler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, { connectionId: string }> = {
  id: 'email.connections.delete',
  async execute(input, ctx) {
    const id = requireId(input, 'Connection id required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const c = await em.findOne(EmailConnection, { id, deletedAt: null })
    if (!c) throw new CrudHttpError(404, { error: 'Connection not found' })
    ensureTenantScope(ctx, c.tenantId)
    ensureOrganizationScope(ctx, c.organizationId)
    c.deletedAt = new Date()
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'deleted', entity: c,
      identifiers: { id: c.id, organizationId: c.organizationId, tenantId: c.tenantId },
      indexer: connectionIndexer, events: connectionEvents,
    })
    return { connectionId: c.id }
  },
}

// ---------------------------------------------------------------------------
// EspConnection — upsert (1:1 per provider per org)
// ---------------------------------------------------------------------------

const upsertEspConnectionCommand: CommandHandler<EspConnectionUpsertInput, { espConnectionId: string }> = {
  id: 'email.esp_connections.upsert',
  async execute(rawInput, ctx) {
    const parsed = espConnectionUpsertSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let c = await em.findOne(EspConnection, {
      organizationId: parsed.organizationId,
      provider: parsed.provider,
      deletedAt: null,
    })
    const isCreate = !c
    if (!c) {
      c = em.create(EspConnection, {
        tenantId: parsed.tenantId,
        organizationId: parsed.organizationId,
        provider: parsed.provider,
        apiKey: parsed.apiKey,
        sendingDomain: parsed.sendingDomain ?? null,
        defaultSenderEmail: parsed.defaultSenderEmail ?? null,
        defaultSenderName: parsed.defaultSenderName ?? null,
        isActive: parsed.isActive ?? true,
      })
      em.persist(c)
    } else {
      ensureTenantScope(ctx, c.tenantId)
      c.apiKey = parsed.apiKey
      if (parsed.sendingDomain !== undefined) c.sendingDomain = parsed.sendingDomain ?? null
      if (parsed.defaultSenderEmail !== undefined) c.defaultSenderEmail = parsed.defaultSenderEmail ?? null
      if (parsed.defaultSenderName !== undefined) c.defaultSenderName = parsed.defaultSenderName ?? null
      if (parsed.isActive !== undefined) c.isActive = parsed.isActive
    }
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: isCreate ? 'created' : 'updated', entity: c,
      identifiers: { id: c.id, organizationId: c.organizationId, tenantId: c.tenantId },
      indexer: espConnectionIndexer, events: espConnectionEvents,
    })
    return { espConnectionId: c.id }
  },
}

const deleteEspConnectionCommand: CommandHandler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, { espConnectionId: string }> = {
  id: 'email.esp_connections.delete',
  async execute(input, ctx) {
    const id = requireId(input, 'ESP connection id required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const c = await em.findOne(EspConnection, { id, deletedAt: null })
    if (!c) throw new CrudHttpError(404, { error: 'ESP connection not found' })
    ensureTenantScope(ctx, c.tenantId)
    ensureOrganizationScope(ctx, c.organizationId)
    c.deletedAt = new Date()
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'deleted', entity: c,
      identifiers: { id: c.id, organizationId: c.organizationId, tenantId: c.tenantId },
      indexer: espConnectionIndexer, events: espConnectionEvents,
    })
    return { espConnectionId: c.id }
  },
}

// ---------------------------------------------------------------------------
// EspSenderAddress — compact create/update/delete
// ---------------------------------------------------------------------------

const createEspSenderAddressCommand: CommandHandler<EspSenderAddressCreateInput, { senderAddressId: string }> = {
  id: 'email.sender_addresses.create',
  async execute(rawInput, ctx) {
    const parsed = espSenderAddressCreateSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const s = em.create(EspSenderAddress, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      espConnectionId: parsed.espConnectionId,
      senderEmail: parsed.senderEmail,
      senderName: parsed.senderName ?? null,
      isDefault: parsed.isDefault ?? false,
    })
    em.persist(s)
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'created', entity: s,
      identifiers: { id: s.id, organizationId: s.organizationId, tenantId: s.tenantId },
      indexer: senderAddressIndexer, events: senderAddressEvents,
    })
    return { senderAddressId: s.id }
  },
}

const updateEspSenderAddressCommand: CommandHandler<EspSenderAddressUpdateInput, { senderAddressId: string }> = {
  id: 'email.sender_addresses.update',
  async execute(rawInput, ctx) {
    const parsed = espSenderAddressUpdateSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const s = await em.findOne(EspSenderAddress, { id: parsed.id, deletedAt: null })
    if (!s) throw new CrudHttpError(404, { error: 'Sender address not found' })
    ensureTenantScope(ctx, s.tenantId)
    ensureOrganizationScope(ctx, s.organizationId)
    if (parsed.senderName !== undefined) s.senderName = parsed.senderName ?? null
    if (parsed.isDefault !== undefined) s.isDefault = parsed.isDefault
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'updated', entity: s,
      identifiers: { id: s.id, organizationId: s.organizationId, tenantId: s.tenantId },
      indexer: senderAddressIndexer, events: senderAddressEvents,
    })
    return { senderAddressId: s.id }
  },
}

const deleteEspSenderAddressCommand: CommandHandler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, { senderAddressId: string }> = {
  id: 'email.sender_addresses.delete',
  async execute(input, ctx) {
    const id = requireId(input, 'Sender address id required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const s = await em.findOne(EspSenderAddress, { id, deletedAt: null })
    if (!s) throw new CrudHttpError(404, { error: 'Sender address not found' })
    ensureTenantScope(ctx, s.tenantId)
    ensureOrganizationScope(ctx, s.organizationId)
    s.deletedAt = new Date()
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'deleted', entity: s,
      identifiers: { id: s.id, organizationId: s.organizationId, tenantId: s.tenantId },
      indexer: senderAddressIndexer, events: senderAddressEvents,
    })
    return { senderAddressId: s.id }
  },
}

// ---------------------------------------------------------------------------
// EmailList — compact create/update/delete
// ---------------------------------------------------------------------------

const createEmailListCommand: CommandHandler<EmailListCreateInput, { listId: string; row: Record<string, unknown> }> = {
  id: 'email.lists.create',
  async execute(rawInput, ctx) {
    const parsed = emailListCreateSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const l = em.create(EmailList, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      name: parsed.name,
      description: parsed.description ?? null,
      sourceType: parsed.sourceType ?? 'manual',
      sourceId: parsed.sourceId ?? null,
    })
    em.persist(l)
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'created', entity: l,
      identifiers: { id: l.id, organizationId: l.organizationId, tenantId: l.tenantId },
      indexer: listIndexer, events: listEvents,
    })
    return {
      listId: l.id,
      row: {
        id: l.id,
        tenant_id: l.tenantId,
        organization_id: l.organizationId,
        name: l.name,
        description: l.description,
        source_type: l.sourceType,
        source_id: l.sourceId,
        member_count: l.memberCount ?? 0,
        created_at: l.createdAt,
        updated_at: l.updatedAt,
      },
    }
  },
}

const updateEmailListCommand: CommandHandler<EmailListUpdateInput, { listId: string }> = {
  id: 'email.lists.update',
  async execute(rawInput, ctx) {
    const parsed = emailListUpdateSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const l = await em.findOne(EmailList, { id: parsed.id, deletedAt: null })
    if (!l) throw new CrudHttpError(404, { error: 'List not found' })
    ensureTenantScope(ctx, l.tenantId)
    ensureOrganizationScope(ctx, l.organizationId)
    if (parsed.name !== undefined) l.name = parsed.name
    if (parsed.description !== undefined) l.description = parsed.description ?? null
    if (parsed.sourceType !== undefined) l.sourceType = parsed.sourceType
    if (parsed.sourceId !== undefined) l.sourceId = parsed.sourceId ?? null
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'updated', entity: l,
      identifiers: { id: l.id, organizationId: l.organizationId, tenantId: l.tenantId },
      indexer: listIndexer, events: listEvents,
    })
    return { listId: l.id }
  },
}

const deleteEmailListCommand: CommandHandler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, { listId: string }> = {
  id: 'email.lists.delete',
  async execute(input, ctx) {
    const id = requireId(input, 'List id required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const l = await em.findOne(EmailList, { id, deletedAt: null })
    if (!l) throw new CrudHttpError(404, { error: 'List not found' })
    ensureTenantScope(ctx, l.tenantId)
    ensureOrganizationScope(ctx, l.organizationId)
    l.deletedAt = new Date()
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'deleted', entity: l,
      identifiers: { id: l.id, organizationId: l.organizationId, tenantId: l.tenantId },
      indexer: listIndexer, events: listEvents,
    })
    return { listId: l.id }
  },
}

// ---------------------------------------------------------------------------
// EmailListMember — add / remove (no update)
// ---------------------------------------------------------------------------

const addEmailListMemberCommand: CommandHandler<EmailListMemberCreateInput, { memberId: string }> = {
  id: 'email.list_members.add',
  async execute(rawInput, ctx) {
    const parsed = emailListMemberCreateSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    // Verify list ownership before adding
    const list = await em.findOne(EmailList, {
      id: parsed.listId,
      organizationId: parsed.organizationId,
      tenantId: parsed.tenantId,
      deletedAt: null,
    })
    if (!list) throw new CrudHttpError(404, { error: 'List not found' })
    const member = em.create(EmailListMember, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      listId: parsed.listId,
      contactId: parsed.contactId,
    })
    em.persist(member)
    list.memberCount = (list.memberCount ?? 0) + 1
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'created', entity: member,
      identifiers: { id: member.id, organizationId: member.organizationId, tenantId: member.tenantId },
      indexer: listMemberIndexer, events: listMemberEvents,
    })
    return { memberId: member.id }
  },
}

const removeEmailListMemberCommand: CommandHandler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, { memberId: string }> = {
  id: 'email.list_members.remove',
  async execute(input, ctx) {
    const id = requireId(input, 'List member id required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const member = await em.findOne(EmailListMember, { id, deletedAt: null })
    if (!member) throw new CrudHttpError(404, { error: 'List member not found' })
    ensureTenantScope(ctx, member.tenantId)
    ensureOrganizationScope(ctx, member.organizationId)
    member.deletedAt = new Date()
    // Decrement parent list count
    const list = await em.findOne(EmailList, { id: member.listId })
    if (list && list.memberCount > 0) list.memberCount = list.memberCount - 1
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'deleted', entity: member,
      identifiers: { id: member.id, organizationId: member.organizationId, tenantId: member.tenantId },
      indexer: listMemberIndexer, events: listMemberEvents,
    })
    return { memberId: member.id }
  },
}

// ---------------------------------------------------------------------------
// EmailRouting — upsert (1:1 per purpose per org)
// ---------------------------------------------------------------------------

const upsertEmailRoutingCommand: CommandHandler<EmailRoutingUpsertInput, { routingId: string }> = {
  id: 'email.routing.upsert',
  async execute(rawInput, ctx) {
    const parsed = emailRoutingUpsertSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let r = await em.findOne(EmailRouting, {
      organizationId: parsed.organizationId,
      purpose: parsed.purpose,
      deletedAt: null,
    })
    const isCreate = !r
    if (!r) {
      r = em.create(EmailRouting, {
        tenantId: parsed.tenantId,
        organizationId: parsed.organizationId,
        purpose: parsed.purpose,
        providerType: parsed.providerType,
        providerId: parsed.providerId,
        fromName: parsed.fromName ?? null,
        fromAddress: parsed.fromAddress ?? null,
      })
      em.persist(r)
    } else {
      ensureTenantScope(ctx, r.tenantId)
      r.providerType = parsed.providerType
      r.providerId = parsed.providerId
      r.fromName = parsed.fromName ?? null
      r.fromAddress = parsed.fromAddress ?? null
    }
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: isCreate ? 'created' : 'updated', entity: r,
      identifiers: { id: r.id, organizationId: r.organizationId, tenantId: r.tenantId },
      indexer: routingIndexer, events: routingEvents,
    })
    return { routingId: r.id }
  },
}

// ---------------------------------------------------------------------------
// EmailPreferenceCategory — compact create/update/delete
// ---------------------------------------------------------------------------

const createEmailPreferenceCategoryCommand: CommandHandler<EmailPreferenceCategoryCreateInput, { categoryId: string }> = {
  id: 'email.preference_categories.create',
  async execute(rawInput, ctx) {
    const parsed = emailPreferenceCategoryCreateSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const c = em.create(EmailPreferenceCategory, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      name: parsed.name,
      slug: parsed.slug,
      description: parsed.description ?? null,
      isDefault: parsed.isDefault ?? false,
    })
    em.persist(c)
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'created', entity: c,
      identifiers: { id: c.id, organizationId: c.organizationId, tenantId: c.tenantId },
      indexer: prefCategoryIndexer, events: prefCategoryEvents,
    })
    return { categoryId: c.id }
  },
}

const updateEmailPreferenceCategoryCommand: CommandHandler<EmailPreferenceCategoryUpdateInput, { categoryId: string }> = {
  id: 'email.preference_categories.update',
  async execute(rawInput, ctx) {
    const parsed = emailPreferenceCategoryUpdateSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const c = await em.findOne(EmailPreferenceCategory, { id: parsed.id, deletedAt: null })
    if (!c) throw new CrudHttpError(404, { error: 'Preference category not found' })
    ensureTenantScope(ctx, c.tenantId)
    ensureOrganizationScope(ctx, c.organizationId)
    if (parsed.name !== undefined) c.name = parsed.name
    if (parsed.slug !== undefined) c.slug = parsed.slug
    if (parsed.description !== undefined) c.description = parsed.description ?? null
    if (parsed.isDefault !== undefined) c.isDefault = parsed.isDefault
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'updated', entity: c,
      identifiers: { id: c.id, organizationId: c.organizationId, tenantId: c.tenantId },
      indexer: prefCategoryIndexer, events: prefCategoryEvents,
    })
    return { categoryId: c.id }
  },
}

const deleteEmailPreferenceCategoryCommand: CommandHandler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, { categoryId: string }> = {
  id: 'email.preference_categories.delete',
  async execute(input, ctx) {
    const id = requireId(input, 'Preference category id required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const c = await em.findOne(EmailPreferenceCategory, { id, deletedAt: null })
    if (!c) throw new CrudHttpError(404, { error: 'Preference category not found' })
    ensureTenantScope(ctx, c.tenantId)
    ensureOrganizationScope(ctx, c.organizationId)
    c.deletedAt = new Date()
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: 'deleted', entity: c,
      identifiers: { id: c.id, organizationId: c.organizationId, tenantId: c.tenantId },
      indexer: prefCategoryIndexer, events: prefCategoryEvents,
    })
    return { categoryId: c.id }
  },
}

// ---------------------------------------------------------------------------
// EmailPreference — upsert (per-contact opt-in/out toggle)
// ---------------------------------------------------------------------------

const upsertEmailPreferenceCommand: CommandHandler<EmailPreferenceUpsertInput, { preferenceId: string }> = {
  id: 'email.preferences.upsert',
  async execute(rawInput, ctx) {
    const parsed = emailPreferenceUpsertSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let p = await em.findOne(EmailPreference, {
      contactId: parsed.contactId,
      organizationId: parsed.organizationId,
      categorySlug: parsed.categorySlug,
      deletedAt: null,
    })
    const isCreate = !p
    if (!p) {
      p = em.create(EmailPreference, {
        tenantId: parsed.tenantId,
        organizationId: parsed.organizationId,
        contactId: parsed.contactId,
        categorySlug: parsed.categorySlug,
        optedIn: parsed.optedIn,
      })
      em.persist(p)
    } else {
      ensureTenantScope(ctx, p.tenantId)
      p.optedIn = parsed.optedIn
    }
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: isCreate ? 'created' : 'updated', entity: p,
      identifiers: { id: p.id, organizationId: p.organizationId, tenantId: p.tenantId },
      indexer: preferenceIndexer, events: preferenceEvents,
    })
    return { preferenceId: p.id }
  },
}

// ---------------------------------------------------------------------------
// EmailIntelligenceSettings — upsert (1:1 per (org, user))
// ---------------------------------------------------------------------------

const upsertEmailIntelligenceSettingsCommand: CommandHandler<EmailIntelligenceSettingsUpsertInput, { settingsId: string }> = {
  id: 'email.intelligence.upsert',
  async execute(rawInput, ctx) {
    const parsed = emailIntelligenceSettingsUpsertSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let s = await em.findOne(EmailIntelligenceSettings, {
      organizationId: parsed.organizationId,
      userId: parsed.userId,
    })
    const isCreate = !s
    if (!s) {
      s = em.create(EmailIntelligenceSettings, {
        tenantId: parsed.tenantId,
        organizationId: parsed.organizationId,
        userId: parsed.userId,
        isEnabled: parsed.isEnabled ?? false,
        autoCreateContacts: parsed.autoCreateContacts ?? true,
        autoUpdateTimeline: parsed.autoUpdateTimeline ?? true,
        autoUpdateEngagement: parsed.autoUpdateEngagement ?? true,
        autoAdvanceStage: parsed.autoAdvanceStage ?? true,
      })
      em.persist(s)
    } else {
      ensureTenantScope(ctx, s.tenantId)
      if (parsed.isEnabled !== undefined) s.isEnabled = parsed.isEnabled
      if (parsed.autoCreateContacts !== undefined) s.autoCreateContacts = parsed.autoCreateContacts
      if (parsed.autoUpdateTimeline !== undefined) s.autoUpdateTimeline = parsed.autoUpdateTimeline
      if (parsed.autoUpdateEngagement !== undefined) s.autoUpdateEngagement = parsed.autoUpdateEngagement
      if (parsed.autoAdvanceStage !== undefined) s.autoAdvanceStage = parsed.autoAdvanceStage
    }
    if (parsed.lastGmailHistoryId !== undefined) s.lastGmailHistoryId = parsed.lastGmailHistoryId ?? null
    if (parsed.lastOutlookDeltaLink !== undefined) s.lastOutlookDeltaLink = parsed.lastOutlookDeltaLink ?? null
    if (parsed.lastSyncAt !== undefined) s.lastSyncAt = parsed.lastSyncAt ?? null
    if (parsed.lastSyncStatus !== undefined) s.lastSyncStatus = parsed.lastSyncStatus ?? null
    if (parsed.lastSyncError !== undefined) s.lastSyncError = parsed.lastSyncError ?? null
    if (parsed.emailsProcessedTotal !== undefined) s.emailsProcessedTotal = parsed.emailsProcessedTotal
    if (parsed.contactsCreatedTotal !== undefined) s.contactsCreatedTotal = parsed.contactsCreatedTotal
    await em.flush()
    const de = ctx.container.resolve('dataEngine') as DataEngine
    await emitCrudSideEffects({
      dataEngine: de, action: isCreate ? 'created' : 'updated', entity: s,
      identifiers: { id: s.id, organizationId: s.organizationId, tenantId: s.tenantId },
      indexer: intelligenceIndexer, events: intelligenceEvents,
    })
    return { settingsId: s.id }
  },
}

// ---------------------------------------------------------------------------
// Register all commands
// ---------------------------------------------------------------------------

registerCommand(createEmailTemplateCommand)
registerCommand(updateEmailTemplateCommand)
registerCommand(deleteEmailTemplateCommand)
registerCommand(createEmailCampaignCommand)
registerCommand(updateEmailCampaignCommand)
registerCommand(deleteEmailCampaignCommand)
registerCommand(createEmailStyleTemplateCommand)
registerCommand(updateEmailStyleTemplateCommand)
registerCommand(deleteEmailStyleTemplateCommand)
registerCommand(createEmailConnectionCommand)
registerCommand(updateEmailConnectionCommand)
registerCommand(deleteEmailConnectionCommand)
registerCommand(upsertEspConnectionCommand)
registerCommand(deleteEspConnectionCommand)
registerCommand(createEspSenderAddressCommand)
registerCommand(updateEspSenderAddressCommand)
registerCommand(deleteEspSenderAddressCommand)
registerCommand(createEmailListCommand)
registerCommand(updateEmailListCommand)
registerCommand(deleteEmailListCommand)
registerCommand(addEmailListMemberCommand)
registerCommand(removeEmailListMemberCommand)
registerCommand(upsertEmailRoutingCommand)
registerCommand(createEmailPreferenceCategoryCommand)
registerCommand(updateEmailPreferenceCategoryCommand)
registerCommand(deleteEmailPreferenceCategoryCommand)
registerCommand(upsertEmailPreferenceCommand)
registerCommand(upsertEmailIntelligenceSettingsCommand)
