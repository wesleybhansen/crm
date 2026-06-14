/**
 * App-level AI tools for the customers module.
 *
 * The customers module ships its core tier-0 tools (tasks, notes, reminders,
 * business profile, engagement) from the core package at
 * `@open-mercato/core/modules/customers/ai-tools`. The mercato generator resolves
 * a module's `ai-tools.ts` from the APP source first and only falls back to the
 * package (see packages/cli/src/lib/generators/scanner.ts -> resolveModuleFile),
 * so this app-level file OVERRIDES the package file. To avoid silently dropping
 * the core tools, we re-export them here and APPEND the customer-service tools.
 *
 * Customer Service tools expose Phase 1-3 of the customer-service feature to the
 * Chief of Staff agent over the CRM MCP server. They mirror the DB logic of the
 * existing cookie-authed REST routes under
 * apps/mercato/src/modules/customers/api/customer-service/* but reimplement it
 * scoped by the MCP auth context (ctx.tenantId / ctx.organizationId). They query
 * the DB directly via the EM's knex and NEVER trust a client-supplied org.
 */

import { z } from 'zod'
import crypto from 'crypto'
import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import { aiTools as coreCustomersTools } from '@open-mercato/core/modules/customers/ai-tools'
import { sendReply } from '@/modules/customers/lib/send-reply'

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

// Resolve the EM's knex from the MCP container. Customer-service rows are managed
// with raw SQL in the REST routes (single-row settings, cross-table queue, JSONB
// metadata filters), so the tools mirror that and use knex directly.
function getKnex(ctx: ToolContext) {
  return (ctx.container.resolve('em') as EntityManager).getKnex()
}

function safeParse(s: any) {
  if (s && typeof s === 'object') return s
  try { return JSON.parse(s) } catch { return null }
}

const VALID_MODES = new Set(['draft', 'auto', 'hybrid'])
const VALID_KINDS = new Set(['model_answer', 'document'])
const MAX_CONTENT_CHARS = 20000

function normalizeThreshold(v: unknown, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

// jsonb source_modes can arrive parsed or as a string; coerce + validate.
function parseSourceModes(raw: any): Record<string, { mode: string; threshold: number }> {
  let obj: any = raw
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch { return {} }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
  const out: Record<string, { mode: string; threshold: number }> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!v || typeof v !== 'object') continue
    const mode = (v as any).mode
    if (!VALID_MODES.has(mode)) continue
    out[k] = { mode, threshold: normalizeThreshold((v as any).threshold, 0.8) }
  }
  return out
}

// Build stored source_modes from tool input, keeping only entries for watched
// connections and with valid mode/threshold. watched === null = watch all (any id ok).
function normalizeSourceModesInput(input: any, watched: string[] | null): Record<string, { mode: string; threshold: number }> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const allowed = watched && watched.length > 0 ? new Set(watched) : null
  const out: Record<string, { mode: string; threshold: number }> = {}
  for (const [k, v] of Object.entries(input)) {
    if (typeof k !== 'string' || !k) continue
    if (allowed && !allowed.has(k)) continue
    if (!v || typeof v !== 'object') continue
    const mode = (v as any).mode
    if (!VALID_MODES.has(mode)) continue
    out[k] = { mode, threshold: normalizeThreshold((v as any).threshold, 0.8) }
  }
  return out
}

function previewOf(content: string): string {
  const flat = (content || '').replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.substring(0, 200)}...` : flat
}

function serializeSettings(row: any) {
  if (!row) {
    return { enabled: false, watchedConnectionIds: null, replyMode: 'draft', hybridConfidenceThreshold: 0.8, sourceModes: {}, signature: null }
  }
  return {
    id: row.id,
    enabled: !!row.enabled,
    watchedConnectionIds: row.watched_connection_ids ?? null,
    replyMode: row.reply_mode || 'draft',
    hybridConfidenceThreshold: row.hybrid_confidence_threshold != null ? Number(row.hybrid_confidence_threshold) : 0.8,
    sourceModes: parseSourceModes(row.source_modes),
    signature: row.signature ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function serializeKnowledgeRow(row: any) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    sourceFilename: row.source_filename ?? null,
    contentPreview: previewOf(row.content || ''),
    createdAt: row.created_at,
  }
}

// ===========================================================================
// 1. Get settings
// ===========================================================================

const getSettingsTool: AiToolDefinition = {
  name: 'customer_service_get_settings',
  description: `Get the customer-service auto-reply configuration for the authenticated organization. Use this to see whether customer service is turned on, how replies are handled, and which email accounts are watched.
