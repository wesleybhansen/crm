import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

/* Internal service endpoint (shared NOLI_INTERNAL_SERVICE_SECRET) that returns
 * the whole relationship for one contact — the CRM record plus their recent
 * email and text history as a single cross-channel thread — so the hub inbox
 * can show "everything about this person" right beside a draft. Read-only, org+
 * tenant scoped. */

export const metadata = {
  path: '/internal/contact-context',
  POST: { requireAuth: false },
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}
function stripHtml(html: string): string {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
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
  const contactId = typeof body.contactId === 'string' ? body.contactId.trim() : ''
  if (!noliUserId || !contactId) return NextResponse.json({ ok: false, error: 'noliUserId and contactId are required' }, { status: 400 })

  try {
    const auth = await resolveAuth(noliUserId)
    if (!auth) return NextResponse.json({ ok: false, error: 'no CRM account for this user' }, { status: 404 })
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex() as Knex

    // Contact must belong to the caller's org + tenant.
    const contact = await knex('customer_entities')
      .where('id', contactId)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .first()
    if (!contact) return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })

    const [emails, texts] = await Promise.all([
      knex('email_messages')
        .where('organization_id', auth.orgId)
        .where('tenant_id', auth.tenantId)
        .where('contact_id', contactId)
        .orderBy('created_at', 'desc')
        .limit(15)
        .select('id', 'direction', 'subject', 'body_text', 'body_html', 'created_at'),
      knex('sms_messages')
        .where('organization_id', auth.orgId)
        .where('tenant_id', auth.tenantId)
        .where('contact_id', contactId)
        .orderBy('created_at', 'desc')
        .limit(15)
        .select('id', 'direction', 'body', 'created_at'),
    ])

    // Merge into one cross-channel, time-ordered thread.
    const thread = [
      ...emails.map((m: Record<string, unknown>) => ({
        id: m.id,
        channel: 'email' as const,
        direction: m.direction,
        subject: m.subject || null,
        text: (String(m.body_text || '').trim() ? String(m.body_text) : stripHtml(String(m.body_html || ''))).slice(0, 500),
        at: m.created_at,
      })),
      ...texts.map((m: Record<string, unknown>) => ({
        id: m.id,
        channel: 'text' as const,
        direction: m.direction,
        subject: null,
        text: String(m.body || '').slice(0, 500),
        at: m.created_at,
      })),
    ].sort((a, b) => (new Date(a.at as string) < new Date(b.at as string) ? 1 : -1))

    return NextResponse.json({
      ok: true,
      data: {
        contact: {
          id: contact.id,
          name: contact.display_name || null,
          email: contact.email || null,
          phone: contact.phone || null,
          status: contact.status || null,
        },
        thread: thread.slice(0, 25),
      },
    })
  } catch (error) {
    console.error('[internal.contact-context]', error)
    return NextResponse.json({ ok: false, error: 'Server error' }, { status: 500 })
  }
}
