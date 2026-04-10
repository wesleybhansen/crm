export const metadata = { GET: { requireAuth: true }, POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'

// GET: List notes for a conversation
export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const conversationId = url.searchParams.get('conversationId')
    if (!conversationId) return NextResponse.json({ ok: false, error: 'conversationId required' }, { status: 400 })

    // Verify conversation belongs to this org
    const conv = await knex('inbox_conversations').where('id', conversationId).where('organization_id', auth.orgId).first()
    if (!conv) return NextResponse.json({ ok: false, error: 'Conversation not found' }, { status: 404 })

    const notes = await knex('inbox_notes')
      .where('inbox_conversation_id', conversationId)
      .orderBy('created_at', 'asc')

    return NextResponse.json({ ok: true, data: notes })
  } catch (error) {
    console.error('[inbox.notes.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

// POST: Add a note
export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { conversationId, content } = body
    if (!conversationId || !content?.trim()) return NextResponse.json({ ok: false, error: 'conversationId and content required' }, { status: 400 })

    // Verify conversation belongs to org
    const conv = await knex('inbox_conversations').where('id', conversationId).where('organization_id', auth.orgId).first()
    if (!conv) return NextResponse.json({ ok: false, error: 'Conversation not found' }, { status: 404 })

    // Get user name
    const user = await knex('users').where('id', auth.sub).first()

    const id = crypto.randomUUID()
    await knex('inbox_notes').insert({
      id,
      inbox_conversation_id: conversationId,
      user_id: auth.sub,
      user_name: user?.name || user?.email || 'Team',
      content: content.trim(),
      created_at: new Date(),
    })

    const note = await knex('inbox_notes').where('id', id).first()
    return NextResponse.json({ ok: true, data: note }, { status: 201 })
  } catch (error) {
    console.error('[inbox.notes.create]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
