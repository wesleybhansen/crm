export const metadata = { path: '/chat/conversations', GET: { requireAuth: true }, PUT: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const conversationId = url.searchParams.get('conversationId')

    if (conversationId) {
      const conversation = await knex('chat_conversations')
        .where('id', conversationId)
        .andWhere('organization_id', auth.orgId)
        .first()
      if (!conversation) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

      const messages = await knex('chat_messages')
        .where('conversation_id', conversationId)
        .orderBy('created_at', 'asc')
      return NextResponse.json({ ok: true, data: { conversation, messages } })
    }

    const statusFilter = url.searchParams.get('status') || 'all'

    const conversationsQuery = knex('chat_conversations as cc')
      .select(
        'cc.id',
        'cc.widget_id',
        'cc.contact_id',
        'cc.visitor_name',
        'cc.visitor_email',
        'cc.status',
        'cc.created_at',
        'cc.updated_at',
        'cc.visitor_typing',
        'cc.agent_typing',
        'cc.visitor_typing_at',
        'cc.agent_typing_at',
        'cw.name as widget_name',
      )
      .select(
        knex.raw(`(
          SELECT message FROM chat_messages
          WHERE conversation_id = cc.id
          ORDER BY created_at DESC LIMIT 1
        ) as last_message`),
      )
      .select(
        knex.raw(`(
          SELECT sender_type FROM chat_messages
          WHERE conversation_id = cc.id
          ORDER BY created_at DESC LIMIT 1
        ) as last_sender_type`),
      )
      .select(
        knex.raw(`(
          SELECT created_at FROM chat_messages
          WHERE conversation_id = cc.id
          ORDER BY created_at DESC LIMIT 1
        ) as last_message_at`),
      )
      .select(
        knex.raw(`(
          SELECT COUNT(*)::int FROM chat_messages
          WHERE conversation_id = cc.id
        ) as message_count`),
      )
      .leftJoin('chat_widgets as cw', 'cw.id', 'cc.widget_id')
      .where('cc.organization_id', auth.orgId)
      .orderBy('cc.updated_at', 'desc')
      .limit(100)

    if (statusFilter !== 'all') {
      conversationsQuery.andWhere('cc.status', statusFilter)
    }

    const conversations = await conversationsQuery
    return NextResponse.json({ ok: true, data: conversations })
  } catch (error) {
    console.error('[chat.conversations.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load conversations' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { conversationId, status } = body

    if (!conversationId || !status) {
      return NextResponse.json({ ok: false, error: 'conversationId and status are required' }, { status: 400 })
    }

    const allowedStatuses = ['open', 'closed']
    if (!allowedStatuses.includes(status)) {
      return NextResponse.json({ ok: false, error: `Invalid status. Allowed: ${allowedStatuses.join(', ')}` }, { status: 400 })
    }

    const updated = await knex('chat_conversations')
      .where('id', conversationId)
      .andWhere('organization_id', auth.orgId)
      .update({ status, updated_at: new Date() })

    if (!updated) {
      return NextResponse.json({ ok: false, error: 'Conversation not found' }, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[chat.conversations.update]', error)
    return NextResponse.json({ ok: false, error: 'Failed to update conversation' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Chat',
  summary: 'List chat conversations or get messages for a conversation',
  methods: {
    GET: { summary: 'List conversations with last message preview', tags: ['Chat'] },
    PUT: { summary: 'Update conversation status (open/closed)', tags: ['Chat'] },
  },
}
