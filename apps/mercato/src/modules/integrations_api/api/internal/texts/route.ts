import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { sendSmsReply } from '@/modules/customers/lib/send-sms-reply'

/* Internal service endpoint (shared NOLI_INTERNAL_SERVICE_SECRET) for the hub's
 * Unified Inbox Texts tab: report whether the org's Twilio SMS line is set up,
 * list recent texts, and send a text via the org's dedicated number. Reuses the
 * CRM's Twilio rails (twilio_connections + customer_service_settings.cs_sms_number)
 * and the same send path as the customer-service drafter. */

export const metadata = {
  path: '/internal/texts',
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
  const op = typeof body.op === 'string' ? body.op : ''
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim() : ''
  if (!op || !noliUserId) return NextResponse.json({ ok: false, error: 'op and noliUserId are required' }, { status: 400 })

  try {
    const auth = await resolveAuth(noliUserId)
    if (!auth) return NextResponse.json({ ok: false, error: 'no CRM account for this user' }, { status: 404 })
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex() as Knex

    if (op === 'status') {
      const conn = await knex('twilio_connections').where('organization_id', auth.orgId).where('is_active', true).first()
      const settings = await knex('customer_service_settings').where('organization_id', auth.orgId).first()
      return NextResponse.json({ ok: true, data: { connected: Boolean(conn), number: settings?.cs_sms_number || null } })
    }

    if (op === 'messages') {
      const limit = Math.min(100, Math.max(1, Number(body.limit) || 50))
      const rows = await knex('sms_messages')
        .where('organization_id', auth.orgId)
        .orderBy('created_at', 'desc')
        .limit(limit)
        .select('id', 'direction', 'from_number', 'to_number', 'body', 'created_at')
      return NextResponse.json({ ok: true, data: rows })
    }

    if (op === 'send') {
      const to = typeof body.to === 'string' ? body.to : ''
      const text = typeof body.body === 'string' ? body.body : ''
      if (!to || !text.trim()) return NextResponse.json({ ok: false, error: 'A phone number and a message are required' }, { status: 400 })
      const r = await sendSmsReply(knex, auth.orgId, auth.tenantId, { to, body: text })
      return NextResponse.json({ ok: r.ok, ...(r.ok ? {} : { error: r.error }) }, { status: r.ok ? 200 : (r.status || 502) })
    }

    return NextResponse.json({ ok: false, error: 'unknown op' }, { status: 400 })
  } catch (error) {
    console.error('[internal.texts]', op, error)
    return NextResponse.json({ ok: false, error: 'Server error' }, { status: 500 })
  }
}
