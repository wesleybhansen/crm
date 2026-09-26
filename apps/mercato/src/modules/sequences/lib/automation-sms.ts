import { randomUUID } from 'crypto'
import type { Knex } from 'knex'
import { decryptRowFields, CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'
import { openSecretForTenant } from '@open-mercato/shared/lib/encryption/secretColumns'
import { buildSenderContext, recordReviewRequest, requiresReviewUrl, substituteTemplateVars } from './template-vars'
import {
  SMS_OPT_OUT_CHECK_FAILED_REASON,
  findSmsOptOut,
  isTwilioUnsubscribedError,
  recordSmsOptOut,
  smsOptedOutReason,
  type SmsOptOut,
} from '../../customers/lib/sms-opt-outs'

/*
 * The "Send SMS" automation action, and the sequence "Send SMS" step
 * (./sms-step.ts). Both used to write a log line and report success without
 * sending anything. Now it texts the contact from the
 * business's OWN Twilio connection (twilio_connections: their account, their
 * number), never a Noli number. Without a connected Twilio account the action
 * is SKIPPED with a reason the owner sees in the rule's run history.
 *
 * Opt-outs (2026-09-26): a person who replied STOP to the business's number
 * (sms_opt_outs, this organization and tenant, by number) is never texted.
 * The send is refused before anything is written, with a plain reason
 * (optedOut), and never retried. Twilio's error 21610 ("unsubscribed
 * recipient") is recorded as an opt-out and answered the same way. If the
 * opt-out list cannot be read, nothing is sent (checkFailed).
 *
 * Relative imports only: automation actions run from worker-bundled subscribers.
 */

export type AutomationSmsResult = {
  success: boolean
  skipped?: boolean
  /** Refused: the person opted out of this business's texts. Never retried. */
  optedOut?: boolean
  /** Not sent: the opt-out list could not be read. Safe to try again later. */
  checkFailed?: boolean
  detail: string
}

export type AutomationSmsFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: URLSearchParams },
) => Promise<{ json(): Promise<unknown> }>

export function normalizePhone(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let n = value.replace(/[\s\-().]/g, '')
  if (!n || isEncryptedEnvelope(value)) return null
  if (/^\d{10}$/.test(n)) n = `+1${n}`
  else if (/^1\d{10}$/.test(n)) n = `+${n}`
  else if (!n.startsWith('+')) n = `+${n}`
  return /^\+\d{8,15}$/.test(n) ? n : null
}

