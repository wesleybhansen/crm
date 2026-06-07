import 'server-only'
import { getNoliCoreClient } from '@open-mercato/shared/lib/noli/core-client'

/**
 * AI usage logger for CRM. Writes one row to noli-core ai_usage per
 * provider call. Fire-and-forget — never blocks the response on insert
 * failure, but errors are logged so we notice in console.
 *
 * Same shape as the AMS / KB / PM helpers in the noli-platform monorepo
 * so admin dashboards can aggregate across products.
 *
 * NOTE: This helper is currently UNUSED — the live CRM metering path is
 * `logCrmAiUsage` in @open-mercato/shared/lib/noli/ai-usage. Kept (and kept in
 * sync) so it doesn't write wrong cost/credits if ever re-wired.
 *
 * Pricing peg: 250,000 credits per $1 of provider cost (credits =
 * round((costCents / 100) * 250000)). Matches ai-usage.ts and the canonical
 * noli-platform MODEL_PRICING table.
 */

type ModelPricing = { in: number; out: number }

// USD per 1M tokens (input / output). Canonical, verified against live pricing.
const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-opus': { in: 5.0, out: 25.0 },
  'claude-sonnet': { in: 3.0, out: 15.0 },
  'claude-haiku': { in: 1.0, out: 5.0 },
  // OpenAI
  'gpt-4o': { in: 2.5, out: 10.0 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-5-nano': { in: 0.05, out: 0.4 },
  'gpt-5-mini': { in: 0.25, out: 2.0 },
  'gpt-5.4-mini': { in: 0.75, out: 4.5 },
  'gpt-5.4': { in: 2.5, out: 15.0 },
  'gpt-5.5': { in: 5.0, out: 30.0 },
  // Google
  'gemini-3.5-flash': { in: 1.5, out: 9.0 },
  'gemini-3-flash': { in: 0.5, out: 3.0 },
  'gemini-3-pro': { in: 2.0, out: 12.0 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'gemini-2.5-pro': { in: 1.25, out: 10.0 },
}

export type LogAiUsageArgs = {
  noliUserId: string
  model: string
  tokensIn: number
  tokensOut: number
  byoKey?: boolean
  feature?: string
  metadata?: Record<string, unknown>
}

export async function logAiUsage(args: LogAiUsageArgs): Promise<void> {
  try {
    const pricing = PRICING[args.model]
    let costCents = 0
    if (pricing) {
      const inCost = (Math.max(0, args.tokensIn) / 1_000_000) * pricing.in
      const outCost = (Math.max(0, args.tokensOut) / 1_000_000) * pricing.out
      // Round provider cost UP to whole cents so we never under-bill.
      costCents = Math.ceil((inCost + outCost) * 100)
    }
    // Peg: 250,000 credits per $1 of provider cost.
    const creditsConsumed = Math.round((costCents / 100) * 250_000)

    const supabase = getNoliCoreClient()
    const { error } = await supabase.from('ai_usage').insert({
      user_id: args.noliUserId,
      app: 'crm',
      model: args.model,
      tokens_in: args.tokensIn,
      tokens_out: args.tokensOut,
      credits_consumed: creditsConsumed,
      cost_cents: costCents,
      byo_key: args.byoKey ?? false,
      metadata: { feature: args.feature ?? null, ...(args.metadata ?? {}) },
    })
    if (error) console.error('[logAiUsage] insert failed', error)
  } catch (err) {
    console.error('[logAiUsage] unexpected error', err)
  }
}
