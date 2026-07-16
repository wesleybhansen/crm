import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'

/* Internal endpoint for the Noli COS "email desk" (the Chief of Staff's own
 * mailbox). The hub registers the desk's IMAP/SMTP credentials here so the
 * EXISTING customer-service engine handles every stranger's email — draft /
 * approve / autopilot, exactly like the CS inbox — while the OWNER's own
 * address is skipped (their mail to the desk is commands to the agent, which
 * the Hermes email adapter handles on the instance, never correspondence).
 *
 * op=connect    -> upsert the email_connections row (purpose customer_service)
 *                  + ensure customer_service_settings (draft mode) + add the
 *                  owner (and the desk itself) to settings.skip_senders.
 * op=disconnect -> deactivate the desk's connection row.
 * Auth: Bearer NOLI_INTERNAL_SERVICE_SECRET (mirrors email-send). */

export const dynamic = 'force-dynamic'

export const metadata = {
  path: '/internal/email-desk-connect',
  POST: { requireAuth: false },
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

export async function POST(req: Request) {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  if (!secret || !safeEq(authHeader, `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const op = typeof b.op === 'string' ? b.op : 'connect'
  const noliUserId = typeof b.noliUserId === 'string' ? b.noliUserId.trim() : ''
  const address = typeof b.address === 'string' ? b.address.trim().toLowerCase() : ''
  if (!noliUserId || !address) {
    return NextResponse.json({ ok: false, error: 'noliUserId and address required' }, { status: 400 })
  }

  try {
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'noli user not found' }, { status: 404 })
    }
    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth?.userId || !auth?.orgId || !auth?.tenantId) {
      return NextResponse.json({ ok: false, error: 'user has no CRM access' }, { status: 403 })
    }
    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    if (op === 'disconnect') {
      await knex('email_connections')
        .where('organization_id', String(auth.orgId))
        .where('email_address', address)
        .where('purpose', 'customer_service')
        .update({ is_active: false, updated_at: new Date() })
      return NextResponse.json({ ok: true })
    }

    const password = typeof b.password === 'string' ? b.password : ''
    const imapHost = typeof b.imapHost === 'string' ? b.imapHost.trim() : ''
    const smtpHost = typeof b.smtpHost === 'string' ? b.smtpHost.trim() : ''
    const imapPort = Number(b.imapPort) || 993
    const smtpPort = Number(b.smtpPort) || 587
    const ownerEmail = typeof b.ownerEmail === 'string' ? b.ownerEmail.trim().toLowerCase() : ''
    if (!password || !imapHost || !smtpHost) {
      return NextResponse.json({ ok: false, error: 'password, imapHost, smtpHost required' }, { status: 400 })
    }

    // Upsert the desk mailbox as a customer-service connection (same shape as
    // the SMTP save route; scoped on org + address + purpose).
    const record = {
      email_address: address,
      smtp_host: smtpHost,
      smtp_port: smtpPort,
      smtp_user: address,
      smtp_pass: password,
      imap_host: imapHost,
      imap_port: imapPort,
      imap_secure: imapPort === 993,
      is_active: true,
      updated_at: new Date(),
    }
    const existing = await knex('email_connections')
      .where('organization_id', String(auth.orgId))
      .where('email_address', address)
      .where('purpose', 'customer_service')
      .first()
    if (existing) {
      await knex('email_connections').where('id', existing.id).update(record)
    } else {
      await knex('email_connections').insert({
        id: crypto.randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        user_id: auth.userId,
        provider: 'smtp',
        purpose: 'customer_service',
        is_primary: false,
        created_at: new Date(),
        ...record,
      })
    }

    // Ensure the CS engine is on (draft mode = everything reviewed) and skip
    // the owner's own address + the desk itself. skip_senders is an additive
    // jsonb column (idempotent ALTER applied at deploy).
    const skipAdd = [ownerEmail, address].filter(Boolean)
    const settings = await knex('customer_service_settings')
      .where('organization_id', String(auth.orgId))
      .first()
    if (settings) {
      const cur: string[] = Array.isArray(settings.skip_senders)
        ? settings.skip_senders
        : (typeof settings.skip_senders === 'string' ? JSON.parse(settings.skip_senders || '[]') : [])
      const merged = Array.from(new Set([...cur, ...skipAdd]))
      await knex('customer_service_settings')
        .where('id', settings.id)
        .update({ skip_senders: JSON.stringify(merged), enabled: true, updated_at: new Date() })
    } else {
      await knex('customer_service_settings').insert({
        id: crypto.randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        enabled: true,
        reply_mode: 'draft',
        skip_senders: JSON.stringify(skipAdd),
        created_at: new Date(),
        updated_at: new Date(),
      })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[internal/email-desk-connect] failed:', (e as Error).message)
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
