import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

// Twilio webhook for incoming SMS
export async function POST(req: Request) {
  try {
    const formData = await req.formData()
    const from = formData.get('From') as string
    const to = formData.get('To') as string
    const body = formData.get('Body') as string
    const sid = formData.get('MessageSid') as string

    if (!from || !body) {
      return new NextResponse('<Response></Response>', { headers: { 'Content-Type': 'text/xml' } })
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Find the contact by phone number
    const contact = await knex('customer_entities')
      .where('primary_phone', from)
      .whereNull('deleted_at')
      .first()

    // Store the inbound message
    await knex('sms_messages').insert({
      id: require('crypto').randomUUID(),
      tenant_id: contact?.tenant_id || null,
      organization_id: contact?.organization_id || null,
      contact_id: contact?.id || null,
      direction: 'inbound',
      from_number: from,
      to_number: to || '',
      body,
      status: 'delivered',
      twilio_sid: sid,
      created_at: new Date(),
    })

    console.log(`[sms.webhook] Received from ${from}: ${body}`)

    // Return TwiML response (empty — no auto-reply)
    return new NextResponse('<Response></Response>', { headers: { 'Content-Type': 'text/xml' } })
  } catch (error) {
    console.error('[sms.webhook]', error)
    return new NextResponse('<Response></Response>', { headers: { 'Content-Type': 'text/xml' } })
  }
}
