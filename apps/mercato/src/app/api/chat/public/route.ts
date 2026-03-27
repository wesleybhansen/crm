import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'

export const metadata = {
  GET: { requireAuth: false },
  POST: { requireAuth: false },
}

export async function POST(req: Request) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()

    if (body.conversationId && body.message) {
      const conversation = await knex('chat_conversations').where('id', body.conversationId).first()
      if (!conversation) return NextResponse.json({ ok: false, error: 'Conversation not found' }, { status: 404 })

      const msgId = crypto.randomUUID()
      await knex('chat_messages').insert({
        id: msgId,
        conversation_id: body.conversationId,
        sender_type: 'visitor',
        message: body.message.trim(),
        created_at: new Date(),
      })
      await knex('chat_conversations')
        .where('id', body.conversationId)
        .update({ updated_at: new Date() })

      return NextResponse.json({ ok: true, data: { id: msgId } }, { status: 201 })
    }

    const { widgetId, visitorName, visitorEmail, message } = body
    if (!widgetId || !message?.trim()) {
      return NextResponse.json({ ok: false, error: 'widgetId and message are required' }, { status: 400 })
    }

    const widget = await knex('chat_widgets').where('id', widgetId).andWhere('is_active', true).first()
    if (!widget) return NextResponse.json({ ok: false, error: 'Widget not found or inactive' }, { status: 404 })

    let contactId: string | null = null
    if (visitorEmail) {
      const existingContact = await knex('customer_entities')
        .where('organization_id', widget.organization_id)
        .andWhere('primary_email', visitorEmail.trim().toLowerCase())
        .whereNull('deleted_at')
        .first()

      if (existingContact) {
        contactId = existingContact.id
      } else {
        contactId = crypto.randomUUID()
        await knex('customer_entities').insert({
          id: contactId,
          tenant_id: widget.tenant_id,
          organization_id: widget.organization_id,
          kind: 'person',
          display_name: visitorName?.trim() || visitorEmail.trim(),
          primary_email: visitorEmail.trim().toLowerCase(),
          source: 'chat_widget',
          status: 'active',
          email_status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        })
      }
    }

    const conversationId = crypto.randomUUID()
    await knex('chat_conversations').insert({
      id: conversationId,
      tenant_id: widget.tenant_id,
      organization_id: widget.organization_id,
      widget_id: widgetId,
      contact_id: contactId,
      visitor_name: visitorName?.trim() || null,
      visitor_email: visitorEmail?.trim()?.toLowerCase() || null,
      status: 'open',
      created_at: new Date(),
      updated_at: new Date(),
    })

    const msgId = crypto.randomUUID()
    await knex('chat_messages').insert({
      id: msgId,
      conversation_id: conversationId,
      sender_type: 'visitor',
      message: message.trim(),
      created_at: new Date(),
    })

    return NextResponse.json({
      ok: true,
      data: {
        conversationId,
        greeting: widget.greeting_message || 'Hi there! How can we help you today?',
      },
    }, { status: 201 })
  } catch (error) {
    console.error('[chat.public.post]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function GET(req: Request) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const conversationId = url.searchParams.get('conversationId')
    if (!conversationId) return NextResponse.json({ ok: false, error: 'conversationId required' }, { status: 400 })

    const conversation = await knex('chat_conversations').where('id', conversationId).first()
    if (!conversation) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

    const messages = await knex('chat_messages')
      .where('conversation_id', conversationId)
      .orderBy('created_at', 'asc')
      .select('id', 'sender_type', 'message', 'created_at')

    return NextResponse.json({ ok: true, data: { messages } })
  } catch (error) {
    console.error('[chat.public.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Chat',
  summary: 'Public chat API for website visitors',
  methods: {
    POST: { summary: 'Start a conversation or send a visitor message', tags: ['Chat'] },
    GET: { summary: 'Poll messages for a conversation', tags: ['Chat'] },
  },
}
