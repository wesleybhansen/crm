import 'server-only'
import { getNoliCoreClient } from '@open-mercato/shared/lib/noli/core-client'

/**
 * AI usage logger for CRM. Writes one row to noli-core ai_usage per
 * provider call. Fire-and-forget — never blocks the response on insert
 * failure, but errors are logged so we notice in console.
 *
 * Same shape as the AMS / KB / PM helpers in the noli-platform monorepo
 * so admin dashboards can aggregate across products. Pricing table is
 * an approximation; refine when the underlying ai-clients surface
 * provider-reported usage directly.
 *
 * Pricing convention: 1 credit ≈ $0.0001 of provider cost. 1¢ = 100 credits.
 */

type ModelPricing = { in: number; out: number }

const PRICING: Record<string, ModelPricing> = {
  // Anthropic (per 1M tokens)
  'claude-3-5-sonnet-20241022': { in: 3.0, out: 15.0 },
  'claude-3-5-haiku-20241022': { in: 0.8, out: 4.0 },
  'claude-3-opus-20240229': { in: 15.0, out: 75.0 },
  'claude-haiku': { in: 0.25, out: 1.25 },
  'claude-sonnet': { in: 3.0, out: 15.0 },
  'claude-opus-4-6': { in: 15.0, out: 75.0 },
  // OpenAI
  'gpt-4o': { in: 2.5, out: 10.0 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-5-nano': { in: 0.05, out: 0.4 },
  'gpt-5-mini': { in: 0.25, out: 2.0 },
  'gpt-5.4': { in: 5.0, out: 15.0 },
  // Google
  'gemini-3.5-flash': { in: 0.075, out: 0.3 },
  'gemini-2.5-pro': { in: 1.25, out: 5.0 },
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
      const inCost = (args.tokensIn / 1_000_000) * pricing.in
      const outCost = (args.tokensOut / 1_000_000) * pricing.out
      costCents = Math.round((inCost + outCost) * 100)
    }
    const creditsConsumed = costCents * 100

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
