/**
 * AI tools for the customers module — exposes the tier 0 entities to Scout
 * via the MCP tool registry. Following the SPEC-061 mercato rebuild, this
 * file is what makes Scout actually able to see and manipulate the migrated
 * entities (tasks, notes, reminders, business profile, engagement).
 *
 * Pattern reference: packages/core/src/modules/inbox_ops/ai-tools.ts
 *
 * Tier 0 cutover scope: 9 high-leverage tools, one per user-facing operation.
 * Append-only analytics entities (engagement_events, contact_open_times) are
 * not directly exposed because they're internal data — they get manipulated
 * via the engagement query tool which surfaces the rolled-up score + recent
 * events for a contact.
 *
 * All tools require explicit features and use ORM scope filtering. They go
 * through the same command bus as the API routes for any mutations, so they
 * inherit audit logging, query index updates, event emission, etc.
 */

import { z } from 'zod'
import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import {
  CustomerTask,
  CustomerContactNote,
  CustomerReminder,
  CustomerBusinessProfile,
  CustomerContactEngagementScore,
  CustomerEngagementEvent,
  CustomerEntity,
} from './data/entities'

type ToolContext = {
  tenantId: string | null
  organizationId: string | null
  userId: string | null
  container: AwilixContainer
  userFeatures: string[]
  isSuperAdmin: boolean
}

interface AiToolDefinition {
  name: string
  description: string
  inputSchema: z.ZodType
  requiredFeatures?: string[]
  handler: (input: never, ctx: ToolContext) => Promise<unknown>
}

function requireScope(ctx: ToolContext): { tenantId: string; organizationId: string } {
  if (!ctx.tenantId || !ctx.organizationId) {
    throw new Error('Tenant context is required')
  }
  return { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
}

function commandCtx(ctx: ToolContext) {
  return {
    container: ctx.container,
    auth: {
      tenantId: ctx.tenantId,
      orgId: ctx.organizationId,
      sub: ctx.userId,
    } as any,
    request: undefined,
  }
}

// ===========================================================================
// Tasks
// ===========================================================================

const listTasksTool: AiToolDefinition = {
  name: 'customers_list_tasks',
  description: `List CRM tasks for the authenticated organization. Optionally filter by contact, completion status, or due date range.

Returns: { total, tasks: [{ id, title, description, contactId, dealId, dueDate, isDone, completedAt, createdAt }] }`,
  inputSchema: z.object({
    contactId: z.string().uuid().optional().describe('Filter to tasks linked to this contact'),
    isDone: z.boolean().optional().describe('Filter by completion status (default: only show open tasks)'),
    dueBefore: z.string().optional().describe('Filter to tasks due on or before this date (ISO 8601)'),
    limit: z.number().int().min(1).max(100).optional().default(20),
  }),
  requiredFeatures: ['customers.tasks.view'],
  handler: async (input: { contactId?: string; isDone?: boolean; dueBefore?: string; limit?: number }, ctx) => {
    const scope = requireScope(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const where: Record<string, unknown> = {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      deletedAt: null,
    }
    if (input.contactId) where.contactId = input.contactId
    if (input.isDone !== undefined) where.isDone = input.isDone
    else where.isDone = false
    if (input.dueBefore) where.dueDate = { $lte: new Date(input.dueBefore) }
    const tasks = await em.find(CustomerTask, where, {
      orderBy: { dueDate: 'ASC', createdAt: 'DESC' },
      limit: input.limit ?? 20,
    })
    const total = await em.count(CustomerTask, where)
    return {
      total,
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        contactId: t.contactId,
        dealId: t.dealId,
        dueDate: t.dueDate?.toISOString() ?? null,
        isDone: t.isDone,
        completedAt: t.completedAt?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
      })),
    }
  },
}

const createTaskTool: AiToolDefinition = {
  name: 'customers_create_task',
  description: `Create a new CRM task linked to a contact or deal.

Returns: { ok: true, taskId } on success.`,
  inputSchema: z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(10_000).optional(),
    contactId: z.string().uuid().optional().describe('Link to a contact'),
    dealId: z.string().uuid().optional().describe('Link to a deal'),
    dueDate: z.string().optional().describe('Due date (ISO 8601)'),
  }),
  requiredFeatures: ['customers.tasks.manage'],
  handler: async (input: { title: string; description?: string; contactId?: string; dealId?: string; dueDate?: string }, ctx) => {
    const scope = requireScope(ctx)
    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<unknown, { taskId: string }>('customers.tasks.create', {
      input: {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        title: input.title,
        description: input.description ?? null,
        contactId: input.contactId ?? null,
        dealId: input.dealId ?? null,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
      },
      ctx: commandCtx(ctx),
    })
    return { ok: true, taskId: result.taskId }
  },
}

