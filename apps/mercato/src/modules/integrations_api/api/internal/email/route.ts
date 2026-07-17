import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { testImapConnection, getProviderPreset } from '@/modules/email/lib/imap-service'

/* Internal service endpoint (shared NOLI_INTERNAL_SERVICE_SECRET) that lets the
 * hub's Unified Inbox manage a user's PERSONAL email mailboxes (purpose null)
 * and read a unified recent-message list. Connecting reuses the CRM's proven
 * IMAP/SMTP validation. Dedicated customer-service inboxes (purpose
 * 'customer_service') are owned by the Customer Service tab and excluded here. */

export const metadata = {
  path: '/internal/email',
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

function stripHtml(html: string): string {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

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

    if (op === 'list') {
      const rows = await knex('email_connections')
        .where('organization_id', auth.orgId)
        .where('user_id', auth.userId)
        .where('is_active', true)
        .whereNull('purpose')
        .select('id', 'provider', 'email_address', 'is_primary', 'created_at')
        .orderBy('created_at', 'asc')
      return NextResponse.json({ ok: true, data: rows })
    }

    if (op === 'add') {
      const emailAddress = typeof body.emailAddress === 'string' ? body.emailAddress.trim() : ''
      const password = typeof body.password === 'string' ? body.password : ''
      if (!emailAddress || !password) return NextResponse.json({ ok: false, error: 'Email address and app password are required' }, { status: 400 })

      const preset = getProviderPreset(emailAddress)
      const imapHost = (body.imapHost as string) || preset?.imap.host
      const imapPort = (body.imapPort as number) || preset?.imap.port || 993
      const imapSecure = body.imapSecure !== undefined ? Boolean(body.imapSecure) : (preset?.imap.secure ?? true)
      const smtpHost = (body.smtpHost as string) || preset?.smtp.host
      const smtpPort = (body.smtpPort as number) || preset?.smtp.port || 587
      if (!imapHost || !smtpHost) {
        return NextResponse.json({ ok: false, error: 'We could not detect the server settings for this provider. Enter the IMAP and SMTP server details manually.' }, { status: 400 })
      }

      const imapTest = await testImapConnection({ host: imapHost, port: imapPort, secure: imapSecure, user: emailAddress, pass: password })
      if (!imapTest.ok) {
        return NextResponse.json({ ok: false, error: `We could not sign in to your inbox: ${imapTest.error}. Double-check the email address and App Password.` }, { status: 400 })
      }
      try {
        const nodemailer = await import('nodemailer')
        const transporter = nodemailer.createTransport({ host: smtpHost, port: smtpPort, secure: smtpPort === 465, auth: { user: emailAddress, pass: password }, connectionTimeout: 10000 })
        await transporter.verify()
      } catch (smtpErr) {
        const message = smtpErr instanceof Error ? smtpErr.message : 'sending test failed'
        return NextResponse.json({ ok: false, error: `We could not connect for sending: ${message}` }, { status: 400 })
      }

      const existing = await knex('email_connections').where('organization_id', auth.orgId).where('user_id', auth.userId).where('provider', 'smtp').where('email_address', emailAddress).whereNull('purpose').first()
      const anyExisting = await knex('email_connections').where('organization_id', auth.orgId).where('user_id', auth.userId).where('is_active', true).first()
      const record = {
        email_address: emailAddress,
        smtp_host: smtpHost,
        smtp_port: smtpPort,
        smtp_user: emailAddress,
        smtp_pass: password,
        imap_host: imapHost,
        imap_port: imapPort,
        imap_secure: imapSecure,
        is_active: true,
        updated_at: new Date(),
      }
      if (existing) {
        await knex('email_connections').where('id', existing.id).update(record)
      } else {
        await knex('email_connections').insert({
          id: crypto.randomUUID(),
          tenant_id: auth.tenantId,
          organization_id: auth.orgId,
          user_id: auth.userId,
          provider: 'smtp',
          purpose: null,
          is_primary: !anyExisting,
          created_at: new Date(),
          ...record,
        })
      }
      return NextResponse.json({ ok: true, data: { emailAddress } })
    }

    if (op === 'remove') {
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })
      await knex('email_connections').where('id', id).where('organization_id', auth.orgId).where('user_id', auth.userId).update({ is_active: false, updated_at: new Date() })
      return NextResponse.json({ ok: true })
    }

    if (op === 'messages') {
      const limit = Math.min(100, Math.max(1, Number(body.limit) || 40))
      // Scope to THIS user's own personal mailboxes only — never another
      // org-member's inbox, and never the dedicated customer-service inbox.
      const myAddresses = (
        await knex('email_connections')
          .where('organization_id', auth.orgId)
          .where('user_id', auth.userId)
          .where('is_active', true)
          .whereNull('purpose')
          .pluck('email_address')
      ) as string[]
      if (myAddresses.length === 0) return NextResponse.json({ ok: true, data: [] })
      const rows = await knex('email_messages')
        .where('organization_id', auth.orgId)
        .where('tenant_id', auth.tenantId)
        .where('direction', 'inbound')
        .whereIn('to_address', myAddresses)
        .orderBy('created_at', 'desc')
        .limit(limit)
        .select('id', 'from_address', 'subject', 'body_text', 'body_html', 'created_at')
      const data = rows.map((m: Record<string, unknown>) => ({
        id: m.id,
        from: m.from_address,
        subject: m.subject,
        preview: (String(m.body_text || '').trim() ? String(m.body_text) : stripHtml(String(m.body_html || ''))).slice(0, 300),
        createdAt: m.created_at,
      }))
      return NextResponse.json({ ok: true, data })
    }

    return NextResponse.json({ ok: false, error: 'unknown op' }, { status: 400 })
  } catch (error) {
    console.error('[internal.email]', op, error)
    return NextResponse.json({ ok: false, error: 'Server error' }, { status: 500 })
  }
}
