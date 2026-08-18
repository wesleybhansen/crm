import crypto from 'crypto'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import { GtmAuditEvent, GtmChatMessage, GtmChatThread, GtmWorkspace } from '../../data/entities'
import type { CampaignEm, GtmCtx } from '../campaign/build'

/*
 * Strategist chat persistence (GTM-SPEC-04 section 2.3). The CRM owns durable
 * GTM chat state; the hub runs the agent loop statelessly and persists each
 * turn here through the /internal/gtm/chat ops.
 *
 * Invariants enforced here:
 *  - Thread = workspace-scoped. Creating a thread requires a live workspace in
 *    the caller's org+tenant; a foreign / missing workspace is thread-opaque.
 *  - Messages are an append-only, gap-free sequence keyed by (thread_id, seq).
 *    appendMessage allocates seq = max(existing) + 1 and inserts inside a
 *    transaction; the (thread_id, seq) unique index makes the allocation
 *    race-safe (a losing concurrent insert collides and is retried once).
 *  - Every mutation self-scopes by organization_id + tenant_id and writes a
 *    redacted GtmAuditEvent (no message body text) on thread create and on
 *    each append.
 *
 * Roles: user | assistant | tool. The agent NEVER approves/launches/sends; a
 * 'tool' row records a read/prepare tool result the loop fetched, never a
 * spend. Nothing here can charge credits or send email.
 */

export const GTM_CHAT_THREAD_LIST_CAP = 50
const APPEND_MAX_RETRIES = 3

export const GTM_CHAT_ROLES = ['user', 'assistant', 'tool'] as const
export type GtmChatRole = (typeof GTM_CHAT_ROLES)[number]

export class GtmChatError extends Error {
  constructor(
    public code: 'workspace_not_found' | 'thread_not_found' | 'invalid_role' | 'invalid_content',
    message: string,
  ) {
    super(message)
    this.name = 'GtmChatError'
  }
}

// Wider EM view: MikroORM supports orderBy/limit on find; the CampaignEm
// interface omits them, so we narrow-cast exactly like lib/versions.ts.
type ListEm = CampaignEm & {
  find<T extends object>(
    c: new () => T,
    w: Record<string, unknown>,
    o?: { orderBy?: Record<string, 'asc' | 'desc'>; limit?: number },
  ): Promise<T[]>
}

function assertRole(role: string): GtmChatRole {
  if (!(GTM_CHAT_ROLES as readonly string[]).includes(role)) {
    throw new GtmChatError('invalid_role', 'Message role must be user, assistant, or tool')
  }
  return role as GtmChatRole
}

function assertContent(content: unknown): Record<string, unknown> {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new GtmChatError('invalid_content', 'Message content must be a JSON object')
  }
  return content as Record<string, unknown>
}

