import type { Knex } from 'knex'
import crypto from 'crypto'
import { upsertInboxConversation } from '@/lib/inbox-conversation'

/**
 * Shared "send a drafted customer-service SMS reply for the org" logic. Mirrors
 * send-reply.ts (email) but sends over the org's BYO Twilio connection FROM the
 * dedicated customer-service number (cs_sms_number), records the outbound
 * sms_messages row, and keeps the unified inbox + contact timeline current.
 *
 * Org-scope is the caller's responsibility: pass the trusted orgId/tenantId from
 * server-side auth (approve) or from the org's own settings row (the cron). This
 * function never reads org from a client. The FROM number is always the org's
 * configured cs_sms_number, never client input.
 *
 * BYO Twilio only: uses the org's twilio_connections account_sid/auth_token.
 */

export type SendSmsReplyInput = {
  to: string
  body: string
  contactId?: string | null
}

export type SendSmsReplyResult = {
  ok: boolean
  error?: string
  status?: number
  twilioSid?: string | null
}

// Normalize a phone number to E.164-ish form (+<digits>).
function normalizeE164(v: unknown): string | null {
  if (typeof v !== 'string') return null
  let n = v.replace(/[\s\-\(\)\.]/g, '')
  if (!n) return null
  if (n.match(/^\d{10}$/)) n = `+1${n}`
  else if (n.match(/^1\d{10}$/)) n = `+${n}`
  else if (!n.startsWith('+')) n = `+${n}`
  return n
}

export async function sendSmsReply(
  knex: Knex,
  orgId: string,
  tenantId: string,
  input: SendSmsReplyInput,
): Promise<SendSmsReplyResult> {
  const to = normalizeE164(input.to)
  const bodyText = (input.body || '').trim()
  const contactId = input.contactId || null

  if (!to || !bodyText) {
    return { ok: false, error: 'Draft is missing a recipient or body', status: 400 }
  }

  // Resolve the org's dedicated customer-service SMS number + its Twilio creds.
  const settings = await knex('customer_service_settings').where('organization_id', orgId).first()
  const fromNumber = normalizeE164(settings?.cs_sms_number)
  if (!fromNumber) {
    return { ok: false, error: 'No customer service SMS number is configured. Set one in Customer Service settings.', status: 400 }
  }

  const conn = await knex('twilio_connections')
    .where('organization_id', orgId)
    .where('is_active', true)
    .first()
  if (!conn) {
    return { ok: false, error: 'Connect your Twilio account in Settings to send SMS.', status: 400 }
  }

  const accountSid = conn.account_sid
  const authToken = conn.auth_token
  const messageId = crypto.randomUUID()
  let status = 'queued'
  let twilioSid: string | null = null

  try {
    const twilioRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        },
        body: new URLSearchParams({ To: to, From: fromNumber, Body: bodyText }),
      },
    )
    const twilioData = await twilioRes.json().catch(() => ({}))
    if (twilioData?.sid) {
      status = 'sent'
      twilioSid = twilioData.sid
    } else {
      console.error('[send-sms-reply] Twilio error:', twilioData)
      return { ok: false, error: twilioData?.message || 'Twilio rejected the message', status: 502 }
    }
  } catch (err) {
    console.error('[send-sms-reply] Twilio send failed:', err)
    return { ok: false, error: 'Failed to send SMS', status: 502 }
  }

  const now = new Date()
  await knex('sms_messages').insert({
    id: messageId,
    tenant_id: tenantId,
    organization_id: orgId,
    contact_id: contactId,
    direction: 'outbound',
    from_number: fromNumber,
    to_number: to,
    body: bodyText,
    status,
    twilio_sid: twilioSid,
    created_at: now,
  })

  // Keep the unified inbox current + log to the contact timeline.
  await upsertInboxConversation(knex, orgId, tenantId, {
    contactId,
    channel: 'sms',
    preview: bodyText,
    direction: 'outbound',
    avatarPhone: to,
  }).catch(() => {})

  if (contactId) {
    try {
      const { logTimelineEvent } = await import('@/lib/timeline')
      await logTimelineEvent(knex, {
        tenantId,
        organizationId: orgId,
        contactId,
        eventType: 'sms_sent',
        title: 'SMS sent',
        metadata: { to, source: 'customer_service' },
      })
    } catch {}
  }

  return { ok: true, twilioSid }
}
