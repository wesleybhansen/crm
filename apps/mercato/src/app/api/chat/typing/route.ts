import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export const metadata = { POST: { requireAuth: false }, OPTIONS: { requireAuth: false } }

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export async function POST(req: Request) {
  try {
    await bootstrap()
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const { conversationId, isTyping, sender } = await req.json()
    if (!conversationId) return new NextResponse(JSON.stringify({ ok: false }), { status: 400, headers: CORS_HEADERS })

    const updates: Record<string, unknown> = {}
    if (sender === 'visitor') {
      updates.visitor_typing = isTyping
      updates.visitor_typing_at = isTyping ? new Date() : null
    } else {
      updates.agent_typing = isTyping
      updates.agent_typing_at = isTyping ? new Date() : null
    }
    await knex('chat_conversations').where('id', conversationId).update(updates)
    return new NextResponse(JSON.stringify({ ok: true }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } })
  } catch {
    return new NextResponse(JSON.stringify({ ok: false }), { status: 500, headers: CORS_HEADERS })
  }
}
