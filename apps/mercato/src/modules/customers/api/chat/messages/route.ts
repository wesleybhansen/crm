export const metadata = { path: '/chat/messages', POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { conversationId, message } = body
    if (!conversationId || !message?.trim()) {
      return NextResponse.json({ ok: false, error: 'conversationId and message required' }, { status: 400 })
    }

    const conversation = await knex('chat_conversations')
      .where('id', conversationId)
      .andWhere('organization_id', auth.orgId)
      .first()
    if (!conversation) return NextResponse.json({ ok: false, error: 'Conversation not found' }, { status: 404 })

    const id = crypto.randomUUID()
    await knex('chat_messages').insert({
      id,
      conversation_id: conversationId,
      sender_type: 'business',
      message: message.trim(),
      created_at: new Date(),
    })

    await knex('chat_conversations')
      .where('id', conversationId)
      .update({ updated_at: new Date() })

    // Update unified inbox
    const { upsertInboxConversation } = await import('@/lib/inbox-conversation')
    upsertInboxConversation(knex, auth.orgId, auth.tenantId, {
      contactId: conversation.contact_id || null,
      chatConversationId: conversationId,
      channel: 'chat',
      preview: message.trim(),
      direction: 'outbound',
      displayName: conversation.visitor_name || conversation.visitor_email || 'Visitor',
      avatarEmail: conversation.visitor_email,
    }).catch(() => {})

    const msg = await knex('chat_messages').where('id', id).first()
    return NextResponse.json({ ok: true, data: msg }, { status: 201 })
  } catch (error) {
    console.error('[chat.messages.send]', error)
    return NextResponse.json({ ok: false, error: 'Failed to send message' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Chat',
  summary: 'Send a chat message from the business side',
  methods: {
    POST: { summary: 'Send a reply to a chat conversation', tags: ['Chat'] },
  },
}
