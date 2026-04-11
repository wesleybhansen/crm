// ORM-SKIP: complex multi-table logic or writes to non-existent columns
export const metadata = { path: '/inbox', GET: { requireAuth: true }, PUT: { requireAuth: true } }

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

    const search = url.searchParams.get('search') || ''
    const channel = url.searchParams.get('channel') || ''
    const status = url.searchParams.get('status') || 'open'
    const deepSearch = url.searchParams.get('deep') === '1'

    let query = knex('inbox_conversations')
      .where('inbox_conversations.organization_id', auth.orgId)
      .where('inbox_conversations.tenant_id', auth.tenantId)

    if (status && status !== 'all') {
      query = query.where('inbox_conversations.status', status)
    }

    if (channel && channel !== 'all') {
      query = query.where('inbox_conversations.last_message_channel', channel)
    }

    if (search) {
      if (deepSearch) {
        // Deep search: find conversations whose contact has messages containing the search term
        const contactIds = await knex.raw(`
          SELECT DISTINCT contact_id FROM (
            SELECT contact_id FROM email_messages
              WHERE organization_id = ? AND (subject ILIKE ? OR body_text ILIKE ? OR body_html ILIKE ?)
            UNION
            SELECT contact_id FROM sms_messages
              WHERE organization_id = ? AND body ILIKE ?
          ) sub WHERE contact_id IS NOT NULL
        `, [auth.orgId, `%${search}%`, `%${search}%`, `%${search}%`, auth.orgId, `%${search}%`])

        // Also search chat messages
        const chatConvIds = await knex.raw(`
          SELECT DISTINCT cm.conversation_id FROM chat_messages cm
          JOIN chat_conversations cc ON cc.id = cm.conversation_id
          WHERE cc.organization_id = ? AND cm.message ILIKE ?
        `, [auth.orgId, `%${search}%`])

        const cIds = contactIds.rows.map((r: any) => r.contact_id)
        const ccIds = chatConvIds.rows.map((r: any) => r.conversation_id)

        query = query.where(function () {
          this.where('inbox_conversations.display_name', 'ilike', `%${search}%`)
            .orWhere('inbox_conversations.avatar_email', 'ilike', `%${search}%`)
          if (cIds.length > 0) this.orWhereIn('inbox_conversations.contact_id', cIds)
          if (ccIds.length > 0) this.orWhereIn('inbox_conversations.chat_conversation_id', ccIds)
        })
      } else {
        query = query.where(function () {
          this.where('inbox_conversations.display_name', 'ilike', `%${search}%`)
            .orWhere('inbox_conversations.avatar_email', 'ilike', `%${search}%`)
        })
      }
    }

    const conversations = await query
      .select('inbox_conversations.*')
      .orderBy('inbox_conversations.last_message_at', 'desc')
      .limit(50)

    return NextResponse.json({
      ok: true,
      data: conversations.map((c: any) => ({
        id: c.id,
        contactId: c.contact_id,
        chatConversationId: c.chat_conversation_id,
        status: c.status,
        lastMessageAt: c.last_message_at,
        lastMessageChannel: c.last_message_channel,
        lastMessagePreview: c.last_message_preview,
        lastMessageDirection: c.last_message_direction,
        unreadCount: c.unread_count,
        displayName: c.display_name,
        avatarEmail: c.avatar_email,
        avatarPhone: c.avatar_phone,
      })),
    })
  } catch (error) {
    console.error('[inbox.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load inbox' }, { status: 500 })
  }
}

// Bulk actions: close, reopen, archive multiple conversations
export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { ids, action } = body

    if (!Array.isArray(ids) || ids.length === 0) return NextResponse.json({ ok: false, error: 'ids array required' }, { status: 400 })
    if (!['close', 'reopen'].includes(action)) return NextResponse.json({ ok: false, error: 'action must be close or reopen' }, { status: 400 })

    const newStatus = action === 'close' ? 'closed' : 'open'
    await knex('inbox_conversations')
      .whereIn('id', ids)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .update({ status: newStatus, updated_at: new Date() })

    return NextResponse.json({ ok: true, updated: ids.length })
  } catch (error) {
    console.error('[inbox.bulk]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Inbox',
  summary: 'Unified inbox conversations',
  methods: {
    GET: { summary: 'List unified inbox conversations', tags: ['Inbox'] },
    PUT: { summary: 'Bulk update conversations', tags: ['Inbox'] },
  },
}
