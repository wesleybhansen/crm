/**
 * One sequence email step, as run by the sequence processor.
 *
 * Product rule (2026-09-24): Noli never sends a customer's email without the
 * customer's own connected mailbox or ESP, and never falls back to anything
 * else. Before this, a step with no sending setup logged the router error,
 * left a dangling 'queued' email_messages row from 'pending@router', and was
 * still marked 'executed', so the enrollment marched on as if it had sent.
 *
 * Now:
 * - no sending setup  -> nothing is written to email_messages, the step stays
 *   'scheduled' (retried every SEQUENCE_EMAIL_WAIT_RETRY_MS) with a visible
 *   waiting reason, and the enrollment does not advance. It resumes on its own
 *   once an email account is connected.
 * - send failed       -> the message row and the step are recorded 'failed'
 *   with the provider's error (not 'executed').
 * - sent              -> the message row is marked 'sent' with the real from
 *   address, and the step 'executed'.
 * - unsubscribed      -> (2026-09-26) the person unsubscribed from this
 *   business's email (email_unsubscribes, by contact or address, this
 *   organization and tenant only). Checked first, before anything is written:
 *   the step is 'skipped' with the reason, and the enrollment is stopped
 *   ('unsubscribed'); it is never retried or advanced. The router refuses the
 *   same send too, so a race between the two checks ends the same way.
 *   If the list cannot be read, the step waits and is retried, never sent.
 *
 * Relative imports only: keep this file safe for worker bundling.
 */
import { randomUUID } from 'crypto'
import type { Knex } from 'knex'
import type { EmailPurpose } from '../../email/lib/routing-service'
import { UNSUBSCRIBED_CODE, UNSUBSCRIBED_STOP_REASON } from '../../email/lib/unsubscribes'

export const SEQUENCE_EMAIL_WAIT_RETRY_MS = 15 * 60 * 1000
export const SEQUENCE_WAITING_CODE = 'email_not_connected'
export const SEQUENCE_WAITING_MESSAGE = 'Waiting: connect an email account in Settings to send'
export const SEQUENCE_UNSUBSCRIBE_CHECK_WAITING_CODE = 'unsubscribe_check_failed'
export const SEQUENCE_UNSUBSCRIBE_CHECK_WAITING_MESSAGE =
  'Waiting: the unsubscribe list could not be checked, so this email was not sent. It is tried again shortly.'
export const SEQUENCE_ACTIVATE_BLOCKED_MESSAGE =
  'Connect an email account in Settings before activating this sequence; nothing will be sent until then.'

export type SequenceEmailStepInput = {
  executionId: string
  enrollmentId: string
  organizationId: string
  tenantId: string
  contactId: string
  to: string
  subject: string
  bodyHtml: string
}

export type SequenceEmailStepDeps = {
  /**
   * Required, so no caller can run an email step without the unsubscribe
   * gate: isRecipientUnsubscribed in production.
   */
  isUnsubscribed: (
    knex: Knex,
    scope: { organizationId: string; tenantId: string },
    recipient: { contactId: string; emails: string[] },
  ) => Promise<boolean>
  hasSendingSetup: (knex: Knex, orgId: string, purpose: EmailPurpose) => Promise<boolean>
  send: (
    knex: Knex,
    orgId: string,
    tenantId: string,
    purpose: EmailPurpose,
    params: { to: string; subject: string; htmlBody: string; contactId?: string },
  ) => Promise<{ ok: boolean; code?: string; error?: string; fromAddress?: string; messageId?: string }>
  now?: () => Date
}

export type SequenceEmailStepOutcome = 'waiting' | 'sent' | 'failed' | 'unsubscribed'

/** The step says why, and the sequence stops for this person: never retried, never advanced. */
async function stopUnsubscribed(knex: Knex, input: SequenceEmailStepInput, now: Date): Promise<'unsubscribed'> {
  await knex('sequence_step_executions').where('id', input.executionId).update({
    status: 'skipped',
    result: JSON.stringify({ skipped: true, unsubscribed: true, reason: UNSUBSCRIBED_STOP_REASON }),
    executed_at: now,
  })
  await knex('sequence_enrollments')
    .where('id', input.enrollmentId)
    .where('organization_id', input.organizationId)
    .where('status', 'active')
    .update({ status: 'unsubscribed', paused_at: now })
  return 'unsubscribed'
}

