// ORM-SKIP: complex multi-table logic or writes to non-existent columns

import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import type { EntityManager } from '@mikro-orm/postgresql'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// Public widget endpoint that mutates conversation state — per-IP rate limit
// keeps anonymous visitors from flooding it (typing pings are frequent, so the
// limit is generous).
export const metadata = { path: '/chat/typing',
  POST: { requireAuth: false, rateLimit: { points: 60, duration: 60, keyPrefix: 'chat-typing' } },
  OPTIONS: { requireAuth: false },
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

function reply(body: Record<string, unknown>, status = 200) {
  return new NextResponse(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } })
}

// Constant-time compare that never throws on length/encoding mismatch.
function tokensMatch(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

type Conversation = {
  id: string
  organization_id: string
  tenant_id: string | null
  widget_id: string | null
  visitor_token?: string | null
}

/**
 * Who may set which typing flag (security sweep 2026-09-25, medium 8: this
 * updated any conversation by id with no check at all):
 *  - the visitor flag: the visitor holding the conversation's possession token
 *    (same rule as /api/chat/public; conversations created before tokens
 *    existed have none and stay open, as there);
 *  - the agent flag: a signed-in CRM user of the conversation's organization.
 * A widgetId, when sent, must match the conversation's widget. Every refusal
 * answers 404 so conversation ids cannot be probed.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : ''
    if (!conversationId) return reply({ ok: false }, 400)
    const isTyping = body?.isTyping === true
    const sender = body?.sender === 'visitor' ? 'visitor' : 'agent'

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    let conversation: Conversation | undefined
    try {
      conversation = await knex('chat_conversations').where('id', conversationId).first()
    } catch {
      conversation = undefined // malformed id
    }
    if (!conversation) return reply({ ok: false }, 404)
    if (typeof body?.widgetId === 'string' && body.widgetId && body.widgetId !== conversation.widget_id) {
      return reply({ ok: false }, 404)
    }

    const updates: Record<string, unknown> = {}
    if (sender === 'visitor') {
      if (conversation.visitor_token && !tokensMatch(conversation.visitor_token, body?.visitorToken)) {
        return reply({ ok: false }, 404)
      }
      updates.visitor_typing = isTyping
      updates.visitor_typing_at = isTyping ? new Date() : null
    } else {
      const auth = await getAuthFromRequest(req)
      if (!auth?.orgId || auth.orgId !== conversation.organization_id) return reply({ ok: false }, 404)
      if (auth.tenantId && conversation.tenant_id && auth.tenantId !== conversation.tenant_id) return reply({ ok: false }, 404)
      updates.agent_typing = isTyping
      updates.agent_typing_at = isTyping ? new Date() : null
    }
    await knex('chat_conversations')
      .where('id', conversation.id)
      .where('organization_id', conversation.organization_id)
      .update(updates)
    return reply({ ok: true })
  } catch {
    return reply({ ok: false }, 500)
  }
}