const completeTaskTool: AiToolDefinition = {
  name: 'customers_complete_task',
  description: `Mark a CRM task as completed (or reopen it). Sets completedAt to now when completing.

Returns: { ok: true } on success.`,
  inputSchema: z.object({
    taskId: z.string().uuid(),
    isDone: z.boolean().default(true).describe('true to complete (default), false to reopen'),
  }),
  requiredFeatures: ['customers.tasks.manage'],
  handler: async (input: { taskId: string; isDone?: boolean }, ctx) => {
    const scope = requireScope(ctx)
    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    await commandBus.execute('customers.tasks.update', {
      input: {
        id: input.taskId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        isDone: input.isDone ?? true,
      },
      ctx: commandCtx(ctx),
    })
    return { ok: true }
  },
}

// ===========================================================================
// Contact notes
// ===========================================================================

const listNotesTool: AiToolDefinition = {
  name: 'customers_list_notes',
  description: `List free-form notes attached to a contact.

Returns: { total, notes: [{ id, contactId, content, authorUserId, createdAt }] }`,
  inputSchema: z.object({
    contactId: z.string().uuid().describe('The contact whose notes to fetch'),
    limit: z.number().int().min(1).max(100).optional().default(20),
  }),
  requiredFeatures: ['customers.notes.view'],
  handler: async (input: { contactId: string; limit?: number }, ctx) => {
    const scope = requireScope(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const where = {
      contactId: input.contactId,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      deletedAt: null,
    }
    const notes = await em.find(CustomerContactNote, where, {
      orderBy: { createdAt: 'DESC' },
      limit: input.limit ?? 20,
    })
    const total = await em.count(CustomerContactNote, where)
    return {
      total,
      notes: notes.map((n) => ({
        id: n.id,
        contactId: n.contactId,
        content: n.content,
        authorUserId: n.authorUserId,
        createdAt: n.createdAt.toISOString(),
      })),
    }
  },
}

const createNoteTool: AiToolDefinition = {
  name: 'customers_create_note',
  description: `Create a free-form note attached to a contact.

Returns: { ok: true, noteId } on success.`,
  inputSchema: z.object({
    contactId: z.string().uuid(),
    content: z.string().min(1).max(50_000),
  }),
  requiredFeatures: ['customers.notes.manage'],
  handler: async (input: { contactId: string; content: string }, ctx) => {
    const scope = requireScope(ctx)
    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<unknown, { noteId: string }>('customers.notes.create', {
      input: {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        contactId: input.contactId,
        content: input.content,
        authorUserId: ctx.userId,
      },
      ctx: commandCtx(ctx),
    })
    return { ok: true, noteId: result.noteId }
  },
}

// ===========================================================================
// Reminders
// ===========================================================================

const listRemindersTool: AiToolDefinition = {
  name: 'customers_list_reminders',
  description: `List reminders for the authenticated user. Optionally filter by status (sent or pending).

Returns: { total, reminders: [{ id, message, entityType, entityId, remindAt, sent, sentAt, createdAt }] }`,
  inputSchema: z.object({
    sent: z.boolean().optional().describe('Filter by sent status (default: only pending)'),
    limit: z.number().int().min(1).max(100).optional().default(20),
  }),
  requiredFeatures: ['customers.reminders.view'],
  handler: async (input: { sent?: boolean; limit?: number }, ctx) => {
    const scope = requireScope(ctx)
    if (!ctx.userId) throw new Error('User context is required for reminders')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const where: Record<string, unknown> = {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      userId: ctx.userId,
      deletedAt: null,
    }
    if (input.sent !== undefined) where.sent = input.sent
    else where.sent = false
    const reminders = await em.find(CustomerReminder, where, {
      orderBy: { remindAt: 'ASC' },
      limit: input.limit ?? 20,
    })
    const total = await em.count(CustomerReminder, where)
    return {
      total,
      reminders: reminders.map((r) => ({
        id: r.id,
        message: r.message,
        entityType: r.entityType,
        entityId: r.entityId,
        remindAt: r.remindAt.toISOString(),
        sent: r.sent,
        sentAt: r.sentAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    }
  },
}

const createReminderTool: AiToolDefinition = {
  name: 'customers_create_reminder',
  description: `Create a reminder for the authenticated user, polymorphically linked to a contact, deal, or task.

Returns: { ok: true, reminderId } on success.`,
  inputSchema: z.object({
    entityType: z.enum(['contact', 'deal', 'task']),
    entityId: z.string().uuid(),
    message: z.string().min(1).max(2000),
    remindAt: z.string().describe('When to fire the reminder (ISO 8601)'),
  }),
  requiredFeatures: ['customers.reminders.manage'],
  handler: async (input: { entityType: 'contact' | 'deal' | 'task'; entityId: string; message: string; remindAt: string }, ctx) => {
    const scope = requireScope(ctx)
    if (!ctx.userId) throw new Error('User context is required for reminders')
    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<unknown, { reminderId: string }>('customers.reminders.create', {
      input: {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        userId: ctx.userId,
        entityType: input.entityType,
        entityId: input.entityId,
        message: input.message,
        remindAt: new Date(input.remindAt),
      },
      ctx: commandCtx(ctx),
    })
    return { ok: true, reminderId: result.reminderId }
  },
}

// ===========================================================================
// Business profile
// ===========================================================================

const getBusinessProfileTool: AiToolDefinition = {
  name: 'customers_get_business_profile',
  description: `Get the business profile for the authenticated organization. Includes business name, type, description, AI persona settings, pipeline configuration, and brand voice.

Returns: { profile: {...} } or { profile: null } if not yet set up.`,
  inputSchema: z.object({}),
  requiredFeatures: ['customers.business_profile.view'],
  handler: async (_input, ctx) => {
    const scope = requireScope(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const bp = await em.findOne(CustomerBusinessProfile, {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
    })
    if (!bp) return { profile: null }
    return {
      profile: {
        id: bp.id,
        businessName: bp.businessName,
        businessType: bp.businessType,
        businessDescription: bp.businessDescription,
        mainOffer: bp.mainOffer,
        idealClients: bp.idealClients,
        teamSize: bp.teamSize,
        websiteUrl: bp.websiteUrl,
        aiPersonaName: bp.aiPersonaName,
        aiPersonaStyle: bp.aiPersonaStyle,
        aiCustomInstructions: bp.aiCustomInstructions,
        pipelineMode: bp.pipelineMode,
        emailIntakeMode: bp.emailIntakeMode,
        interfaceMode: bp.interfaceMode,
        onboardingComplete: bp.onboardingComplete,
        clientSources: bp.clientSources,
        pipelineStages: bp.pipelineStages,
      },
    }
  },
}

// ===========================================================================
// Engagement (rolled-up score + recent events for a contact)
// ===========================================================================

const getContactEngagementTool: AiToolDefinition = {
  name: 'customers_get_contact_engagement',
  description: `Get the engagement score and recent activity for a contact. The score is computed from event_type → points rules; recent events let you see what's been happening with the contact.

Returns: { score: number, lastActivity: string|null, events: [{ id, eventType, points, metadata, createdAt }] }`,
  inputSchema: z.object({
    contactId: z.string().uuid(),
    eventLimit: z.number().int().min(1).max(50).optional().default(10),
  }),
  requiredFeatures: ['customers.engagement.view'],
  handler: async (input: { contactId: string; eventLimit?: number }, ctx) => {
    const scope = requireScope(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const score = await em.findOne(CustomerContactEngagementScore, {
      contactId: input.contactId,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
    })
    const events = await em.find(
      CustomerEngagementEvent,
      {
        contactId: input.contactId,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
      },
      { orderBy: { createdAt: 'DESC' }, limit: input.eventLimit ?? 10 },
    )
    return {
      score: score?.score ?? 0,
      lastActivity: score?.lastActivityAt?.toISOString() ?? null,
      events: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        points: e.points,
        metadata: e.metadata,
        createdAt: e.createdAt.toISOString(),
      })),
    }
  },
}

// ===========================================================================
// Hottest contacts (rollup query — useful for dashboards / "who should I call today")
// ===========================================================================

const listHottestContactsTool: AiToolDefinition = {
  name: 'customers_list_hottest_contacts',
  description: `List the contacts with the highest engagement scores in the authenticated organization. Useful for daily prioritization queries like "who should I follow up with today".

Returns: { contacts: [{ id, displayName, primaryEmail, score, lastActivityAt }] }`,
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).optional().default(10),
  }),
  requiredFeatures: ['customers.engagement.view'],
  handler: async (input: { limit?: number }, ctx) => {
    const scope = requireScope(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const scores = await em.find(
      CustomerContactEngagementScore,
      {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        score: { $gt: 0 },
      },
      { orderBy: { score: 'DESC' }, limit: input.limit ?? 10 },
    )
    if (scores.length === 0) return { contacts: [] }
    const contactIds = scores.map((s) => s.contactId)
    const contacts = await em.find(CustomerEntity, {
      id: { $in: contactIds },
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      deletedAt: null,
    })
    const byId = new Map(contacts.map((c) => [c.id, c]))
    return {
      contacts: scores
        .map((s) => {
          const c = byId.get(s.contactId)
          if (!c) return null
          return {
            id: c.id,
            displayName: c.displayName,
            primaryEmail: c.primaryEmail ?? null,
            score: s.score,
            lastActivityAt: s.lastActivityAt?.toISOString() ?? null,
          }
        })
        .filter((x) => x !== null),
    }
  },
}

// ===========================================================================
// Export
// ===========================================================================

/**
 * All AI tools exported by the customers module.
 * Discovered by ai-assistant module's generator.
 */
export const aiTools: AiToolDefinition[] = [
  // Tasks
  listTasksTool,
  createTaskTool,
  completeTaskTool,
  // Notes
  listNotesTool,
  createNoteTool,
  // Reminders
  listRemindersTool,
  createReminderTool,
  // Business profile
  getBusinessProfileTool,
  // Engagement
  getContactEngagementTool,
  listHottestContactsTool,
]

export default aiTools
