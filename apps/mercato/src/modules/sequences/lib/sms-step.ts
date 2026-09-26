import type { Knex } from 'knex'
import { sendAutomationSms, type AutomationSmsResult } from './automation-sms'

/**
 * One sequence "Send SMS" step, as run by the sequence processor. It used to
 * log a line and mark itself executed without texting anyone. It now sends
 * exactly as the automation "Send SMS" action does (./automation-sms.ts):
 * from the business's own connected Twilio number, never a Noli number.
 *
 * - sent    -> the step is 'executed' and the enrollment moves on.
 * - skipped -> no Twilio account connected, no sending number, no mobile
 *   number for the contact, or an empty message: the step is 'skipped' with
 *   the reason (shown on the enrollment) and the enrollment moves on, as the
 *   automation action does.
 * - failed  -> Twilio refused or could not be reached: the step is 'failed'
 *   with the error, and the processor stops the enrollment where it is, the
 *   same as a failed email step.
 *
 * Relative imports only: keep this file safe for worker bundling.
 */

export type SequenceSmsStepOutcome = 'sent' | 'skipped' | 'failed'

export type SequenceSmsStepInput = {
  executionId: string
  organizationId: string
  tenantId: string
  contactId: string
  message: unknown
}

export type SequenceSmsStepDeps = {
  send?: typeof sendAutomationSms
  now?: () => Date
}

export async function runSequenceSmsStep(
  knex: Knex,
  input: SequenceSmsStepInput,
  deps: SequenceSmsStepDeps = {},
): Promise<SequenceSmsStepOutcome> {
  const now = deps.now ? deps.now() : new Date()
  const send = deps.send ?? sendAutomationSms
  let result: AutomationSmsResult
  try {
    result = await send(knex, { organizationId: input.organizationId, tenantId: input.tenantId }, {
      contactId: input.contactId,
      message: input.message,
    })
  } catch (err) {
    result = { success: false, detail: `SMS failed: ${err instanceof Error ? err.message : 'unknown error'}` }
  }

  if (result.success) {
    await knex('sequence_step_executions').where('id', input.executionId).update({
      status: 'executed',
      result: JSON.stringify({ sms: 'sent', detail: result.detail }),
      executed_at: now,
    })
    return 'sent'
  }
  if (result.skipped) {
    await knex('sequence_step_executions').where('id', input.executionId).update({
      status: 'skipped',
      result: JSON.stringify({ skipped: true, reason: result.detail }),
      executed_at: now,
    })
    return 'skipped'
  }
  await knex('sequence_step_executions').where('id', input.executionId).update({
    status: 'failed',
    result: JSON.stringify({ error: result.detail }),
    executed_at: now,
  })
  return 'failed'
}
