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
      // Chat lives in Customer Service now — keep it out of the personal inbox.
      .whereNot('inbox_conversations.last_message_channel', 'chat')
      // Exclude the Customer Service support mailbox so its mail does not leak
      // into the personal inbox. Rows tagged customer_service belong to the CS
      // queue; untagged (NULL) rows are the personal inbox.
      .where(function (this: import('knex').Knex.QueryBuilder) {
        this.whereNull('inbox_conversations.source_mailbox_purpose')
          .orWhere('inbox_conversations.source_mailbox_purpose', '!=', 'customer_service')
      })

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

    // Per-conversation AI state for the list badges + the "Needs review" filter.
    // Derive from:
    //   - inbox_conversations.inbox_draft_skip_reason = 'automated' -> 'skipped'
    //   - inbox_proposal_actions (feature_source='inbox', action_type='draft_reply')
    //     for this conversation: pending+not-flagged -> 'draft',
    //     pending+flagged -> 'flagged', sent -> 'autosent'.
    // One extra grouped query (not N+1): pick the newest relevant action per
    // conversation id, scoped to the conversation ids in this page of results.
    const convIds: string[] = conversations.map((c: any) => c.id).filter(Boolean)
    const actionByConv = new Map<string, { status: string; flagged: boolean }>()
    if (convIds.length > 0) {
      // DISTINCT ON the conversation id, newest first, so each conversation maps
      // to its most recent inbox draft action in a single org-scoped query.
      const actions = await knex('inbox_proposal_actions')
        .where('organization_id', auth.orgId)
        .where('tenant_id', auth.tenantId)
        .where('action_type', 'draft_reply')
        .whereRaw(`metadata->>'feature_source' = ?`, ['inbox'])
        .whereRaw(`payload->>'conversationId' = ANY(?)`, [convIds])
        .select(
          knex.raw(`DISTINCT ON (payload->>'conversationId') payload->>'conversationId' AS conversation_id`),
          'status',
          knex.raw(`(metadata->>'flagged' = 'true') AS flagged`),
        )
        .orderByRaw(`payload->>'conversationId', created_at DESC`)
      for (const a of actions) {
        if (a.conversation_id) actionByConv.set(a.conversation_id, { status: a.status, flagged: a.flagged === true || a.flagged === 't' })
      }
    }

    const aiStateFor = (c: any): 'draft' | 'flagged' | 'autosent' | 'skipped' | 'manual' | null => {
      const act = actionByConv.get(c.id)
      if (act) {
        if (act.status === 'pending') return act.flagged ? 'flagged' : 'draft'
        if (act.status === 'sent') return 'autosent'
        // dismissed / rejected actions fall through to the skip/manual checks.
      }
      if (c.inbox_draft_skip_reason === 'automated') return 'skipped'
      return null
    }

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
        aiState: aiStateFor(c),
      })),
    })
  } catch (error) {
    console.error('[inbox.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load inbox' }, { status: 500 })
  }
}

// Bulk actions: close, reopen, markRead, delete multiple conversations
export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { ids, action } = body

    if (!Array.isArray(ids) || ids.length === 0) return NextResponse.json({ ok: false, error: 'ids array required' }, { status: 400 })
    if (!['close', 'reopen', 'markRead', 'delete'].includes(action)) {
      return NextResponse.json({ ok: false, error: 'action must be close, reopen, markRead, or delete' }, { status: 400 })
    }

    const scopedQuery = () => knex('inbox_conversations')
      .whereIn('id', ids)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)

    if (action === 'delete') {
      const deleted = await scopedQuery().del()
      return NextResponse.json({ ok: true, deleted })
    }

    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (action === 'close') updates.status = 'closed'
    else if (action === 'reopen') updates.status = 'open'
    else if (action === 'markRead') updates.unread_count = 0

    const updated = await scopedQuery().update(updates)
    return NextResponse.json({ ok: true, updated })
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
