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
 *
 * Relative imports only: keep this file safe for worker bundling.
 */
import { randomUUID } from 'crypto'
import type { Knex } from 'knex'
import type { EmailPurpose } from '../../email/lib/routing-service'

export const SEQUENCE_EMAIL_WAIT_RETRY_MS = 15 * 60 * 1000
export const SEQUENCE_WAITING_CODE = 'email_not_connected'
export const SEQUENCE_WAITING_MESSAGE = 'Waiting: connect an email account in Settings to send'
export const SEQUENCE_ACTIVATE_BLOCKED_MESSAGE =
  'Connect an email account in Settings before activating this sequence; nothing will be sent until then.'

export type SequenceEmailStepInput = {
  executionId: string
  organizationId: string
  tenantId: string
  contactId: string
  to: string
  subject: string
  bodyHtml: string
}

export type SequenceEmailStepDeps = {
  hasSendingSetup: (knex: Knex, orgId: string, purpose: EmailPurpose) => Promise<boolean>
  send: (
    knex: Knex,
    orgId: string,
    tenantId: string,
    purpose: EmailPurpose,
    params: { to: string; subject: string; htmlBody: string; contactId?: string },
  ) => Promise<{ ok: boolean; error?: string; fromAddress?: string; messageId?: string }>
  now?: () => Date
}

export type SequenceEmailStepOutcome = 'waiting' | 'sent' | 'failed'

export async function runSequenceEmailStep(
  knex: Knex,
  input: SequenceEmailStepInput,
  deps: SequenceEmailStepDeps,
): Promise<SequenceEmailStepOutcome> {
  const now = deps.now ? deps.now() : new Date()

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
  try {
    const result = await deps.send(knex, input.organizationId, input.tenantId, 'marketing', {
      to: input.to,
      subject: input.subject,
      htmlBody: input.bodyHtml,
      contactId: input.contactId,
    })
    if (result.ok) fromAddress = result.fromAddress ?? null
    else sendError = result.error || 'Send failed'
  } catch (err) {
    sendError = err instanceof Error ? err.message : 'Send failed'
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