Returns: { enabled, watchedConnectionIds (string[] or null = all active accounts), replyMode (draft|auto|hybrid), hybridConfidenceThreshold (0..1), sourceModes (per-mailbox overrides keyed by connection id), signature, createdAt, updatedAt }. Returns defaults if not yet set up.`,
  inputSchema: z.object({}),
  requiredFeatures: ['email.view'],
  handler: async (_input: never, ctx) => {
    const scope = requireScope(ctx)
    const knex = getKnex(ctx)
    const row = await knex('customer_service_settings').where('organization_id', scope.organizationId).first()
    return serializeSettings(row)
  },
}

// ===========================================================================
// 2. Update settings (set up / modify)
// ===========================================================================

const updateSettingsTool: AiToolDefinition = {
  name: 'customer_service_update_settings',
  description: `Set up or modify the customer-service auto-reply configuration for the authenticated organization. Upserts the single settings row. Only provided fields are changed; omitted fields keep their current value.
replyMode: "draft" queues replies for human approval, "auto" sends automatically, "hybrid" auto-sends only when the model's confidence is at or above hybridConfidenceThreshold (clamped to 0..1). This is the account-wide default.
watchedConnectionIds: list of email connection ids to watch, or omit / pass an empty list to watch all active accounts.
sourceModes: optional per-mailbox overrides, keyed by email connection id, e.g. { "<connectionId>": { "mode": "auto", "threshold": 0.8 } }. Each overrides the account default for that specific mailbox. Only ids in the watched list are kept. Threshold is clamped to 0..1. Omit to leave per-mailbox overrides unchanged.
Returns the saved settings.`,
  inputSchema: z.object({
    enabled: z.boolean().optional().describe('Turn customer service on or off'),
    watchedConnectionIds: z.array(z.string()).optional().describe('Email connection ids to watch; empty = all active accounts'),
    replyMode: z.enum(['draft', 'auto', 'hybrid']).optional(),
    hybridConfidenceThreshold: z.number().optional().describe('Confidence cutoff for hybrid auto-send, 0..1'),
    sourceModes: z.record(z.string(), z.object({
      mode: z.enum(['draft', 'auto', 'hybrid']),
      threshold: z.number().optional(),
    })).optional().describe('Per-mailbox overrides keyed by email connection id; overrides the account default for that mailbox'),
    signature: z.string().optional().describe('Signature appended to replies; pass empty string to clear'),
  }),
  requiredFeatures: ['email.send'],
  handler: async (input: any, ctx) => {
    const scope = requireScope(ctx)
    const knex = getKnex(ctx)

    const existing = await knex('customer_service_settings').where('organization_id', scope.organizationId).first()

    // Normalize watchedConnectionIds to a string[] or null (null = all active).
    let watched: string[] | null = existing?.watched_connection_ids ?? null
    if (input.watchedConnectionIds !== undefined) {
      if (Array.isArray(input.watchedConnectionIds)) {
        const cleaned = input.watchedConnectionIds.filter((v: unknown) => typeof v === 'string' && v.length > 0)
        watched = cleaned.length > 0 ? cleaned : null
      } else {
        watched = null
      }
    }

    // reply_mode: validate against draft | auto | hybrid; otherwise keep existing.
    const replyModeIn = typeof input.replyMode === 'string' ? input.replyMode : undefined
    const replyMode = (replyModeIn && VALID_MODES.has(replyModeIn))
      ? replyModeIn
      : (existing?.reply_mode || 'draft')

    const existingThreshold = existing?.hybrid_confidence_threshold != null
      ? Number(existing.hybrid_confidence_threshold)
      : 0.8
    const hybridConfidenceThreshold = input.hybridConfidenceThreshold !== undefined
      ? normalizeThreshold(input.hybridConfidenceThreshold, existingThreshold)
      : existingThreshold

    // Per-mailbox overrides: keep only entries for watched connections. Omitted
    // in input = keep existing (pruned to the current watched list).
    let sourceModes: Record<string, { mode: string; threshold: number }>
    if (input.sourceModes !== undefined) {
      sourceModes = normalizeSourceModesInput(input.sourceModes, watched)
    } else {
      sourceModes = parseSourceModes(existing?.source_modes)
      if (watched && watched.length > 0) {
        const allowed = new Set(watched)
        sourceModes = Object.fromEntries(Object.entries(sourceModes).filter(([k]) => allowed.has(k)))
      }
    }

    const fields = {
      enabled: typeof input.enabled === 'boolean' ? input.enabled : (existing?.enabled ?? false),
      watched_connection_ids: watched ? JSON.stringify(watched) : null,
      reply_mode: replyMode,
      hybrid_confidence_threshold: hybridConfidenceThreshold,
      source_modes: Object.keys(sourceModes).length > 0 ? JSON.stringify(sourceModes) : null,
      signature: input.signature !== undefined ? (input.signature || null) : (existing?.signature ?? null),
      updated_at: new Date(),
    }

    if (existing) {
      await knex('customer_service_settings').where('id', existing.id).update(fields)
    } else {
      await knex('customer_service_settings').insert({
        id: crypto.randomUUID(),
        tenant_id: scope.tenantId,
        organization_id: scope.organizationId,
        ...fields,
        created_at: new Date(),
      })
    }

    const updated = await knex('customer_service_settings').where('organization_id', scope.organizationId).first()
    return serializeSettings(updated)
  },
}

// ===========================================================================
// 3. List queue (pending draft replies)
// ===========================================================================

const listQueueTool: AiToolDefinition = {
  name: 'customer_service_list_queue',
  description: `List pending customer-service draft replies awaiting approval for the authenticated organization. Each item carries the linked contact, a preview of the last inbound message, and the drafted reply body so you can review before approving or dismissing.
