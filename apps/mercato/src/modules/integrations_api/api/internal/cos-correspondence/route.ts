import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

/* Internal service endpoint (shared NOLI_INTERNAL_SERVICE_SECRET) that lists the
 * email correspondence handled by the Chief of Staff's desk mailbox — the
 * conversations ingested from a customer_service-purpose inbox — as a list of
 * threads. The hub inbox's "CoS correspondence" tab shows these; expanding one
 * loads the full back-and-forth via the existing /internal/contact-context
 * endpoint (keyed by contactId). Read-only, org + tenant scoped. */

export const metadata = {
  path: '/internal/cos-correspondence',
  POST: { requireAuth: false },
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

type Auth = { userId: string; orgId: string; tenantId: string }
async function resolveAuth(noliUserId: string): Promise<Auth | null> {
  const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
  const noliUser = await findNoliUserById(noliUserId)
  if (!noliUser?.clerk_user_id) return null
  const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
  const a = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
  if (!a?.userId || !a?.orgId || !a?.tenantId) return null
  return { userId: String(a.userId), orgId: String(a.orgId), tenantId: String(a.tenantId) }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Knex = any

export async function POST(req: Request) {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  if (!secret || !safeEq(authHeader, `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim() : ''
  if (!noliUserId) return NextResponse.json({ ok: false, error: 'noliUserId is required' }, { status: 400 })
  const rawLimit = typeof body.limit === 'number' ? body.limit : 40
  const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)))

  try {
    const auth = await resolveAuth(noliUserId)
    // No CRM account (or desk) is not an error — the tab just shows empty.
    if (!auth) return NextResponse.json({ ok: true, data: [] })
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex() as Knex

    const rows = await knex('inbox_conversations')
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .where('source_mailbox_purpose', 'customer_service')
      .orderBy('last_message_at', 'desc')
      .limit(limit)
      .select(
        'id',
        'contact_id',
        'display_name',
        'avatar_email',
        'last_message_preview',
        'last_message_direction',
        'last_message_channel',
        'last_message_at',
        'unread_count',
      )

    const data = rows.map((c: Record<string, unknown>) => ({
      id: String(c.id),
      contactId: c.contact_id ? String(c.contact_id) : null,
      name: (c.display_name as string) || (c.avatar_email as string) || 'Unknown',
      handle: (c.avatar_email as string) || null,
      preview: String(c.last_message_preview || '').slice(0, 240),
      direction: (c.last_message_direction as string) || null,
      channel: (c.last_message_channel as string) || 'email',
      at: c.last_message_at,
      // Inbound = the last word was theirs, so the desk still owes a reply.
      awaitingReply: c.last_message_direction === 'inbound',
      unread: Number(c.unread_count || 0) > 0,
    }))

    return NextResponse.json({ ok: true, data })
  } catch (error) {
    console.error('[internal.cos-correspondence]', error)
    return NextResponse.json({ ok: false, error: 'Server error' }, { status: 500 })
  }
}
