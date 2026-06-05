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

// USD per 1M tokens. Prefix-matched (longest match wins). Keep in sync with the
// noli-platform MODEL_PRICING table.
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-opus-4-8': { in: 15, out: 75 },
  'claude-opus': { in: 15, out: 75 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet': { in: 3, out: 15 },
  'claude-haiku-4-5-20251001': { in: 0.8, out: 4 },
  'claude-haiku': { in: 0.8, out: 4 },
  'gpt-5.5': { in: 5, out: 15 },
  'gpt-5-mini': { in: 0.25, out: 2 },
  'gpt-5-nano': { in: 0.05, out: 0.4 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gemini-3.5-flash': { in: 0.1, out: 0.4 },
  'gemini-2.5-flash': { in: 0.15, out: 0.6 },
  'gemini-2.5-pro': { in: 1.25, out: 10 },
  'gemini': { in: 0.15, out: 0.6 },
};

// Conservative fallback (round up so we never under-count an unknown model).
const FALLBACK_RATE = { in: 5, out: 15 };

// Customer-facing display tokens: $40 of provider cost = 10,000,000 tokens
// (250,000 per $1). Derived from full-precision cost so cheap calls accumulate.
const DISPLAY_TOKENS_PER_DOLLAR = 250_000;

function rateForModel(model: string): { in: number; out: number } {
  const m = (model || '').toLowerCase().trim();
  let best: { key: string; rate: { in: number; out: number } } | null = null;
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
    const costDollars =
      (Math.max(0, args.tokensIn || 0) / 1_000_000) * rate.in +
      (Math.max(0, args.tokensOut || 0) / 1_000_000) * rate.out;
    const costCents = Math.round(costDollars * 100);
    const creditsConsumed = Math.round(costDollars * DISPLAY_TOKENS_PER_DOLLAR);

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
