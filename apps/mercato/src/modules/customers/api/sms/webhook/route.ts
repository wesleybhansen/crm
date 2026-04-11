// ORM-SKIP: complex multi-table logic or public/webhook endpoint

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export const metadata = { path: '/sms/webhook', POST: { requireAuth: false } }

// Twilio webhook for incoming SMS
// Routes inbound messages to the correct org by looking up the "To" phone number
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

    // Look up which org owns this phone number
    const twilioConnection = await knex('twilio_connections')
      .where('phone_number', to)
      .where('is_active', true)
      .first()

    const orgId = twilioConnection?.organization_id || null
    const tenantId = twilioConnection?.tenant_id || null

    // Find the contact by phone number within the org
    let contact = null
    if (orgId) {
      contact = await knex('customer_entities')
        .where('primary_phone', from)
        .where('organization_id', orgId)
        .whereNull('deleted_at')
        .first()
    } else {
      // Fallback: search across all orgs (legacy behavior)
      contact = await knex('customer_entities')
        .where('primary_phone', from)
        .whereNull('deleted_at')
        .first()
    }

    // Store the inbound message
    await knex('sms_messages').insert({
      id: require('crypto').randomUUID(),
      tenant_id: tenantId || contact?.tenant_id || null,
      organization_id: orgId || contact?.organization_id || null,
      contact_id: contact?.id || null,
      direction: 'inbound',
      from_number: from,
      to_number: to || '',
      body,
      status: 'delivered',
      twilio_sid: sid,
      created_at: new Date(),
    })

    // Update unified inbox
    if (orgId && tenantId) {
      const { upsertInboxConversation } = await import('@/lib/inbox-conversation')
      upsertInboxConversation(knex, orgId, tenantId, {
        contactId: contact?.id || null,
        channel: 'sms',
        preview: body,
        direction: 'inbound',
        displayName: contact?.display_name || from,
        avatarPhone: from,
      }).catch(() => {})
    }

    console.log(`[sms.webhook] Received from ${from} to ${to} (org: ${orgId || 'unknown'}): ${body}`)

    return new NextResponse('<Response></Response>', { headers: { 'Content-Type': 'text/xml' } })
  } catch (error) {
    console.error('[sms.webhook]', error)
    return new NextResponse('<Response></Response>', { headers: { 'Content-Type': 'text/xml' } })
  }
}
