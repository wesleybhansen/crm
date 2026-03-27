import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const contactId = url.searchParams.get('contactId')

    let query = knex('sms_messages').where('organization_id', auth.orgId).orderBy('created_at', 'desc')
    if (contactId) query = query.where('contact_id', contactId)

    const messages = await query.limit(50)
    return NextResponse.json({ ok: true, data: messages })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { to, message, contactId } = body

    if (!to || !message) return NextResponse.json({ ok: false, error: 'to and message required' }, { status: 400 })

    // Look up the org's Twilio connection
    const twilioConnection = await knex('twilio_connections')
      .where('organization_id', auth.orgId)
      .where('is_active', true)
      .first()

    if (!twilioConnection) {
      return NextResponse.json(
        { ok: false, error: 'Connect your Twilio account in Settings to send SMS' },
        { status: 400 },
      )
    }

    const fromNumber = twilioConnection.phone_number
    const accountSid = twilioConnection.account_sid
    const authToken = twilioConnection.auth_token
    const id = require('crypto').randomUUID()
    let status = 'queued'
    let twilioSid = null

    try {
      const twilioRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          },
          body: new URLSearchParams({ To: to, From: fromNumber, Body: message }),
        },
      )
      const twilioData = await twilioRes.json()
      if (twilioData.sid) {
        status = 'sent'
        twilioSid = twilioData.sid
      } else {
        status = 'failed'
        console.error('[sms] Twilio error:', twilioData)
      }
    } catch (err) {
      status = 'failed'
      console.error('[sms] Twilio send failed:', err)
    }

    await knex('sms_messages').insert({
      id, tenant_id: auth.tenantId, organization_id: auth.orgId,
      contact_id: contactId || null,
      direction: 'outbound', from_number: fromNumber, to_number: to,
      body: message, status, twilio_sid: twilioSid,
      created_at: new Date(),
    })

    return NextResponse.json({ ok: true, data: { id, status } })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
