export const metadata = { path: '/inbox/notes', GET: { requireAuth: true }, POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { InboxConversation, InboxNote } from '../../../data/schema'

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const url = new URL(req.url)
    const conversationId = url.searchParams.get('conversationId')
    if (!conversationId) return NextResponse.json({ ok: false, error: 'conversationId required' }, { status: 400 })

    const conv = await em.findOne(InboxConversation, { id: conversationId, organizationId: auth.orgId, tenantId: auth.tenantId })
    if (!conv) return NextResponse.json({ ok: false, error: 'Conversation not found' }, { status: 404 })

    const notes = await em.find(InboxNote, { inboxConversationId: conversationId }, { orderBy: { createdAt: 'asc' } })

    return NextResponse.json({ ok: true, data: notes.map(n => ({
      id: n.id, inbox_conversation_id: n.inboxConversationId, user_id: n.userId,
      user_name: n.userName, content: n.content, created_at: n.createdAt,
    })) })
  } catch (error) {
    console.error('[inbox.notes.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const body = await req.json()
    const { conversationId, content } = body
    if (!conversationId || !content?.trim()) return NextResponse.json({ ok: false, error: 'conversationId and content required' }, { status: 400 })

    const conv = await em.findOne(InboxConversation, { id: conversationId, organizationId: auth.orgId, tenantId: auth.tenantId })
    if (!conv) return NextResponse.json({ ok: false, error: 'Conversation not found' }, { status: 404 })

    // Get user name via knex (users table may have encrypted fields)
    const knex = em.getKnex()
    const user = await knex('users').where('id', auth.sub).first()

    const note = em.create(InboxNote, {
      inboxConversationId: conversationId,
      userId: auth.sub!,
      userName: user?.name || user?.email || 'Team',
      content: content.trim(),
    })
    em.persist(note)
    await em.flush()

    return NextResponse.json({ ok: true, data: {
      id: note.id, inbox_conversation_id: note.inboxConversationId, user_id: note.userId,
      user_name: note.userName, content: note.content, created_at: note.createdAt,
    } }, { status: 201 })
  } catch (error) {
    console.error('[inbox.notes.create]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
