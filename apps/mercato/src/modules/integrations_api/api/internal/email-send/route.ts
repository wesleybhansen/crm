import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'

/* Internal email-send endpoint for the Noli Chief of Staff (COS) approvals flow.
 *
 * The COS agent reads the customer's mail (via the existing email_search_messages
 * tool) and drafts a reply, then files a `send_email` approval in the COS
 * approvals feed. When the customer APPROVES it, the Noli hub calls THIS endpoint
 * with the shared NOLI_INTERNAL_SERVICE_SECRET to actually send the mail through
 * the customer's own connected mailbox (IMAP/SMTP) via the email router. Nothing
 * is sent here without that prior human approval — the endpoint is the executor,
 * not the decision. Identity resolution reuses the same clerk -> Mercato path as
 * provision-key, so no separate plumbing. */

export const dynamic = 'force-dynamic'

// Dispatcher mapping: serve at /api/internal/email-send (not the module-prefixed
// default) and public at the dispatcher level — we authenticate below with the
// shared service secret. Mirrors provision-key.
export const metadata = {
  path: '/internal/email-send',
  POST: { requireAuth: false },
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

export async function POST(req: Request) {
  // Shared-secret auth (constant-time). Same gate as provision-key.
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  if (!secret || !safeEq(authHeader, `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    clerkUserId?: unknown
    to?: unknown
    subject?: unknown
    html?: unknown
    text?: unknown
    contactId?: unknown
  }
  const clerkUserId = typeof body.clerkUserId === 'string' ? body.clerkUserId.trim() : ''
  const to = typeof body.to === 'string' ? body.to.trim() : ''
  const subject = typeof body.subject === 'string' ? body.subject : ''
  const html = typeof body.html === 'string' ? body.html : ''
  const text = typeof body.text === 'string' ? body.text : undefined
  const contactId = typeof body.contactId === 'string' ? body.contactId : undefined
  if (!clerkUserId || !to || !subject || (!html && !text)) {
    return NextResponse.json(
      { ok: false, error: 'clerkUserId, to, subject, and (html or text) are required' },
      { status: 400 },
    )
  }

  try {
    // clerk id -> Mercato auth context (org/tenant/user), gated on the 'crm'
    // entitlement — returns null if the user has no CRM access.
    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(clerkUserId)
    if (!auth?.userId || !auth?.orgId || !auth?.tenantId) {
      return NextResponse.json({ ok: false, error: 'user has no CRM access' }, { status: 403 })
    }

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const { sendEmailForOrg } = await import('@/modules/email/lib/email-router')
    const result = await sendEmailForOrg(
      knex,
      String(auth.orgId),
      String(auth.tenantId),
      String(auth.userId),
      { to, subject, htmlBody: html || text || '', textBody: text, contactId },
    )
    if (!result?.ok) {
      return NextResponse.json({ ok: false, error: result?.error || 'send failed' }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[internal/email-send] failed:', (e as Error).message)
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
