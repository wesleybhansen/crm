import type { GtmResearchRun } from '../../data/entities'
import type { JudgeEm, JudgePlay, JudgeRunResult } from './judge'

/*
 * Runs the AI lead check after a research run, billed to the customer: the
 * pooled AI allowance is checked first (fail closed: no allowance, no check,
 * the rule verdicts stand), and every model call is metered to the customer's
 * credits through the same canonical meter the other GTM AI surfaces use.
 * Never throws: a failure here must not turn a finished run into an error.
 * Switched off with GTM_LEAD_CHECK_ENABLED=false.
 */

/** True only for an explicit `rescueNearMisses: true` frozen into the run's limits. */
export function rescueNearMissesEnabled(limits: unknown): boolean {
  return Boolean(limits) && typeof limits === 'object' && (limits as Record<string, unknown>).rescueNearMisses === true
}

export type LeadCheckOutcome =
  | ({ status: 'checked' } & JudgeRunResult)
  | { status: 'skipped'; reason: 'disabled' | 'allowance' | 'ai_unconfigured' | 'error' }

export async function runLeadCheck(input: {
  em: unknown
  run: GtmResearchRun
  play: JudgePlay
  noliUserId: string
  requestId?: string | null
}): Promise<LeadCheckOutcome> {
  if ((process.env.GTM_LEAD_CHECK_ENABLED ?? '').trim() === 'false') return { status: 'skipped', reason: 'disabled' }
  try {
    const { checkCustomersAiAllowance } = await import('../../../../lib/usage/allowance')
    const { meterCustomersAiStrict } = await import('../../../../lib/usage/meter')
    const gate = await checkCustomersAiAllowance({ orgId: input.run.organizationId }, 'google', { failureMode: 'closed' })
    if (!gate.allowed) return { status: 'skipped', reason: 'allowance' }
    const apiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (!apiKey) return { status: 'skipped', reason: 'ai_unconfigured' }
    const { createGeminiDraftModel } = await import('../ai/model')
    const { createGtmTelemetryMeter } = await import('../ai/telemetry')
    const { judgeRunOpportunities } = await import('./judge')
    const ctx = { organizationId: input.run.organizationId, tenantId: input.run.tenantId, userId: input.noliUserId, requestId: input.requestId ?? null }
    const meter = createGtmTelemetryMeter({
      em: input.em as never,
      ctx,
      surface: 'lead_check',
      operationKey: `gtm:lead-check:${input.run.id}`,
      canonicalMeter: async (usage, invocationKey) => {
        await meterCustomersAiStrict({ orgId: input.run.organizationId }, {
          noliUserId: input.noliUserId,
          model: usage.model,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          feature: usage.feature,
          byoKey: !!gate.byoApiKey,
          idempotencyKey: invocationKey,
          metadata: {
            status: usage.status === 'failed' ? 'failed' : 'completed',
            attempt: 1,
            token_usage_known: usage.tokenUsageKnown !== false,
            failure_code: usage.failureCode ?? null,
            retry_count: usage.retryCount ?? 0,
            research_run_id: input.run.id,
          },
        })
      },
    })
    const result = await judgeRunOpportunities({
      em: input.em as JudgeEm,
      run: input.run,
      play: input.play,
      model: createGeminiDraftModel(apiKey),
      meter,
      // Opt-in per run: only a run created with limits.rescueNearMisses
      // (the Launch Pad's included first run) reads its near-miss listings.
      rescueNearMisses: rescueNearMissesEnabled(input.run.limits),
    })
    return { status: 'checked', ...result }
  } catch (error) {
    console.error('[gtm.lead-check] skipped after an error', input.run.id, error instanceof Error ? error.message : error)
    return { status: 'skipped', reason: 'error' }
  }
}