async function requireWorkspace(em: CampaignEm, ctx: GtmCtx, workspaceId: string): Promise<GtmWorkspace> {
  const workspace = await em.findOne(GtmWorkspace, {
    id: workspaceId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!workspace) throw new GtmChatError('workspace_not_found', 'Workspace not found')
  return workspace
}

async function requireThread(em: CampaignEm, ctx: GtmCtx, threadId: string): Promise<GtmChatThread> {
  const thread = await em.findOne(GtmChatThread, {
    id: threadId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!thread) throw new GtmChatError('thread_not_found', 'Thread not found')
  return thread
}

function auditData(
  ctx: GtmCtx,
  action: string,
  objectType: string,
  objectId: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    actor: 'user_id',
    actorUserId: ctx.userId,
    action,
    objectType,
    objectId,
    requestId: ctx.requestId ?? null,
    metadata,
  }
}

export function threadShape(row: GtmChatThread) {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    title: row.title ?? null,
    status: row.status,
    last_message_at: row.lastMessageAt ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

export function messageShape(row: GtmChatMessage) {
  return {
    id: row.id,
    thread_id: row.threadId,
    role: row.role,
    content: row.content,
    tool_ref: row.toolRef ?? null,
    seq: row.seq,
    created_at: row.createdAt,
  }
}

export type CreateThreadInput = { workspaceId: string; title?: string | null }

// Create a chat thread in a live workspace. last_message_at is seeded to the
// create time so the newest-first list ordering is always well defined.
export async function createThread(em: CampaignEm, ctx: GtmCtx, input: CreateThreadInput): Promise<GtmChatThread> {
  await requireWorkspace(em, ctx, input.workspaceId)
  const title = (input.title ?? '').trim() || null

  return em.transactional(async (tem) => {
    const now = new Date()
    const thread = tem.create(GtmChatThread, {
      id: crypto.randomUUID(),
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      workspaceId: input.workspaceId,
      title,
      status: 'active',
      lastMessageAt: now,
    })
    tem.persist(thread)
    tem.persist(
      tem.create(
        GtmAuditEvent,
        auditData(ctx, 'gtm.chat.thread_created', 'gtm_chat_thread', thread.id, {
          workspace_id: input.workspaceId,
        }),
      ),
    )
    await tem.flush()
    return thread
  })
}

// Workspace-scoped thread history, newest first, capped.
export async function listThreads(em: CampaignEm, ctx: GtmCtx, workspaceId: string): Promise<GtmChatThread[]> {
  return (em as ListEm).find(
    GtmChatThread,
    {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      workspaceId,
      deletedAt: null,
    },
    { orderBy: { lastMessageAt: 'desc', createdAt: 'desc' }, limit: GTM_CHAT_THREAD_LIST_CAP },
  )
}

// Thread-scoped message history, chronological (seq ascending).
export async function getMessages(em: CampaignEm, ctx: GtmCtx, threadId: string): Promise<GtmChatMessage[]> {
  await requireThread(em, ctx, threadId)
  return (em as ListEm).find(
    GtmChatMessage,
    {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      threadId,
      deletedAt: null,
    },
    { orderBy: { seq: 'asc' } },
  )
}

async function nextSeq(em: CampaignEm, ctx: GtmCtx, threadId: string): Promise<number> {
  const rows = await (em as ListEm).find(
    GtmChatMessage,
    { organizationId: ctx.organizationId, tenantId: ctx.tenantId, threadId, deletedAt: null },
    { orderBy: { seq: 'desc' }, limit: 1 },
  )
  return (rows[0]?.seq ?? 0) + 1
}

export type AppendMessageInput = {
  threadId: string
  role: string
  content: Record<string, unknown>
  toolRef?: string | null
}

// Append-safe: allocates seq = max + 1 and inserts in one transaction. A
// concurrent insert that grabs the same seq trips the (thread_id, seq) unique
// index; we retry with a freshly recomputed seq a bounded number of times.
export async function appendMessage(em: CampaignEm, ctx: GtmCtx, input: AppendMessageInput): Promise<GtmChatMessage> {
  const thread = await requireThread(em, ctx, input.threadId)
  const role = assertRole(input.role)
  const content = assertContent(input.content)
  const toolRef = (input.toolRef ?? '').trim() || null

  let lastErr: unknown = null
  for (let attempt = 0; attempt < APPEND_MAX_RETRIES; attempt += 1) {
    const seq = await nextSeq(em, ctx, input.threadId)
    try {
      return await em.transactional(async (tem) => {
        const now = new Date()
        const message = tem.create(GtmChatMessage, {
          id: crypto.randomUUID(),
          organizationId: ctx.organizationId,
          tenantId: ctx.tenantId,
          threadId: input.threadId,
          role,
          content,
          toolRef,
          seq,
        })
        tem.persist(message)
        thread.lastMessageAt = now
        tem.persist(thread)
        tem.persist(
          tem.create(
            GtmAuditEvent,
            auditData(ctx, 'gtm.chat.message_appended', 'gtm_chat_message', message.id, {
              thread_id: input.threadId,
              role,
              seq,
              ...(toolRef ? { tool_ref: toolRef } : {}),
            }),
          ),
        )
        await tem.flush()
        return message
      })
    } catch (err) {
      if (err instanceof UniqueConstraintViolationException) {
        lastErr = err
        continue
      }
      throw err
    }
  }
  throw lastErr ?? new GtmChatError('invalid_content', 'Could not append message')
}
