export const metadata = { GET: { requireAuth: true }, PUT: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ contactId: string }> },
) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { contactId } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Resolve inbox conversation — try by ID first, then by contact_id
    let inboxConv = await knex('inbox_conversations')
      .where('id', contactId)
      .where('organization_id', auth.orgId)
      .first()

    if (!inboxConv) {
      inboxConv = await knex('inbox_conversations')
        .where('contact_id', contactId)
        .where('organization_id', auth.orgId)
        .first()
    }

    if (!inboxConv) return NextResponse.json({ ok: false, error: 'Conversation not found' }, { status: 404 })

    // Get contact info if available
    let contact = null
    if (inboxConv.contact_id) {
      const entity = await knex('customer_entities')
        .where('id', inboxConv.contact_id)
        .where('organization_id', auth.orgId)
        .whereNull('deleted_at')
        .first()
      if (entity) {
        contact = {
          id: entity.id,
          displayName: entity.display_name,
          email: entity.primary_email,
          phone: entity.primary_phone,
          lifecycleStage: entity.lifecycle_stage,
          source: entity.source,
        }
      }
    }

    // Fetch all message types in parallel for speed
    const [emailMessages, smsMessages, chatMessages] = await Promise.all([
      inboxConv.contact_id
        ? knex('email_messages')
            .where('contact_id', inboxConv.contact_id)
            .where('organization_id', auth.orgId)
            .orderBy('created_at', 'asc')
            .limit(100)
        : Promise.resolve([]),
      inboxConv.contact_id
        ? knex('sms_messages')
            .where('contact_id', inboxConv.contact_id)
            .where('organization_id', auth.orgId)
            .orderBy('created_at', 'asc')
            .limit(100)
        : Promise.resolve([]),
      inboxConv.chat_conversation_id
        ? knex('chat_messages')
            .where('conversation_id', inboxConv.chat_conversation_id)
            .orderBy('created_at', 'asc')
            .limit(100)
        : Promise.resolve([]),
    ])

    // Normalize all messages into unified format
    type UnifiedMessage = {
      id: string; channel: string; direction: string; subject: string | null
      body: string; bodyText: string | null; fromAddress: string; toAddress: string
      status: string; openedAt: string | null; clickedAt: string | null
      createdAt: string; isBot: boolean
    }

    const messages: UnifiedMessage[] = [
      ...emailMessages.map((m: any) => ({
        id: m.id,
        channel: 'email',
        direction: m.direction,
        subject: m.subject,
        body: m.body_html || m.body_text || '',
        bodyText: m.body_text,
        fromAddress: m.from_address || '',
        toAddress: m.to_address || '',
        status: m.status,
        openedAt: m.opened_at,
        clickedAt: m.clicked_at,
        createdAt: m.created_at,
        isBot: false,
      })),
      ...smsMessages.map((m: any) => ({
        id: m.id,
        channel: 'sms',
        direction: m.direction,
        subject: null,
        body: m.body || '',
        bodyText: m.body,
        fromAddress: m.from_number || '',
        toAddress: m.to_number || '',
        status: m.status,
        openedAt: null,
        clickedAt: null,
        createdAt: m.created_at,
        isBot: false,
      })),
      ...chatMessages.map((m: any) => ({
        id: m.id,
        channel: 'chat',
        direction: m.sender_type === 'visitor' ? 'inbound' : 'outbound',
        subject: null,
        body: m.message || '',
        bodyText: m.message,
        fromAddress: m.sender_type === 'visitor' ? (inboxConv.display_name || 'Visitor') : 'You',
        toAddress: m.sender_type === 'visitor' ? 'You' : (inboxConv.display_name || 'Visitor'),
        status: 'delivered',
        openedAt: null,
        clickedAt: null,
        createdAt: m.created_at,
        isBot: m.is_bot || false,
      })),
    ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

    // Determine available channels
    const availableChannels = {
      email: !!(contact?.email),
      sms: !!(contact?.phone),
      chat: !!inboxConv.chat_conversation_id,
    }

    return NextResponse.json({
      ok: true,
      data: {
        inboxConversationId: inboxConv.id,
        contact,
        chatConversationId: inboxConv.chat_conversation_id,
        availableChannels,
        status: inboxConv.status,
        messages,
      },
    })
  } catch (error) {
    console.error('[inbox.detail]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load conversation' }, { status: 500 })
  }
}

// Update conversation status or mark as read
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ contactId: string }> },
) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { contactId } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()

    // Find the conversation
    let inboxConv = await knex('inbox_conversations').where('id', contactId).where('organization_id', auth.orgId).first()
    if (!inboxConv) {
      inboxConv = await knex('inbox_conversations').where('contact_id', contactId).where('organization_id', auth.orgId).first()
    }
    if (!inboxConv) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

    const updates: Record<string, unknown> = { updated_at: new Date() }

    if (body.status) {
      updates.status = body.status
      // Also update chat conversation status if linked
      if (inboxConv.chat_conversation_id) {
        await knex('chat_conversations').where('id', inboxConv.chat_conversation_id).update({ status: body.status, updated_at: new Date() })
      }
    }

    if (body.markRead) {
      updates.unread_count = 0
    }

    await knex('inbox_conversations').where('id', inboxConv.id).update(updates)

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[inbox.update]', error)
    return NextResponse.json({ ok: false, error: 'Failed to update' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Inbox',
  summary: 'Unified inbox conversation detail',
  methods: {
    GET: { summary: 'Get unified conversation with all channel messages', tags: ['Inbox'] },
    PUT: { summary: 'Update conversation status or mark read', tags: ['Inbox'] },
  },
}