Returns: { total, drafts: [{ id (action id, pass to approve/dismiss), proposalId, createdAt, summary, contact: { id, name, email }, conversationId, lastInboundPreview, subject, body }] }`,
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).optional().default(50),
  }),
  requiredFeatures: ['email.view'],
  handler: async (input: any, ctx) => {
    const scope = requireScope(ctx)
    const knex = getKnex(ctx)
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 50))

    const actions = await knex('inbox_proposal_actions as a')
      .join('inbox_proposals as p', 'p.id', 'a.proposal_id')
      .where('a.organization_id', scope.organizationId)
      .where('a.tenant_id', scope.tenantId)
      .where('a.action_type', 'draft_reply')
      .where('a.status', 'pending')
      .whereRaw(`a.metadata->>'feature_source' = ?`, ['customer_service'])
      .where('p.status', 'pending')
      .select(
        'a.id as action_id',
        'a.proposal_id',
        'a.payload',
        'a.created_at',
        'p.summary',
        'p.participants',
      )
      .orderBy('a.created_at', 'desc')
      .limit(limit)

    const drafts = actions.map((row: any) => {
      const payload = typeof row.payload === 'string' ? safeParse(row.payload) : (row.payload || {})
      const participants = typeof row.participants === 'string' ? safeParse(row.participants) : (row.participants || [])
      const first = Array.isArray(participants) ? participants[0] : null
      return {
        id: row.action_id,
        proposalId: row.proposal_id,
        createdAt: row.created_at,
        summary: row.summary,
        contact: {
          id: payload?.contactId || null,
          name: payload?.toName || first?.name || null,
          email: payload?.to || first?.email || null,
        },
        conversationId: payload?.conversationId || null,
        lastInboundPreview: payload?.lastInboundPreview || null,
        subject: payload?.subject || null,
        body: payload?.body || null,
      }
    })

    return { total: drafts.length, drafts }
  },
}

// ===========================================================================
// 4. Approve draft (send the reply)
// ===========================================================================

const approveDraftTool: AiToolDefinition = {
  name: 'customer_service_approve_draft',
  description: `Approve and send a queued customer-service draft reply. Pass the draft/action id from customer_service_list_queue. Optionally pass an edited body to send instead of the stored draft. Sends via the org's connected email provider, records the outbound message, and marks the draft sent.
