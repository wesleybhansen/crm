import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

// POST: Save SMTP configuration
export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.sub || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { host, port, username, password, fromAddress } = body

    if (!host || !port || !username || !password || !fromAddress) {
      return NextResponse.json(
        { ok: false, error: 'All fields are required: host, port, username, password, fromAddress' },
        { status: 400 },
      )
    }

    // Test the connection using nodemailer verify
    try {
      const nodemailer = await import('nodemailer')
      const transporter = nodemailer.createTransport({
        host,
        port: Number(port),
        secure: Number(port) === 465,
        auth: { user: username, pass: password },
        connectionTimeout: 10000,
      })
      await transporter.verify()
    } catch (verifyErr) {
      const message = verifyErr instanceof Error ? verifyErr.message : 'Connection test failed'
      return NextResponse.json(
        { ok: false, error: `SMTP connection test failed: ${message}` },
        { status: 400 },
      )
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Check if SMTP connection already exists for this user
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

    if (existing) {
      await knex('email_connections').where('id', existing.id).update({
        email_address: fromAddress,
        smtp_host: host,
        smtp_port: Number(port),
        smtp_user: username,
        smtp_pass: password,
        is_active: true,
        updated_at: new Date(),
      })
    } else {
      await knex('email_connections').insert({
        id: require('crypto').randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        user_id: auth.sub,
        provider: 'smtp',
        email_address: fromAddress,
        smtp_host: host,
        smtp_port: Number(port),
        smtp_user: username,
        smtp_pass: password,
        is_primary: !anyExisting,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[email.smtp.save]', error)
    return NextResponse.json({ ok: false, error: 'Failed to save SMTP configuration' }, { status: 500 })
  }
}

// DELETE: Remove SMTP connection by ?id=
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
    return NextResponse.json({ ok: false, error: 'Failed to disconnect SMTP' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Email', summary: 'SMTP email connection',
  methods: {
    POST: { summary: 'Save SMTP configuration', tags: ['Email'] },
    DELETE: { summary: 'Remove SMTP connection', tags: ['Email'] },
  },
}
