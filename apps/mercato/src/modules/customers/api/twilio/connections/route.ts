export const metadata = { GET: { requireAuth: true }, POST: { requireAuth: true }, DELETE: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

// Get the org's Twilio connection status
export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const connection = await knex('twilio_connections')
      .where('organization_id', auth.orgId)
      .where('is_active', true)
      .first()

    if (!connection) {
      return NextResponse.json({ ok: true, data: null })
    }

    return NextResponse.json({
      ok: true,
      data: {
        id: connection.id,
        accountSid: connection.account_sid,
        phoneNumber: connection.phone_number,
        isActive: connection.is_active,
        connectedAt: connection.created_at,
      },
    })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to fetch connection' }, { status: 500 })
  }
}

// Save and test Twilio credentials
export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { accountSid, authToken, phoneNumber } = body

    if (!accountSid || !authToken || !phoneNumber) {
      return NextResponse.json(
        { ok: false, error: 'accountSid, authToken, and phoneNumber are required' },
        { status: 400 },
      )
    }

    // Initialize DI container first
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Test the connection by fetching account info from Twilio
    const testRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`,
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        },
      },
    )

    if (!testRes.ok) {
      const errorData = await testRes.json().catch(() => null)
      return NextResponse.json(
        { ok: false, error: errorData?.message || 'Invalid Twilio credentials. Please check your Account SID and Auth Token.' },
        { status: 400 },
      )
    }

    const twilioAccount = await testRes.json()
    if (twilioAccount.status !== 'active') {
      return NextResponse.json(
        { ok: false, error: `Twilio account is ${twilioAccount.status}. An active account is required.` },
        { status: 400 },
      )
    }

    // Upsert into twilio_connections
    const existing = await knex('twilio_connections')
      .where('organization_id', auth.orgId)
      .first()

    if (existing) {
      await knex('twilio_connections').where('id', existing.id).update({
        account_sid: accountSid,
        auth_token: authToken,
        phone_number: phoneNumber,
        is_active: true,
        updated_at: new Date(),
      })
    } else {
      await knex('twilio_connections').insert({
        id: require('crypto').randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        account_sid: accountSid,
        auth_token: authToken,
        phone_number: phoneNumber,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      })
    }

    console.log(`[twilio.connections] Connected account ${accountSid} for org ${auth.orgId}`)
    return NextResponse.json({ ok: true, data: { accountSid, phoneNumber } })
  } catch (err: any) {
    console.error('[twilio.connections] Error:', err?.message || err)
    const message = err?.message || 'Unknown error'
    if (message.includes('unique') || message.includes('duplicate')) {
      return NextResponse.json({ ok: false, error: 'A Twilio connection already exists for this account. Try disconnecting first.' }, { status: 400 })
    }
    return NextResponse.json({ ok: false, error: `Failed to save: ${message}` }, { status: 500 })
  }
}

// Disconnect Twilio account
export async function DELETE() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    await knex('twilio_connections')
      .where('organization_id', auth.orgId)
      .update({ is_active: false, updated_at: new Date() })

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to disconnect' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Twilio',
  summary: 'Manage Twilio connections',
  methods: {
    GET: { summary: 'Get Twilio connection status for the organization', tags: ['Twilio'] },
    POST: { summary: 'Save and test Twilio credentials', tags: ['Twilio'] },
    DELETE: { summary: 'Disconnect Twilio account from the organization', tags: ['Twilio'] },
  },
}
