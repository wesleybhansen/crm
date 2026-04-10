export const metadata = { GET: { requireAuth: true }, POST: { requireAuth: true }, DELETE: { requireAuth: true } }
export const openApi = { summary: "Email routing config", methods: { GET: { summary: "Get routing", tags: ["Email"] }, POST: { summary: "Set routing", tags: ["Email"] }, DELETE: { summary: "Reset", tags: ["Email"] } } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getEmailAddresses } from '@/modules/email/lib/routing-service'

const EMAIL_PURPOSES = ['inbox', 'invoices', 'marketing', 'automations', 'transactional'] as const

export async function GET() {
  try {
    const auth = await getAuthFromCookies()
    if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const addresses = await getEmailAddresses(knex, auth.orgId)
    const routing = await knex('email_routing').where('organization_id', auth.orgId)

    return NextResponse.json({ ok: true, data: { addresses, routing } })
  } catch (error) {
    console.error('[email.routing.get]', error)
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Failed to load routing config' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const { purpose, provider_type, provider_id, from_name, from_address } = body

    if (!purpose || !EMAIL_PURPOSES.includes(purpose)) {
      return NextResponse.json({ ok: false, error: `Invalid purpose. Must be one of: ${EMAIL_PURPOSES.join(', ')}` }, { status: 400 })
    }
    if (!provider_type || !['connection', 'esp'].includes(provider_type)) {
      return NextResponse.json({ ok: false, error: 'provider_type must be "connection" or "esp"' }, { status: 400 })
    }
    if (!provider_id) {
      return NextResponse.json({ ok: false, error: 'provider_id is required' }, { status: 400 })
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Validate provider exists and belongs to org
    if (provider_type === 'connection') {
      const conn = await knex('email_connections').where('id', provider_id).where('organization_id', auth.orgId).where('is_active', true).first()
      if (!conn) return NextResponse.json({ ok: false, error: 'Email connection not found' }, { status: 404 })
    } else {
      // provider_id can be an esp_sender_addresses ID or an esp_connections ID
      const senderAddr = await knex('esp_sender_addresses').where('id', provider_id).where('organization_id', auth.orgId).first()
      if (!senderAddr) {
        const esp = await knex('esp_connections').where('id', provider_id).where('organization_id', auth.orgId).where('is_active', true).first()
        if (!esp) return NextResponse.json({ ok: false, error: 'ESP connection not found' }, { status: 404 })
      }
    }

    if (purpose === 'inbox' && provider_type === 'esp') {
      return NextResponse.json({ ok: false, error: 'Inbox must use a personal email connection (Gmail, Outlook, or SMTP)' }, { status: 400 })
    }

    // Upsert
    const existing = await knex('email_routing').where('organization_id', auth.orgId).where('purpose', purpose).first()

    if (existing) {
      await knex('email_routing').where('id', existing.id).update({
        provider_type, provider_id,
        from_name: from_name || null,
        from_address: from_address || null,
        updated_at: new Date(),
      })
    } else {
      await knex('email_routing').insert({
        id: require('crypto').randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        purpose, provider_type, provider_id,
        from_name: from_name || null,
        from_address: from_address || null,
        created_at: new Date(),
        updated_at: new Date(),
      })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[email.routing.save]', error)
    return NextResponse.json({ ok: false, error: 'save failed: ' + (error instanceof Error ? error.message : String(error)) }, { status: 500 })
  }
}

// DELETE: Remove routing for a specific purpose (revert to defaults)
export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const url = new URL(req.url)
    const purpose = url.searchParams.get('purpose')
    if (!purpose) return NextResponse.json({ ok: false, error: 'purpose query param required' }, { status: 400 })

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    await knex('email_routing').where('organization_id', auth.orgId).where('purpose', purpose).delete()

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[email.routing.delete]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
