// ORM-SKIP: uses raw pg query() — conversion requires SQL rewrite
export const metadata = { path: '/ai/conversations', GET: { requireAuth: true }, POST: { requireAuth: true }, PUT: { requireAuth: true }, DELETE: { requireAuth: true } }
/**
 * AI Assistant conversation history — list, create, update, archive, delete.
 */
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { query, queryOne } from '@/lib/db'
import crypto from 'node:crypto'

export async function GET() {
  const auth = await getAuthFromCookies()
  const userId = auth?.sub
  if (!auth?.tenantId || !auth?.orgId || !userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const conversations = await query(
    `SELECT id, title, is_archived, created_at, updated_at,
       (SELECT count(*)::int FROM jsonb_array_elements(messages)) as message_count
     FROM assistant_conversations
     WHERE user_id = $1 AND organization_id = $2
     ORDER BY updated_at DESC
     LIMIT 50`,
    [userId, auth.orgId]
  )

  return NextResponse.json({ ok: true, data: conversations })
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  const userId = auth?.sub
  if (!auth?.tenantId || !auth?.orgId || !userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { title, messages } = body

  const id = crypto.randomUUID()
  await query(
    `INSERT INTO assistant_conversations (id, tenant_id, organization_id, user_id, title, messages, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
    [id, auth.tenantId, auth.orgId, userId, title || 'New conversation', JSON.stringify(messages || [])]
  )

  return NextResponse.json({ ok: true, data: { id } })
}

export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  const userId = auth?.sub
  if (!auth?.tenantId || !auth?.orgId || !userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { id, title, messages, is_archived } = body

  if (!id) return NextResponse.json({ ok: false, error: 'Conversation ID required' }, { status: 400 })

  const updates: string[] = ['updated_at = now()']
  const params: any[] = []
  let paramIdx = 1

  if (title !== undefined) { updates.push(`title = $${paramIdx}`); params.push(title); paramIdx++ }
  if (messages !== undefined) { updates.push(`messages = $${paramIdx}`); params.push(JSON.stringify(messages)); paramIdx++ }
  if (is_archived !== undefined) { updates.push(`is_archived = $${paramIdx}`); params.push(is_archived); paramIdx++ }

  params.push(id, userId)

  await query(
    `UPDATE assistant_conversations SET ${updates.join(', ')} WHERE id = $${paramIdx} AND user_id = $${paramIdx + 1}`,
    params
  )

  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  const userId = auth?.sub
  if (!auth?.tenantId || !auth?.orgId || !userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  if (!id) {
    const body = await req.json().catch(() => ({}))
    if (body.id) {
      await query('DELETE FROM assistant_conversations WHERE id = $1 AND user_id = $2', [body.id, userId])
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ ok: false, error: 'ID required' }, { status: 400 })
  }

  await query('DELETE FROM assistant_conversations WHERE id = $1 AND user_id = $2', [id, userId])
  return NextResponse.json({ ok: true })
}