Returns: { id, status: "sent", sentVia } on success.`,
  inputSchema: z.object({
    id: z.string().describe('The draft/action id from the queue'),
    body: z.string().optional().describe('Edited reply body to send instead of the stored draft'),
  }),
  requiredFeatures: ['email.send'],
  handler: async (input: any, ctx) => {
    const scope = requireScope(ctx)
    const knex = getKnex(ctx)

    // Self-scoped lookup: action must be a pending customer_service draft for this org.
    const action = await knex('inbox_proposal_actions')
      .where('id', input.id)
      .where('organization_id', scope.organizationId)
      .where('tenant_id', scope.tenantId)
      .where('action_type', 'draft_reply')
      .whereRaw(`metadata->>'feature_source' = ?`, ['customer_service'])
      .first()

    if (!action) throw new Error('Draft not found')
    if (action.status === 'sent') throw new Error('Draft already sent')
    if (action.status === 'dismissed') throw new Error('Draft was dismissed')

    const payload = safeParse(action.payload) || {}
    const to: string | undefined = payload.to
    const subject: string = payload.subject || 'Re: your message'
    const editedBody = typeof input.body === 'string' ? input.body : undefined
    const bodyText: string = (editedBody !== undefined && editedBody.trim().length > 0)
      ? editedBody
      : (payload.body || '')
    const contactId: string | null = payload.contactId || null

    if (!to || !bodyText) throw new Error('Draft is missing a recipient or body')

    // Shared send path (same code the interactive Approve button and the auto/
    // hybrid engine use): resolves the sending connection, sends via the router,
    // records the outbound email_messages row, updates inbox + timeline.
    const sendResult = await sendReply(knex, scope.organizationId, scope.tenantId, {
      to,
      subject,
      body: bodyText,
      contactId,
      sentByUserId: ctx.userId || null,
    })

    if (!sendResult.ok) throw new Error(sendResult.error || 'Failed to send email')

    const now = new Date()
    await knex('inbox_proposal_actions')
      .where('id', action.id)
      .update({ status: 'sent', executed_at: now, executed_by_user_id: ctx.userId || null, updated_at: now })
    await knex('inbox_proposals')
      .where('id', action.proposal_id)
      .where('organization_id', scope.organizationId)
      .update({ status: 'accepted', reviewed_by_user_id: ctx.userId || null, reviewed_at: now, updated_at: now })

    return { id: action.id, status: 'sent', sentVia: sendResult.sentVia }
  },
}

// ===========================================================================
// 5. Dismiss draft
// ===========================================================================

const dismissDraftTool: AiToolDefinition = {
  name: 'customer_service_dismiss_draft',
  description: `Dismiss a queued customer-service draft reply without sending it. Pass the draft/action id from customer_service_list_queue.