export async function sendAutomationSms(
  knex: Knex,
  scope: { organizationId: string; tenantId: string },
  input: { contactId?: string | null; message?: unknown; ruleId?: string | null; reference?: string | null },
  deps: { fetchImpl?: AutomationSmsFetch; openSecret?: (tenantId: string, stored: unknown) => Promise<string | null> } = {},
): Promise<AutomationSmsResult> {
  const template = typeof input.message === 'string' ? input.message.trim() : ''
  if (!template) return { success: false, skipped: true, detail: 'Skipped: this Send SMS step has no message.' }
  if (!input.contactId) return { success: false, skipped: true, detail: 'Skipped: this event has no contact to text.' }

  const connection = await knex('twilio_connections')
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .where('is_active', true)
    .first()
  if (!connection) {
    return {
      success: false,
      skipped: true,
      detail: 'Skipped: no Twilio account is connected. Connect your own Twilio number on the SMS (Twilio) card in Settings and these texts will send.',
    }
  }
  const fromNumber = normalizePhone(connection.phone_number)
  if (!fromNumber) {
    return { success: false, skipped: true, detail: 'Skipped: your Twilio connection has no sending number. Reconnect Twilio in Settings.' }
  }

  const contact = await knex('customer_entities')
    .where('id', input.contactId)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .whereNull('deleted_at')
    .first('id', 'primary_phone', 'display_name')
  if (contact) {
    await decryptRowFields(null, CONTACT_ENTITY_KEY, [contact], ['primary_phone', 'display_name'], scope.tenantId, scope.organizationId)
  }
  const to = normalizePhone(contact?.primary_phone)
  if (!to) return { success: false, skipped: true, detail: 'Skipped: the contact has no mobile number on file.' }

  // Opted out of this business's texts: refused before anything is written.
  let optOut: SmsOptOut | null
  try {
    optOut = await findSmsOptOut(knex, scope, [to])
  } catch (err) {
    console.error('[automation-sms] opt-out list unavailable; not sending', err instanceof Error ? err.message : err)
    return { success: false, checkFailed: true, detail: SMS_OPT_OUT_CHECK_FAILED_REASON }
  }
  if (optOut) return { success: false, skipped: true, optedOut: true, detail: smsOptedOutReason(optOut) }

  const sender = await buildSenderContext(knex, scope.organizationId)
  const isReviewRequest = requiresReviewUrl(template)
  if (isReviewRequest && !sender.review_url) {
    return { success: false, skipped: true, detail: 'Skipped review request: no review link configured. Add your review link on the Reputation page, then this automation will send.' }
  }
  const fullName = typeof contact?.display_name === 'string' && !isEncryptedEnvelope(contact.display_name) ? contact.display_name : ''
  const body = substituteTemplateVars(template, {
    contact: { first_name: fullName.split(' ')[0] || 'there', full_name: fullName || null },
    sender,
    reference: input.reference ?? null,
  }).trim()
  if (!body) return { success: false, skipped: true, detail: 'Skipped: the message is empty after filling in its variables.' }

  const openSecret = deps.openSecret ?? ((tenantId: string, stored: unknown) => openSecretForTenant(null, tenantId, stored as string))
  const authToken = await openSecret(connection.tenant_id ?? scope.tenantId, connection.auth_token)
  if (!authToken) return { success: false, detail: 'Twilio credentials could not be read. Reconnect Twilio in Settings.' }

  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init))
  let twilioSid: string | null = null
  let errorMessage: string | null = null
  let carrierUnsubscribed = false
  try {
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${connection.account_sid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${connection.account_sid}:${authToken}`).toString('base64'),
      },
      body: new URLSearchParams({ To: to, From: fromNumber, Body: body }),
    })
    const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number }
    if (data?.sid) twilioSid = data.sid
    else {
      errorMessage = data?.message || 'Twilio rejected the message'
      carrierUnsubscribed = isTwilioUnsubscribedError(data)
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : 'Failed to reach Twilio'
  }

  const now = new Date()
  await knex('sms_messages').insert({
    id: randomUUID(),
    tenant_id: scope.tenantId,
    organization_id: scope.organizationId,
    contact_id: input.contactId,
    direction: 'outbound',
    from_number: fromNumber,
    to_number: to,
    body,
    status: twilioSid ? 'sent' : 'failed',
    twilio_sid: twilioSid,
    created_at: now,
  }).catch((err: unknown) => console.error('[automation-sms] could not record the message', err))

  if (carrierUnsubscribed) {
    // Twilio 21610: the number unsubscribed from this sender. Record it so no
    // later send is attempted, and report it as an opt-out, not a failure.
    await recordSmsOptOut(knex, scope, { phone: to, contactId: input.contactId, source: 'carrier', at: now })
      .catch((err: unknown) => console.error('[automation-sms] could not record the opt-out', err instanceof Error ? err.message : err))
    return {
      success: false,
      skipped: true,
      optedOut: true,
      detail: smsOptedOutReason({ optedOutAt: now, source: 'carrier', keyword: null }),
    }
  }
  if (!twilioSid) return { success: false, detail: `SMS failed: ${errorMessage}` }

  try {
    const { upsertInboxConversation } = await import('../../../lib/inbox-conversation')
    await upsertInboxConversation(knex, scope.organizationId, scope.tenantId, {
      contactId: input.contactId,
      channel: 'sms',
      preview: body,
      direction: 'outbound',
      avatarPhone: to,
    })
    const { logTimelineEvent } = await import('../../../lib/timeline')
    await logTimelineEvent(knex, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      contactId: input.contactId,
      eventType: 'sms_sent',
      title: 'Automation text sent',
      metadata: { to, ruleId: input.ruleId ?? null, source: 'automation' },
    })
  } catch {}
  if (isReviewRequest) {
    await recordReviewRequest(knex, {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      contactId: input.contactId,
      ruleId: input.ruleId ?? null,
      channel: 'sms',
    })
  }
  return { success: true, detail: `SMS sent from ${fromNumber} (Twilio ${twilioSid})` }
}
