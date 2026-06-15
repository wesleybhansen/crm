// ORM-SKIP: complex multi-table logic or public/webhook endpoint

import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export const metadata = { path: '/sms/webhook', POST: { requireAuth: false } }

// Twilio signs each request: HMAC-SHA1 over (full URL + each POST param sorted by
// key, concatenated), keyed by the account auth token, base64. We try a couple of
// URL reconstructions to tolerate the nginx proxy rewriting host/proto.
function validTwilioSignature(authToken: string, urls: string[], params: Record<string, string>, signature: string | null): boolean {
  if (!signature) return false
  const suffix = Object.keys(params).sort().map((k) => k + params[k]).join('')
  const expectedBuf = Buffer.from(signature)
  for (const u of urls) {
    const digest = crypto.createHmac('sha1', authToken).update(Buffer.from(u + suffix, 'utf-8')).digest('base64')
    const got = Buffer.from(digest)
    if (got.length === expectedBuf.length && crypto.timingSafeEqual(got, expectedBuf)) return true
  }
  return false
}

// Normalize a phone number to E.164-ish form (+<digits>) so we can compare the
// Twilio "To" param against the stored dedicated CS number regardless of
// formatting differences. Returns null for empty/invalid input.
function normalizeE164(v: unknown): string | null {
  if (typeof v !== 'string') return null
  let n = v.replace(/[\s\-\(\)\.]/g, '')
  if (!n) return null
  if (n.match(/^\d{10}$/)) n = `+1${n}`
  else if (n.match(/^1\d{10}$/)) n = `+${n}`
  else if (!n.startsWith('+')) n = `+${n}`
  return n
}

// Twilio webhook for incoming SMS
// Routes inbound messages to the correct org by looking up the "To" phone number
export async function POST(req: Request) {
  try {
    const formData = await req.formData()
    const params: Record<string, string> = {}
    for (const [k, v] of formData.entries()) params[k] = typeof v === 'string' ? v : ''
    const from = params['From']
    const to = params['To']
    const body = params['Body']
    const sid = params['MessageSid']

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

    // SECURITY: an inbound SMS is only trusted if it carries a valid Twilio
    // signature from the owning connection. No connection / bad signature → drop
    // (prevents forged inbound SMS being injected into any org's inbox). This
    // also removes the old cross-org "search all orgs" fallback.
    const reqUrl = new URL(req.url)
    const fwdHost = req.headers.get('x-forwarded-host') || reqUrl.host
    const candidateUrls = [
      `${process.env.APP_URL || ''}${reqUrl.pathname}${reqUrl.search}`,
      `https://${fwdHost}${reqUrl.pathname}${reqUrl.search}`,
      `${reqUrl.origin}${reqUrl.pathname}${reqUrl.search}`,
    ].filter((u) => u && !u.startsWith(reqUrl.pathname))
    const signature = req.headers.get('x-twilio-signature')
    if (!twilioConnection?.auth_token || !validTwilioSignature(twilioConnection.auth_token, candidateUrls, params, signature)) {
      console.warn('[sms.webhook] rejected: missing connection or invalid Twilio signature', { to })
      return new NextResponse('<Response></Response>', { status: 403, headers: { 'Content-Type': 'text/xml' } })
    }

    const orgId = twilioConnection.organization_id
    const tenantId = twilioConnection.tenant_id

    // Find the contact by phone number within the (verified) org
    const contact = await knex('customer_entities')
      .where('primary_phone', from)
      .where('organization_id', orgId)
      .whereNull('deleted_at')
      .first()

    // Idempotency: Twilio retries inbound webhooks on timeout/5xx. Skip if we
    // already stored this MessageSid so a retry doesn't duplicate the message
    // or double-increment the inbox unread count.
    if (sid) {
      const seen = await knex('sms_messages').where('twilio_sid', sid).first()
      if (seen) {
        return new NextResponse('<Response></Response>', { headers: { 'Content-Type': 'text/xml' } })
      }
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

    // Is this inbound SMS addressed to the org's DEDICATED customer-service
    // number? If so, it is routed into the Customer Service drafting flow (the
    // recurring processor picks it up). Otherwise it stays inbox-only as before.
    // The number is read from the org's own settings row (server-side), never
    // from client input. We compare on a normalized form so formatting differences
    // (e.g. spaces) between Twilio's "To" and the stored value don't break the match.
    let isCustomerServiceSms = false
    if (orgId) {
      try {
        const csSettings = await knex('customer_service_settings')
          .where('organization_id', orgId)
          .where('enabled', true)
          .first()
        const csNumber = normalizeE164(csSettings?.cs_sms_number)
        if (csNumber && normalizeE164(to) === csNumber) {
          isCustomerServiceSms = true
        }
      } catch {
        // Table may not exist yet (pre-migration); fall back to inbox-only.
      }
    }

    // Update unified inbox. For customer-service SMS we tag the conversation so
    // the CS processor can find it: channel='sms', re-open it, and CLEAR the
    // anti-reprocess marker (cs_drafted_at) so a fresh inbound gets a new draft
    // even on a thread that was drafted before.
    if (orgId && tenantId) {
      const { upsertInboxConversation } = await import('@/lib/inbox-conversation')
      await upsertInboxConversation(knex, orgId, tenantId, {
        contactId: contact?.id || null,
        channel: 'sms',
        preview: body,
        direction: 'inbound',
        displayName: contact?.display_name || from,
        avatarPhone: from,
      }).catch(() => {})

      if (isCustomerServiceSms) {
        // Reset cs_drafted_at on the (just-upserted) conversation for this contact
        // / phone so the processor re-drafts for this new inbound message.
        try {
          const convQuery = knex('inbox_conversations')
            .where('organization_id', orgId)
          if (contact?.id) convQuery.where('contact_id', contact.id)
          else convQuery.where('avatar_phone', from)
          await convQuery.update({ cs_drafted_at: null })
        } catch {}
      }
    }

    console.log(`[sms.webhook] Received from ${from} to ${to} (org: ${orgId || 'unknown'}, cs: ${isCustomerServiceSms}): ${body}`)

    return new NextResponse('<Response></Response>', { headers: { 'Content-Type': 'text/xml' } })
  } catch (error) {
    console.error('[sms.webhook]', error)
    return new NextResponse('<Response></Response>', { headers: { 'Content-Type': 'text/xml' } })
  }
}
