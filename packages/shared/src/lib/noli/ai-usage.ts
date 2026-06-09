import 'server-only';
import { getNoliCoreClient, findPrimaryOrgIdForUser } from './core-client';

/*
 * Cross-product AI usage metering for CRM. Writes one noli-core `ai_usage` row
 * per AI call (inbox extraction, proposal translation, attachment OCR) so CRM
 * consumption counts toward the customer's pooled allowance — same store the
 * AMS/KB/PM/COS apps already write to.
 *
 * Fire-and-forget: never throws into the calling AI operation, and gracefully
 * no-ops if the NOLI_CORE_* env vars aren't set or the org/user can't resolve.
 *
 * Resolution: callers that have a noli user (request scope, AuthContext) pass
 * `noliUserId`; background jobs that only have the Mercato org pass `noliOrgId`
 * (from Organization.noliOrgId) and we attribute to that noli org's owner —
 * allowance is pooled at the org level, and ai_usage.user_id is NOT NULL.
 */

// USD per 1M tokens (input / output / cached-input). Prefix-matched (longest
// match wins). Keep in sync with the noli-platform MODEL_PRICING canonical table
// (@noli/entitlements-client) — values verified against live provider pricing.
const PRICING: Record<string, { in: number; out: number; cached: number }> = {
  // Anthropic
  'claude-opus-4-2025': { in: 15, out: 75, cached: 1.5 }, // retired Opus 4 (legacy rows)
  'claude-opus': { in: 5, out: 25, cached: 0.5 }, // current Opus
  'claude-sonnet-4-6': { in: 3, out: 15, cached: 0.3 },
  'claude-sonnet': { in: 3, out: 15, cached: 0.3 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5, cached: 0.1 },
  'claude-haiku': { in: 1, out: 5, cached: 0.1 },
  // OpenAI
  'gpt-5.5': { in: 5, out: 30, cached: 0.5 },
  'gpt-5.4-mini': { in: 0.75, out: 4.5, cached: 0.075 },
  'gpt-5.4': { in: 2.5, out: 15, cached: 0.25 },
  'gpt-5-mini': { in: 0.25, out: 2, cached: 0.025 },
  'gpt-5-nano': { in: 0.05, out: 0.4, cached: 0.005 },
  'gpt-4o-mini': { in: 0.15, out: 0.6, cached: 0.075 },
  // Realtime (voice) — audio-weighted rates. Must precede 'gpt-4o' so the
  // longer prefix wins; otherwise realtime audio bills at gpt-4o text rates
  // ($2.5/$10) and is ~16x under-counted.
  'gpt-4o-realtime': { in: 40, out: 80, cached: 2.5 },
  'gpt-realtime': { in: 40, out: 80, cached: 2.5 },
  'gpt-4o': { in: 2.5, out: 10, cached: 1.25 },
  // Google
  'gemini-3.5-flash': { in: 1.5, out: 9, cached: 0.15 },
  'gemini-3-flash': { in: 0.5, out: 3, cached: 0.05 },
  'gemini-3-pro': { in: 2, out: 12, cached: 0.2 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5, cached: 0.03 },
  'gemini-2.5-pro': { in: 1.25, out: 10, cached: 0.125 },
  'gemini': { in: 0.3, out: 2.5, cached: 0.03 }, // generic Gemini fallback (2.5-flash class)
};

// Conservative fallback (round up so we never under-count an unknown model).
const FALLBACK_RATE = { in: 5, out: 15, cached: 0.5 };

// Customer-facing display tokens (credits) peg: 250,000 credits per $1 of
// provider cost. Canonical formula: credits = round((costCents / 100) * 250000).
const DISPLAY_TOKENS_PER_DOLLAR = 250_000;

function rateForModel(model: string): { in: number; out: number; cached: number } {
  const m = (model || '').toLowerCase().trim();
  let best: { key: string; rate: { in: number; out: number; cached: number } } | null = null;
  for (const [key, rate] of Object.entries(PRICING)) {
    if (m.startsWith(key) && (!best || key.length > best.key.length)) best = { key, rate };
  }
  return best?.rate ?? FALLBACK_RATE;
}

// Cache noli orgId → owner userId for the process lifetime.
const ownerCache = new Map<string, string | null>();

async function resolveOwnerUserId(noliOrgId: string): Promise<string | null> {
  if (ownerCache.has(noliOrgId)) return ownerCache.get(noliOrgId) ?? null;
  let userId: string | null = null;
  try {
    const supabase = getNoliCoreClient();
    const { data } = await supabase
      .from('organization_members')
      .select('user_id, role, created_at')
      .eq('organization_id', noliOrgId)
      .order('created_at', { ascending: true });
    const rows = (data as { user_id: string; role: string }[] | null) ?? [];
    const owner = rows.find((r) => r.role === 'owner') ?? rows[0];
    userId = owner?.user_id ?? null;
  } catch (err) {
    console.error('[crm ai_usage] resolveOwnerUserId failed', err);
  }
  ownerCache.set(noliOrgId, userId);
  return userId;
}

export async function logCrmAiUsage(args: {
  noliUserId?: string | null;
  noliOrgId?: string | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
  // Portion of tokensIn that was served from the provider's prompt cache (cache
  // reads). Billed at the cached-input rate, not the full input rate. Optional —
  // most CRM callers don't yet surface this; when omitted, all input is billed
  // at the full rate.
  cachedTokensIn?: number;
  feature?: string;
  byoKey?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    if (!process.env.NOLI_CORE_SUPABASE_URL || !process.env.NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY) return;
    if (!args.model) return;

    // Resolve { userId, orgId } from whichever context the caller has.
    let userId = args.noliUserId ?? null;
    let orgId = args.noliOrgId ?? null;
    if (userId && !orgId) {
      orgId = await findPrimaryOrgIdForUser(userId).catch(() => null);
    } else if (!userId && orgId) {
      userId = await resolveOwnerUserId(orgId);
    }
    if (!userId) return; // ai_usage.user_id is NOT NULL — skip if unresolved

    const rate = rateForModel(args.model);
    const tokensIn = Math.max(0, args.tokensIn || 0);
    const tokensOut = Math.max(0, args.tokensOut || 0);
    // Cache netting: cached input is billed at the cached rate, the rest at the
    // full input rate. Clamp cached to the total input so it can never go negative.
    const cachedIn = Math.min(tokensIn, Math.max(0, args.cachedTokensIn || 0));
    const freshIn = tokensIn - cachedIn;
    const costDollars =
      (freshIn / 1_000_000) * rate.in +
      (cachedIn / 1_000_000) * rate.cached +
      (tokensOut / 1_000_000) * rate.out;
    // Round provider cost UP to whole cents so we never under-bill.
    const costCents = Math.ceil(costDollars * 100);
    const creditsConsumed = Math.round((costCents / 100) * DISPLAY_TOKENS_PER_DOLLAR);

    const supabase = getNoliCoreClient();
    const { error } = await supabase.from('ai_usage').insert({
      user_id: userId,
      organization_id: orgId,
      app: 'crm',
      model: args.model,
      tokens_in: Math.max(0, Math.round(args.tokensIn || 0)),
      tokens_out: Math.max(0, Math.round(args.tokensOut || 0)),
      credits_consumed: creditsConsumed,
      cost_cents: costCents,
      byo_key: args.byoKey ?? false,
      metadata: { feature: args.feature ?? null, ...(args.metadata ?? {}) },
    });
    if (error) console.error('[crm ai_usage] insert failed', error);
  } catch (err) {
    console.error('[crm ai_usage] unexpected error', err);
  }
}
