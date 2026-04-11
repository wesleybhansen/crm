/**
 * AI tools for the email module — exposes email entities to Scout
 * via the MCP tool registry.
 *
 * Tools: list campaigns, list email lists, list templates, search emails
 */
import { z } from 'zod'
import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import { EmailCampaign, EmailList, EmailStyleTemplate, EmailMessage } from './data/schema'

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
  if (!ctx.tenantId || !ctx.organizationId) throw new Error('Tenant context is required')
  return { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
}

const listCampaignsTool: AiToolDefinition = {
  name: 'email_list_campaigns',
  description: `List email blasts (campaigns) for the organization. Filter by status.
Returns: { total, campaigns: [{ id, name, subject, status, sentAt, stats }] }`,
  inputSchema: z.object({
    status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'cancelled']).optional(),
    limit: z.number().min(1).max(50).default(20).optional(),
  }),
  requiredFeatures: ['email.campaigns.view'],
  handler: async (input: any, ctx) => {
    const scope = requireScope(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const filter: Record<string, unknown> = { ...scope, deletedAt: null }
    if (input.status) filter.status = input.status
    const campaigns = await em.find(EmailCampaign, filter, {
      orderBy: { createdAt: 'desc' },
      limit: input.limit || 20,
    })
    return {
      total: campaigns.length,
      campaigns: campaigns.map(c => ({
        id: c.id, name: c.name, subject: c.subject, status: c.status,
        sentAt: c.sentAt, stats: c.stats, createdAt: c.createdAt,
      })),
    }
  },
}

const listEmailListsTool: AiToolDefinition = {
  name: 'email_list_mailing_lists',
  description: `List mailing lists for the organization.
Returns: { total, lists: [{ id, name, description, sourceType, memberCount }] }`,
  inputSchema: z.object({
    limit: z.number().min(1).max(50).default(20).optional(),
  }),
  requiredFeatures: ['email.lists.view'],
  handler: async (input: any, ctx) => {
    const scope = requireScope(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const lists = await em.find(EmailList, { ...scope, deletedAt: null }, {
      orderBy: { createdAt: 'desc' },
      limit: input.limit || 20,
    })
    return {
      total: lists.length,
      lists: lists.map(l => ({
        id: l.id, name: l.name, description: l.description,
        sourceType: l.sourceType, memberCount: l.memberCount,
      })),
    }
  },
}

const listTemplatesTool: AiToolDefinition = {
  name: 'email_list_templates',
  description: `List email style templates for the organization.
Returns: { total, templates: [{ id, name, category, isDefault }] }`,
  inputSchema: z.object({}),
  requiredFeatures: ['email.templates.view'],
  handler: async (_input: any, ctx) => {
    const scope = requireScope(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const templates = await em.find(EmailStyleTemplate, scope, {
      orderBy: { category: 'asc', name: 'asc' },
    })
    return {
      total: templates.length,
      templates: templates.map(t => ({
        id: t.id, name: t.name, category: t.category, isDefault: t.isDefault,
      })),
    }
  },
}

const searchEmailsTool: AiToolDefinition = {
  name: 'email_search_messages',
  description: `Search sent/received email messages. Filter by contact, direction, or search text.
Returns: { total, messages: [{ id, subject, fromEmail, toEmail, direction, status, sentAt }] }`,
  inputSchema: z.object({
    contactId: z.string().uuid().optional().describe('Filter by contact'),
    direction: z.enum(['inbound', 'outbound']).optional(),
    search: z.string().optional().describe('Search subject or body text'),
    limit: z.number().min(1).max(50).default(20).optional(),
  }),
  requiredFeatures: ['email.view'],
  handler: async (input: any, ctx) => {
    const scope = requireScope(ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const filter: Record<string, unknown> = { ...scope }
    if (input.contactId) filter.contactId = input.contactId
    if (input.direction) filter.direction = input.direction
    const messages = await em.find(EmailMessage, filter, {
      orderBy: { createdAt: 'desc' },
      limit: input.limit || 20,
    })
    return {
      total: messages.length,
      messages: messages.map(m => ({
        id: m.id, subject: m.subject, fromEmail: m.fromEmail,
        toEmail: m.toEmail, direction: m.direction, status: m.status,
        sentAt: m.sentAt, createdAt: m.createdAt,
      })),
    }
  },
}

export const aiTools: AiToolDefinition[] = [
  listCampaignsTool,
  listEmailListsTool,
  listTemplatesTool,
  searchEmailsTool,
]

export default aiTools
