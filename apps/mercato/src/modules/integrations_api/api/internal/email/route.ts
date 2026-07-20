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
  return String(html || '')
    // Drop non-content blocks whose INNER text would otherwise leak (e.g. a
    // newsletter's `<style>#outlook a { padding:0 }</style>` showing as the preview).
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Turn a raw email body into readable text: drop tracking-URL clutter (bracketed
// [https://…] links, bare long tracking URLs, zero-width chars) and collapse
// whitespace, so previews + the reader don't show newsletter junk.
function cleanText(raw: string): string {
  return String(raw || '')
    .replace(/\[https?:\/\/[^\]]+\]/gi, '')
    .replace(/https?:\/\/\S{45,}/gi, '')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function bodyToText(m: { body_text?: unknown; body_html?: unknown }): string {
  const t = String(m.body_text || '').trim()
  return cleanText(t ? t : stripHtml(String(m.body_html || '')))
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

    if (op === 'status') {
      // Cheap setup signal for the inbox: how many personal mailboxes this user
      // has, and whether the org's Chief-of-Staff desk mailbox is connected.
      const personal = await knex('email_connections')
        .where('organization_id', auth.orgId)
        .where('user_id', auth.userId)
        .where('is_active', true)
        .whereNull('purpose')
        .count('* as c')
        .first()
      const desk = await knex('email_connections')
        .where('organization_id', auth.orgId)
        .where('is_active', true)
        .where('purpose', 'customer_service')
        .first()
      return NextResponse.json({ ok: true, data: { personal: Number(personal?.c || 0), deskConnected: !!desk } })
    }

    if (op === 'sync') {
      // Pull NEW incoming mail from the user's personal mailboxes into email_messages.
      const { syncPersonalInbox } = await import('@/modules/email/lib/personal-inbox-sync')
      // Wide default so a freshly-connected mailbox backfills real history
      // (the inbox should show what Gmail shows, not just the last few weeks).
      const days = Number(body.days) > 0 ? Math.min(365, Math.floor(Number(body.days))) : 120
      const result = await syncPersonalInbox(knex, auth.orgId, auth.tenantId, auth.userId, days)
      return NextResponse.json({ ok: true, data: result })
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
        .whereNull('deleted_at')
        .where('direction', 'inbound')
        .whereIn('to_address', myAddresses)
        .orderBy('created_at', 'desc')
        .limit(limit)
        .select('id', 'from_address', 'subject', 'body_text', 'body_html', 'created_at')
      const data = rows.map((m: Record<string, unknown>) => ({
        id: m.id,
        from: m.from_address,
        subject: m.subject,
        preview: bodyToText(m).slice(0, 300),
        createdAt: m.created_at,
      }))
      return NextResponse.json({ ok: true, data })
    }

    // Personal mailbox addresses for this user (reused by threads/thread/send).
    const myAddresses = async (): Promise<string[]> =>
      (await knex('email_connections')
        .where('organization_id', auth.orgId)
        .where('user_id', auth.userId)
        .where('is_active', true)
        .whereNull('purpose')
        .pluck('email_address')) as string[]

    // Narrow a query to one conversation, identified by its thread key
    // (`c:<contactId>` or `a:<address>`). Shared by thread / archive / delete.
    const applyKey = (q: Knex, key: string): Knex => {
      if (key.startsWith('c:')) return q.where('contact_id', key.slice(2))
      const addr = key.slice(2)
      return q.where((qb: Knex) => qb.whereRaw('lower(from_address) = ?', [addr]).orWhereRaw('lower(to_address) = ?', [addr]))
    }

    if (op === 'threads') {
      const limit = Math.min(400, Math.max(1, Number(body.limit) || 100))
      const showArchived = body.archived === true
      const mine = await myAddresses()
      if (mine.length === 0) return NextResponse.json({ ok: true, data: [] })
      const setMine = new Set(mine.map((a) => a.toLowerCase()))
      const rows = await knex('email_messages')
        .where('organization_id', auth.orgId)
        .where('tenant_id', auth.tenantId)
        .whereNull('deleted_at')
        .whereRaw("coalesce((metadata->>'archived')::boolean, false) = ?", [showArchived])
        .where((qb: Knex) => qb.whereIn('to_address', mine).orWhereIn('from_address', mine))
        // Order by the real email date (sent_at), NOT ingest time — otherwise a
        // backfill makes every message look like it just arrived.
        .orderByRaw('coalesce(sent_at, created_at) desc')
        .limit(1500)
        .select('id', 'from_address', 'to_address', 'subject', 'body_text', 'body_html', 'created_at', 'sent_at', 'direction', 'contact_id', 'metadata')

      const other = (m: Record<string, unknown>): string => {
        const from = String(m.from_address || '').toLowerCase()
        return setMine.has(from) ? String(m.to_address || '').toLowerCase() : from
      }
      // A thread is unread if it has any INBOUND message not yet marked read.
      const isRead = (m: Record<string, unknown>): boolean => {
        const md = m.metadata
        const parsed = typeof md === 'string' ? (() => { try { return JSON.parse(md || 'null') } catch { return null } })() : md
        return !!(parsed && (parsed as Record<string, unknown>).read === true)
      }
      const threads = new Map<string, Record<string, unknown>>()
      const contactIds = new Set<string>()
      for (const m of rows) {
        const o = other(m)
        if (!o) continue
        const key = m.contact_id ? `c:${m.contact_id}` : `a:${o}`
        const inboundUnread = m.direction === 'inbound' && !isRead(m)
        const existing = threads.get(key)
        if (!existing) {
          threads.set(key, {
            key,
            contactId: m.contact_id || null,
            address: o,
            subject: m.subject || '(no subject)',
            preview: bodyToText(m).slice(0, 160),
            at: m.sent_at || m.created_at,
            lastDirection: m.direction,
            count: 1,
            unread: inboundUnread,
          })
          if (m.contact_id) contactIds.add(String(m.contact_id))
        } else {
          existing.count = (existing.count as number) + 1
          if (inboundUnread) existing.unread = true
        }
      }
      const names: Record<string, string> = {}
      if (contactIds.size) {
        const cs = await knex('customer_entities')
          .where('organization_id', auth.orgId)
          .whereIn('id', [...contactIds])
          .select('id', 'display_name')
        for (const c of cs) names[c.id] = c.display_name || ''
      }
      const data = [...threads.values()].slice(0, limit).map((t) => ({
        ...t,
        // Contact's name if we have one, otherwise the FULL email address (not just
        // the local part — "payments-noreply@google.com", not "payments-noreply").
        name: (t.contactId && names[String(t.contactId)]) || String(t.address),
      }))
      return NextResponse.json({ ok: true, data })
    }

    if (op === 'thread') {
      const key = typeof body.key === 'string' ? body.key : ''
      if (!key) return NextResponse.json({ ok: false, error: 'key required' }, { status: 400 })
      const mine = await myAddresses()
      if (mine.length === 0) return NextResponse.json({ ok: true, data: { messages: [] } })
      const setMine = new Set(mine.map((a) => a.toLowerCase()))
      let q = knex('email_messages')
        .where('organization_id', auth.orgId)
        .where('tenant_id', auth.tenantId)
        .whereNull('deleted_at')
      q = applyKey(q, key)
      // Fetch the NEWEST 100 (desc) so the user's own recent messages fall inside
      // the cap even if a shared address has >100 older rows from other members;
      // reverse to chronological for the reader.
      const rows = await q
        .orderByRaw('coalesce(sent_at, created_at) desc')
        .limit(100)
        .select('id', 'from_address', 'to_address', 'subject', 'body_text', 'body_html', 'created_at', 'sent_at', 'direction')
      rows.reverse()
      const messages = rows
        .filter(
          (m: Record<string, unknown>) =>
            setMine.has(String(m.from_address || '').toLowerCase()) || setMine.has(String(m.to_address || '').toLowerCase()),
        )
        .map((m: Record<string, unknown>) => ({
          id: m.id,
          direction: m.direction,
          from: m.from_address,
          to: m.to_address,
          subject: m.subject,
          body: bodyToText(m).slice(0, 8000),
          at: m.sent_at || m.created_at,
        }))
      return NextResponse.json({ ok: true, data: { messages } })
    }

    if (op === 'send') {
      const to = typeof body.to === 'string' ? body.to.trim() : ''
      const cc = typeof body.cc === 'string' ? body.cc.trim() : ''
      const bcc = typeof body.bcc === 'string' ? body.bcc.trim() : ''
      const subject = typeof body.subject === 'string' ? body.subject : ''
      const text = typeof body.text === 'string' ? body.text : ''
      const html = typeof body.html === 'string' ? body.html : ''
      const key = typeof body.key === 'string' ? body.key : ''
      const threadId = typeof body.threadId === 'string' ? body.threadId : null
      let contactId = typeof body.contactId === 'string' ? body.contactId : null
      if (!contactId && key.startsWith('c:')) contactId = key.slice(2)
      if (!to || !subject || (!text && !html)) {
        return NextResponse.json({ ok: false, error: 'A recipient, subject, and message are required.' }, { status: 400 })
      }
      const conn = await knex('email_connections')
        .where('organization_id', auth.orgId)
        .where('user_id', auth.userId)
        .where('is_active', true)
        .whereNull('purpose')
        .orderBy('is_primary', 'desc')
        .first()
      if (!conn) return NextResponse.json({ ok: false, error: 'Connect a mailbox before sending.' }, { status: 400 })

      const { sendEmailForOrg } = await import('@/modules/email/lib/email-router')
      const result = await sendEmailForOrg(knex, auth.orgId, auth.tenantId, auth.userId, {
        to,
        cc: cc || undefined,
        bcc: bcc || undefined,
        subject,
        htmlBody: html || text,
        textBody: text || undefined,
        contactId: contactId || undefined,
      })
      if (!result?.ok) return NextResponse.json({ ok: false, error: result?.error || 'We could not send that message.' }, { status: 400 })

      // Record the sent mail so it shows in the thread immediately.
      const now = new Date()
      await knex('email_messages').insert({
        id: crypto.randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        account_id: conn.id,
        direction: 'outbound',
        from_address: result.fromAddress || conn.email_address,
        to_address: to,
        cc: cc || null,
        subject,
        body_html: html || '',
        body_text: text || null,
        thread_id: threadId,
        contact_id: contactId,
        status: 'sent',
        tracking_id: crypto.randomUUID(),
        created_at: now,
        updated_at: now,
        sent_at: now,
      })
      return NextResponse.json({ ok: true })
    }

    if (op === 'archive' || op === 'unarchive') {
      const key = typeof body.key === 'string' ? body.key : ''
      if (!key) return NextResponse.json({ ok: false, error: 'key required' }, { status: 400 })
      const archived = op === 'archive'
      const mine = await myAddresses()
      // No personal mailbox = no personal mail to act on. Never fall through to an
      // unscoped update (that would let a member touch another member's mail).
      if (mine.length === 0) return NextResponse.json({ ok: true })
      let q = knex('email_messages')
        .where('organization_id', auth.orgId)
        .where('tenant_id', auth.tenantId)
        .whereNull('deleted_at')
        // Mandatory: only the caller's OWN mailbox mail.
        .where((qb: Knex) => qb.whereIn('to_address', mine).orWhereIn('from_address', mine))
      q = applyKey(q, key)
      await q.update({
        metadata: knex.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ archived })]),
        updated_at: new Date(),
      })
      return NextResponse.json({ ok: true })
    }

    if (op === 'markRead' || op === 'markUnread') {
      const key = typeof body.key === 'string' ? body.key : ''
      if (!key) return NextResponse.json({ ok: false, error: 'key required' }, { status: 400 })
      const read = op === 'markRead'
      const mine = await myAddresses()
      if (mine.length === 0) return NextResponse.json({ ok: true })
      let q = knex('email_messages')
        .where('organization_id', auth.orgId)
        .where('tenant_id', auth.tenantId)
        .whereNull('deleted_at')
        .where((qb: Knex) => qb.whereIn('to_address', mine).orWhereIn('from_address', mine))
        // Read state applies to INBOUND mail (your own sent mail is always "read").
        .where('direction', 'inbound')
      q = applyKey(q, key)
      await q.update({
        metadata: knex.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ read })]),
        updated_at: new Date(),
      })
      return NextResponse.json({ ok: true })
    }

    if (op === 'delete') {
      const id = typeof body.id === 'string' ? body.id : ''
      const key = typeof body.key === 'string' ? body.key : ''
      if (!id && !key) return NextResponse.json({ ok: false, error: 'id or key required' }, { status: 400 })
      const mine = await myAddresses()
      // Same guard as archive: the caller can only delete mail in their OWN mailbox,
      // whether targeting by id or by conversation key. Empty mailbox = nothing to do.
      if (mine.length === 0) return NextResponse.json({ ok: true })
      let q = knex('email_messages')
        .where('organization_id', auth.orgId)
        .where('tenant_id', auth.tenantId)
        .whereNull('deleted_at')
        .where((qb: Knex) => qb.whereIn('to_address', mine).orWhereIn('from_address', mine))
      if (id) {
        q = q.where('id', id)
      } else {
        q = applyKey(q, key)
      }
      await q.update({ deleted_at: new Date(), updated_at: new Date() })
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ ok: false, error: 'unknown op' }, { status: 400 })
  } catch (error) {
    console.error('[internal.email]', op, error)
    return NextResponse.json({ ok: false, error: 'Server error' }, { status: 500 })
  }
}