Returns: { id, status: "dismissed" } on success.`,
  inputSchema: z.object({
    id: z.string().describe('The draft/action id from the queue'),
  }),
  requiredFeatures: ['email.send'],
  handler: async (input: any, ctx) => {
    const scope = requireScope(ctx)
    const knex = getKnex(ctx)

    const action = await knex('inbox_proposal_actions')
      .where('id', input.id)
      .where('organization_id', scope.organizationId)
      .where('tenant_id', scope.tenantId)
      .where('action_type', 'draft_reply')
      .whereRaw(`metadata->>'feature_source' = ?`, ['customer_service'])
      .first()

    if (!action) throw new Error('Draft not found')
    if (action.status === 'sent') throw new Error('Draft already sent')

    const now = new Date()
    await knex('inbox_proposal_actions')
      .where('id', action.id)
      .update({ status: 'dismissed', updated_at: now })
    await knex('inbox_proposals')
      .where('id', action.proposal_id)
      .where('organization_id', scope.organizationId)
      .update({ status: 'rejected', reviewed_by_user_id: ctx.userId || null, reviewed_at: now, updated_at: now })

    return { id: action.id, status: 'dismissed' }
  },
}

// ===========================================================================
// 6. List knowledge
// ===========================================================================

const listKnowledgeTool: AiToolDefinition = {
  name: 'customer_service_list_knowledge',
  description: `List the active customer-service grounding entries (model answers and reference documents) for the authenticated organization. These are what the drafter uses to ground replies. Returns a content preview only, not the full text.
Returns: { total, entries: [{ id, kind (model_answer|document), title, sourceFilename, contentPreview, createdAt }] }`,
  inputSchema: z.object({}),
  requiredFeatures: ['email.view'],
  handler: async (_input: never, ctx) => {
    const scope = requireScope(ctx)
    const knex = getKnex(ctx)
    const rows = await knex('customer_service_knowledge')
      .where('organization_id', scope.organizationId)
      .where('is_active', true)
      .orderBy('updated_at', 'desc')
      .limit(200)
    return { total: rows.length, entries: rows.map(serializeKnowledgeRow) }
  },
}

// ===========================================================================
// 7. Add knowledge
// ===========================================================================

const addKnowledgeTool: AiToolDefinition = {
  name: 'customer_service_add_knowledge',
  description: `Add a customer-service grounding entry for the authenticated organization. Use kind "model_answer" for an example answer the assistant should emulate, or "document" for reference material (policies, FAQs, product details). Content is required and capped at 20000 characters.
Returns the created entry summary.`,
  inputSchema: z.object({
    kind: z.enum(['model_answer', 'document']).default('model_answer'),
    title: z.string().optional().describe('A short label; defaults based on kind if omitted'),
    content: z.string().min(1).describe('The model answer or document text'),
  }),
  requiredFeatures: ['email.send'],
  handler: async (input: any, ctx) => {
    const scope = requireScope(ctx)
    const knex = getKnex(ctx)

    const kind = typeof input.kind === 'string' && VALID_KINDS.has(input.kind) ? input.kind : 'model_answer'
    let content = (input.content || '').toString().trim()
    if (!content) throw new Error('Content is required')
    if (content.length > MAX_CONTENT_CHARS) content = content.substring(0, MAX_CONTENT_CHARS)
    let title = (input.title || '').toString().trim()
    if (!title) title = kind === 'model_answer' ? 'Model answer' : 'Reference document'
    title = title.substring(0, 200)

    const now = new Date()
    const id = crypto.randomUUID()
    await knex('customer_service_knowledge').insert({
      id,
      tenant_id: scope.tenantId,
      organization_id: scope.organizationId,
      kind,
      title,
      content,
      source_filename: null,
      is_active: true,
      created_at: now,
      updated_at: now,
    })

    const row = await knex('customer_service_knowledge').where('id', id).first()
    return serializeKnowledgeRow(row)
  },
}

// ===========================================================================
// Export
// ===========================================================================

const customerServiceTools: AiToolDefinition[] = [
  getSettingsTool,
  updateSettingsTool,
  listQueueTool,
  approveDraftTool,
  dismissDraftTool,
  listKnowledgeTool,
  addKnowledgeTool,
]

/**
 * All customers-module AI tools surfaced to the MCP registry.
 *
 * This app-level file OVERRIDES the core package's customers/ai-tools.ts in the
 * generator, so we MUST include the core tools here (re-exported) plus the new
 * customer-service tools, or the core tools would be dropped.
 */
export const aiTools: AiToolDefinition[] = [
  ...(coreCustomersTools as unknown as AiToolDefinition[]),
  ...customerServiceTools,
]

export default aiTools
