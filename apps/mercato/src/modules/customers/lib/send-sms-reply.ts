import type { Knex } from 'knex'
import crypto from 'crypto'
import { openSecretForTenant } from '@open-mercato/shared/lib/encryption/secretColumns'
import { upsertInboxConversation } from '@/lib/inbox-conversation'
import {
  SMS_OPTED_OUT_CODE,
  findSmsOptOut,
  isTwilioUnsubscribedError,
  recordSmsOptOut,
  smsOptedOutReason,
  type SmsOptOut,
} from './sms-opt-outs'

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
 *
 * Opt-outs (2026-09-26): a number that replied STOP to this business
 * (sms_opt_outs, this organization and tenant) is refused before anything is
 * sent, for every caller: the automatic Customer Service and inbox replies,
 * a human approving a draft, and the hub's Texts tab. The result carries
 * code 'sms_opted_out', HTTP 409 and a plain reason. Twilio error 21610 is
 * recorded as an opt-out and refused the same way.
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
  /** 'sms_opted_out' when the person opted out of this business's texts. */
  code?: string
  /** When they opted out (ISO), with code 'sms_opted_out'. */
  optedOutAt?: string
}

function optedOutResult(optOut: Pick<SmsOptOut, 'optedOutAt' | 'source' | 'keyword'>): SendSmsReplyResult {
  return {
    ok: false,
    code: SMS_OPTED_OUT_CODE,
    error: smsOptedOutReason(optOut),
    status: 409,
    optedOutAt: optOut.optedOutAt.toISOString(),
  }
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

  // Opted out of this business's texts: refused before anything is sent.
  try {
    const optOut = await findSmsOptOut(knex, { organizationId: orgId, tenantId }, [to])
    if (optOut) return optedOutResult(optOut)
  } catch (err) {
    console.error('[send-sms-reply] opt-out list unavailable; not sending', err instanceof Error ? err.message : err)
    return { ok: false, error: 'Not sent: the text opt-out list could not be checked. Try again shortly.', status: 503 }
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
  const authToken = await openSecretForTenant(null, conn.tenant_id ?? tenantId, conn.auth_token)
  if (!authToken) {
    return { ok: false, error: 'Twilio credentials could not be read. Reconnect Twilio in Settings.', status: 400 }
  }
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
    } else if (isTwilioUnsubscribedError(twilioData)) {
      // Twilio 21610: this number unsubscribed from the sender. Record it so no
      // later send is attempted.
      const at = new Date()
      await recordSmsOptOut(knex, { organizationId: orgId, tenantId }, { phone: to, contactId, source: 'carrier', at })
        .catch((err: unknown) => console.error('[send-sms-reply] could not record the opt-out', err instanceof Error ? err.message : err))
      return optedOutResult({ optedOutAt: at, source: 'carrier', keyword: null })
    } else {
      console.error('[send-sms-reply] Twilio error:', { code: twilioData?.code ?? null, status: twilioData?.status ?? null })
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
