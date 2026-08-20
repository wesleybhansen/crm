import type { StepSpec } from './build'

/*
 * Projected credit cost for an approval batch (SPEC-066 section 14 Tranche 5).
 *
 * Enrichment and verification credits were already spent upstream (Tranche
 * 4), so at approval time the projection is mostly zero: automated email
 * sends go through the user's own connected mailbox (no per-send provider
 * charge) and manual social steps cost nothing. The seam exists so a future
 * send-cost provider (an ESP that charges per message, an SMS gateway) can
 * price the same batch without touching the approval flow: pass a cost table
 * and the breakdown picks it up.
 */

export type SendCostTable = {
  // credits per automated email send (default 0: user-connected mailbox)
  email_send?: number
  // credits per manual social task (default 0: the user does the work)
  manual_social_task?: number
}

export type CreditBreakdownLine = {
  kind: 'email_send' | 'manual_social_task'
  units: number
  credits_per_unit: number
  credits: number
}

export type CreditProjection = {
  projected_credits: number
  breakdown: CreditBreakdownLine[]
}

export function projectCampaignCredits(
  input: { recipientCount: number; steps: StepSpec[] },
  costs?: SendCostTable | null,
): CreditProjection {
  const emailSteps = input.steps.filter((step) => step.mode === 'automated_email').length
  const manualSteps = input.steps.filter((step) => step.mode === 'manual_social').length
  const perEmail = costs?.email_send ?? 0
  const perTask = costs?.manual_social_task ?? 0

  const breakdown: CreditBreakdownLine[] = [
    {
      kind: 'email_send',
      units: input.recipientCount * emailSteps,
      credits_per_unit: perEmail,
      credits: input.recipientCount * emailSteps * perEmail,
    },
    {
      kind: 'manual_social_task',
      units: input.recipientCount * manualSteps,
      credits_per_unit: perTask,
      credits: input.recipientCount * manualSteps * perTask,
    },
  ]

  return {
    projected_credits: breakdown.reduce((sum, line) => sum + line.credits, 0),
    breakdown,
  }
}