export async function runSequenceEmailStep(
  knex: Knex,
  input: SequenceEmailStepInput,
  deps: SequenceEmailStepDeps,
): Promise<SequenceEmailStepOutcome> {
  const now = deps.now ? deps.now() : new Date()

  let unsubscribed: boolean
  try {
    unsubscribed = await deps.isUnsubscribed(
      knex,
      { organizationId: input.organizationId, tenantId: input.tenantId },
      { contactId: input.contactId, emails: [input.to] },
    )
  } catch (err) {
    console.error('[sequences.process] unsubscribe list unavailable; the email step waits', err instanceof Error ? err.message : err)
    await knex('sequence_step_executions').where('id', input.executionId).update({
      status: 'scheduled',
      scheduled_for: new Date(now.getTime() + SEQUENCE_EMAIL_WAIT_RETRY_MS),
      result: JSON.stringify({ waiting: SEQUENCE_UNSUBSCRIBE_CHECK_WAITING_CODE, reason: SEQUENCE_UNSUBSCRIBE_CHECK_WAITING_MESSAGE }),
    })
    return 'waiting'
  }
  if (unsubscribed) return stopUnsubscribed(knex, input, now)

  if (!(await deps.hasSendingSetup(knex, input.organizationId, 'marketing'))) {
    // Back to 'scheduled' (it was claimed as 'processing'), pushed forward so a
    // waiting org does not crowd the 50-row batch on every tick.
    await knex('sequence_step_executions').where('id', input.executionId).update({
      status: 'scheduled',
      scheduled_for: new Date(now.getTime() + SEQUENCE_EMAIL_WAIT_RETRY_MS),
      result: JSON.stringify({ waiting: SEQUENCE_WAITING_CODE, reason: SEQUENCE_WAITING_MESSAGE }),
    })
    return 'waiting'
  }

  const trackingId = randomUUID()
  const messageId = randomUUID()
  await knex('email_messages').insert({
    id: messageId,
    tenant_id: input.tenantId,
    organization_id: input.organizationId,
    direction: 'outbound',
    from_address: 'pending@router',
    to_address: input.to,
    subject: input.subject,
    body_html: input.bodyHtml,
    contact_id: input.contactId,
    status: 'queued',
    tracking_id: trackingId,
    created_at: now,
  })

  let sendError: string | null = null
  let fromAddress: string | null = null
  let refusedAsUnsubscribed = false
  try {
    const result = await deps.send(knex, input.organizationId, input.tenantId, 'marketing', {
      to: input.to,
      subject: input.subject,
      htmlBody: input.bodyHtml,
      contactId: input.contactId,
    })
    if (result.ok) fromAddress = result.fromAddress ?? null
    else if (result.code === UNSUBSCRIBED_CODE) refusedAsUnsubscribed = true
    else sendError = result.error || 'Send failed'
  } catch (err) {
    sendError = err instanceof Error ? err.message : 'Send failed'
  }

  if (refusedAsUnsubscribed) {
    // The router's gate caught an unsubscribe that landed after our check.
    await knex('email_messages').where('id', messageId).where('organization_id', input.organizationId).update({ status: 'failed' })
    return stopUnsubscribed(knex, input, now)
  }

  if (sendError !== null) {
    console.error(`[sequences.process] Failed to send email to ${input.to}:`, sendError)
    await knex('email_messages').where('id', messageId).update({ status: 'failed' })
    await knex('sequence_step_executions').where('id', input.executionId).update({
      status: 'failed',
      result: JSON.stringify({ error: sendError, to: input.to, subject: input.subject, tracking_id: trackingId }),
      executed_at: now,
    })
    return 'failed'
  }

  await knex('email_messages').where('id', messageId).update({
    status: 'sent',
    sent_at: now,
    ...(fromAddress ? { from_address: fromAddress } : {}),
  })
  await knex('sequence_step_executions').where('id', input.executionId).update({
    status: 'executed',
    result: JSON.stringify({ sent_to: input.to, subject: input.subject, tracking_id: trackingId }),
    executed_at: now,
  })
  return 'sent'
}
