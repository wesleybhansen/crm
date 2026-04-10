export const metadata = { GET: { requireAuth: true }, POST: { requireAuth: true }, DELETE: { requireAuth: true } }
export const openApi = { summary: "ESP sender addresses", methods: { GET: { summary: "List", tags: ["Email"] }, POST: { summary: "Add", tags: ["Email"] }, DELETE: { summary: "Remove", tags: ["Email"] } } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export async function GET() {
  try {
    const auth = await getAuthFromCookies()
    if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const addresses = await knex('esp_sender_addresses')
      .where('organization_id', auth.orgId)
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'asc')

    return NextResponse.json({ ok: true, data: addresses })
  } catch (error) {
    console.error('[email.sender-addresses.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load sender addresses' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const auth = await getAuthFromCookies()
    if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

    const body = await req.json()
    const { senderEmail, senderName, isDefault } = body

    if (!senderEmail || !senderEmail.includes('@')) {
      return NextResponse.json({ ok: false, error: 'A valid sender email is required' }, { status: 400 })
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Must have an active ESP connection
    const esp = await knex('esp_connections')
      .where('organization_id', auth.orgId).where('is_active', true).first()
    if (!esp) {
      return NextResponse.json({ ok: false, error: 'Connect an ESP (Resend, SendGrid, etc.) first' }, { status: 400 })
    }

    // Check domain matches ESP verified domain (if set)
    const emailDomain = senderEmail.split('@')[1]
    if (esp.sending_domain && emailDomain !== esp.sending_domain) {
      return NextResponse.json({ ok: false, error: `Email must be on your verified domain (${esp.sending_domain})` }, { status: 400 })
    }

    // Check for duplicate
    const existing = await knex('esp_sender_addresses')
      .where('organization_id', auth.orgId).where('sender_email', senderEmail.toLowerCase()).first()
    if (existing) {
      return NextResponse.json({ ok: false, error: 'This sender address already exists' }, { status: 400 })
    }

    // If this is the first address or marked as default, clear other defaults
    const count = await knex('esp_sender_addresses').where('organization_id', auth.orgId).count().first()
    const isFirstAddress = Number(count?.count || 0) === 0
    if (isDefault || isFirstAddress) {
      await knex('esp_sender_addresses')
        .where('organization_id', auth.orgId)
        .update({ is_default: false })
    }

    const id = require('crypto').randomUUID()
    await knex('esp_sender_addresses').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      esp_connection_id: esp.id,
      sender_name: senderName?.trim() || null,
      sender_email: senderEmail.toLowerCase().trim(),
      is_default: isDefault || isFirstAddress,
      created_at: new Date(),
    })

    const address = await knex('esp_sender_addresses').where('id', id).first()
    return NextResponse.json({ ok: true, data: address }, { status: 201 })
  } catch (error) {
    console.error('[email.sender-addresses.post]', error)
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Failed to add sender address' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  try {
    const auth = await getAuthFromCookies()
    if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    await knex('esp_sender_addresses')
      .where('id', id).where('organization_id', auth.orgId).delete()

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[email.sender-addresses.delete]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
