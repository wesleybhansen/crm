export const metadata = { POST: { requireAuth: true }, DELETE: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { normalizeAuthorUserId } from '@open-mercato/shared/lib/commands/helpers'
import { testImapConnection, getProviderPreset } from '../../lib/imap-service'

// POST: Save IMAP + SMTP configuration (unified email connection)
export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.sub || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { emailAddress, password, imapHost, imapPort, imapSecure, smtpHost, smtpPort } = body

    if (!emailAddress || !password) {
      return NextResponse.json(
        { ok: false, error: 'emailAddress and password are required' },
        { status: 400 },
      )
    }

    // Auto-fill server settings from known provider presets if not supplied
    const preset = getProviderPreset(emailAddress)
    const resolvedImapHost = imapHost || preset?.imap.host
    const resolvedImapPort = imapPort || preset?.imap.port || 993
    const resolvedImapSecure = imapSecure !== undefined ? imapSecure : (preset?.imap.secure ?? true)
    const resolvedSmtpHost = smtpHost || preset?.smtp.host
    const resolvedSmtpPort = smtpPort || preset?.smtp.port || 587

    if (!resolvedImapHost || !resolvedSmtpHost) {
      return NextResponse.json(
        { ok: false, error: 'Could not detect server settings for this email provider. Please enter IMAP and SMTP server details manually.' },
        { status: 400 },
      )
    }

    // Test IMAP connection before saving
    const imapTest = await testImapConnection({
      host: resolvedImapHost,
      port: resolvedImapPort,
      secure: resolvedImapSecure,
      user: emailAddress,
      pass: password,
    })

    if (!imapTest.ok) {
      return NextResponse.json(
        { ok: false, error: `IMAP connection failed: ${imapTest.error}. Check your email address and App Password.` },
        { status: 400 },
      )
    }

    // Test SMTP connection
    try {
      const nodemailer = await import('nodemailer')
      const transporter = nodemailer.createTransport({
        host: resolvedSmtpHost,
        port: resolvedSmtpPort,
        secure: resolvedSmtpPort === 465,
        auth: { user: emailAddress, pass: password },
        connectionTimeout: 10000,
      })
      await transporter.verify()
    } catch (smtpErr) {
      const message = smtpErr instanceof Error ? smtpErr.message : 'SMTP test failed'
      return NextResponse.json(
        { ok: false, error: `SMTP connection failed: ${message}` },
        { status: 400 },
      )
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const existing = await knex('email_connections')
      .where('organization_id', auth.orgId)
      .where('user_id', auth.sub)
      .where('provider', 'smtp')
      .first()

    const anyExisting = await knex('email_connections')
      .where('organization_id', auth.orgId)
      .where('user_id', auth.sub)
      .where('is_active', true)
      .first()

    const record = {
      email_address: emailAddress,
      smtp_host: resolvedSmtpHost,
      smtp_port: resolvedSmtpPort,
      smtp_user: emailAddress,
      smtp_pass: password,
      imap_host: resolvedImapHost,
      imap_port: resolvedImapPort,
      imap_secure: resolvedImapSecure,
      is_active: true,
      updated_at: new Date(),
    }

    if (existing) {
      await knex('email_connections').where('id', existing.id).update(record)
    } else {
      await knex('email_connections').insert({
        id: require('crypto').randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        user_id: normalizeAuthorUserId(null, auth),
        provider: 'smtp',
        is_primary: !anyExisting,
        created_at: new Date(),
        ...record,
      })
    }

    return NextResponse.json({ ok: true, data: { emailAddress, imapHost: resolvedImapHost, smtpHost: resolvedSmtpHost } })
  } catch (error) {
    console.error('[email.smtp.save]', error)
    return NextResponse.json({ ok: false, error: 'Failed to save email configuration' }, { status: 500 })
  }
}

// DELETE: Remove connection by ?id=
export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.sub || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const connectionId = url.searchParams.get('id')
  if (!connectionId) {
    return NextResponse.json({ ok: false, error: 'Connection id is required' }, { status: 400 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const deleted = await knex('email_connections')
      .where('id', connectionId)
      .where('organization_id', auth.orgId)
      .where('user_id', auth.sub)
      .where('provider', 'smtp')
      .update({ is_active: false, updated_at: new Date() })

    if (!deleted) {
      return NextResponse.json({ ok: false, error: 'Connection not found' }, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[email.smtp.delete]', error)
    return NextResponse.json({ ok: false, error: 'Failed to disconnect email' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Email', summary: 'IMAP/SMTP email connection',
  methods: {
    POST: { summary: 'Save IMAP + SMTP configuration', tags: ['Email'] },
    DELETE: { summary: 'Remove email connection', tags: ['Email'] },
  },
}
