export const metadata = { path: '/chat/messages', POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { ChatConversation, ChatMessage } from '../../../data/schema'

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const body = await req.json()
    const { conversationId, message } = body
    if (!conversationId || !message?.trim()) {
      return NextResponse.json({ ok: false, error: 'conversationId and message required' }, { status: 400 })
    }

    const conversation = await em.findOne(ChatConversation, {
      id: conversationId, organizationId: auth.orgId, tenantId: auth.tenantId,
    })
    if (!conversation) return NextResponse.json({ ok: false, error: 'Conversation not found' }, { status: 404 })

    const msg = em.create(ChatMessage, {
      conversationId,
      senderType: 'business',
      message: message.trim(),
    })
    em.persist(msg)
    conversation.updatedAt = new Date()
    await em.flush()

    // Update unified inbox (stays on knex — cross-module helper)
    const knex = em.getKnex()
    const { upsertInboxConversation } = await import('@/lib/inbox-conversation')
    upsertInboxConversation(knex, auth.orgId, auth.tenantId, {
      contactId: conversation.contactId || null,
      chatConversationId: conversationId,
      channel: 'chat',
      preview: message.trim(),
      direction: 'outbound',
      displayName: conversation.visitorName || conversation.visitorEmail || 'Visitor',
      avatarEmail: conversation.visitorEmail,
    }).catch(() => {})

    return NextResponse.json({ ok: true, data: {
      id: msg.id, conversation_id: msg.conversationId,
      sender_type: msg.senderType, message: msg.message, created_at: msg.createdAt,
    } }, { status: 201 })
  } catch (error) {
    console.error('[chat.messages.send]', error)
    return NextResponse.json({ ok: false, error: 'Failed to send message' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Chat',
  summary: 'Send a chat message from the business side',
  methods: { POST: { summary: 'Send a reply to a chat conversation', tags: ['Chat'] } },
}
