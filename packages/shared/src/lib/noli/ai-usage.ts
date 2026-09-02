import { createHash } from 'node:crypto';
/* Keep Next's client-bundle guard, but tolerate plain Node.
 *
 * `server-only` resolves to a module that throws unconditionally unless the
 * `react-server` export condition is active. Next sets that condition; a plain
 * Node process never does. This package is consumed by both, so a bare
 * `import 'server-only'` is a false positive outside Next -- it took down the
 * MCP server, which runs as a CLI process and only ever reached this module
 * through a dynamic import.
 *
 * Same try/catch idiom already used in lib/di/container.ts and
 * lib/i18n/server.ts, for the same reason. */
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('server-only');
} catch {
  // noop: allows CLI processes to use this module outside Next.
}
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
  'claude-fable-5': { in: 10, out: 50, cached: 1.0 },
  // OpenAI
  'gpt-5.6-sol': { in: 5, out: 30, cached: 0.5 },
  'gpt-5.6-terra': { in: 2.5, out: 15, cached: 0.25 },
  'gpt-5.6-luna': { in: 1, out: 6, cached: 0.1 },
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
  'text-embedding-3-large': { in: 0.13, out: 0, cached: 0.13 },
  'text-embedding-3-small': { in: 0.02, out: 0, cached: 0.02 },
  'text-embedding': { in: 0.1, out: 0, cached: 0.1 },
  // Text-to-speech is priced per CHARACTER, not per token: tts-1 = $15 / 1M
  // chars, tts-1-hd = $30 / 1M chars. Callers pass the input character count as
  // `tokensIn` (tokensOut = 0) so cost = (chars / 1M) * rate.in lands exactly.
  'tts-1-hd': { in: 30, out: 0, cached: 30 },
  'tts-1': { in: 15, out: 0, cached: 15 },
  // Google
  'gemini-3.5-flash': { in: 1.5, out: 9, cached: 0.15 },
  'gemini-3-flash': { in: 0.5, out: 3, cached: 0.05 },
  'gemini-3-pro': { in: 2, out: 12, cached: 0.2 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5, cached: 0.03 },
  'gemini-2.5-pro': { in: 1.25, out: 10, cached: 0.125 },
  'gemini': { in: 0.3, out: 2.5, cached: 0.03 }, // generic Gemini fallback (2.5-flash class)
  // xAI (Grok — OpenAI-compatible). Longer prefix precedes the generic.
  'grok-4.5': { in: 2, out: 6, cached: 0.5 },
  'grok': { in: 2, out: 6, cached: 0.5 },
};

// Conservative fallback (round up so we never under-count an unknown model).
const FALLBACK_RATE = { in: 5, out: 15, cached: 0.5 };

// Customer-facing display tokens (credits) peg: 250,000 credits per $1 of
// provider cost. Canonical formula: credits = round(costDollars * 250000).
const DISPLAY_TOKENS_PER_DOLLAR = 250_000;

// Catalog price overlay — the admin-managed noli-core model_catalog is the
// source of truth; overlay it onto the local PRICING (fallback), cached ~60s. So
// a price edited in the admin Models page takes effect in CRM billing in ~a minute.
type Rate = { in: number; out: number; cached: number };
let catalogRates: Record<string, Rate> | null = null;
let catalogAt = 0;
async function refreshCatalog(): Promise<void> {
  if (catalogRates && Date.now() - catalogAt < 60_000) return;
  try {
    const supabase = getNoliCoreClient();
    const { data, error } = await supabase
      .from('model_catalog')
      .select('model_id, in_per_m, out_per_m, cached_in_per_m, enabled')
      .eq('enabled', true);
    if (error || !data?.length) return;
    const map: Record<string, Rate> = {};
    for (const r of data as Array<Record<string, unknown>>) {
      const id = String(r.model_id ?? '').toLowerCase();
      const inRate = Number(r.in_per_m);
      // Skip zero/blank/negative-priced rows (would bill $0 = unmetered). They
      // fall through to the static PRICING via the merge below.
      if (!id || !(inRate > 0)) continue;
      map[id] = { in: inRate, out: Number(r.out_per_m), cached: r.cached_in_per_m != null ? Number(r.cached_in_per_m) : inRate };
    }
    catalogRates = map;
    catalogAt = Date.now();
  } catch {
    /* keep fallback */
  }
}

function matchRate(table: Record<string, { in: number; out: number; cached: number }>, m: string): { in: number; out: number; cached: number } | null {
  let best: { key: string; rate: { in: number; out: number; cached: number } } | null = null;
  for (const [key, rate] of Object.entries(table)) {
    if (m.startsWith(key) && (!best || key.length > best.key.length)) best = { key, rate };
  }
  return best?.rate ?? null;
}

function rateForModel(model: string): { in: number; out: number; cached: number } {
  const m = (model || '').toLowerCase().trim();
  // MERGE: catalog overlay first, then the static PRICING, then FALLBACK — so a
  // model missing/disabled/zero-priced in the catalog keeps its correct static
  // rate instead of jumping to the flat fallback.
  return (catalogRates && matchRate(catalogRates, m)) || matchRate(PRICING, m) || FALLBACK_RATE;
}

const OWNER_NEGATIVE_CACHE_TTL_MS = 30_000;
type OwnerCacheEntry = { userId: string | null; retryAt: number | null };
const ownerCache = new Map<string, OwnerCacheEntry>();

async function resolveOwnerUserId(noliOrgId: string): Promise<string | null> {
  const cached = ownerCache.get(noliOrgId);
  if (cached?.userId) return cached.userId;
  if (cached?.retryAt && cached.retryAt > Date.now()) return null;
  if (cached) ownerCache.delete(noliOrgId);

  try {
    const supabase = getNoliCoreClient();
    const { data, error } = await supabase
      .from('organization_members')
      .select('user_id, role, created_at')
      .eq('organization_id', noliOrgId)
      .order('created_at', { ascending: true });
    if (error) return null;

    const rows = (data as { user_id: string; role: string }[] | null) ?? [];
    const owner = rows.find((r) => r.role === 'owner') ?? rows[0];
    const userId = owner?.user_id ?? null;
    ownerCache.set(noliOrgId, {
      userId,
      retryAt: userId ? null : Date.now() + OWNER_NEGATIVE_CACHE_TTL_MS,
    });
    return userId;
  } catch (err) {
    console.error('[crm ai_usage] resolveOwnerUserId failed', err);
    return null;
  }
}

export type CrmAiUsageInput = {
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
  // Optional insert-once key for retryable product operations. Callers must
  // bind this to the exact feature operation, not merely a user or feature.
  idempotencyKey?: string | null;
};

export class CrmAiUsageMeteringError extends Error {
  constructor(
    public readonly code:
      | 'metering_unconfigured'
      | 'invalid_metering_input'
      | 'metering_identity_unresolved'
      | 'metering_write_failed',
    message: string,
  ) {
    super(message);
    this.name = 'CrmAiUsageMeteringError';
  }
}

async function writeCrmAiUsage(args: CrmAiUsageInput): Promise<void> {
  if (!process.env.NOLI_CORE_SUPABASE_URL || !process.env.NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY) {
    throw new CrmAiUsageMeteringError('metering_unconfigured', 'Noli Core AI metering is not configured');
  }
  if (!args.model?.trim()) {
    throw new CrmAiUsageMeteringError('invalid_metering_input', 'AI metering requires a model identifier');
  }

  // Resolve { userId, orgId } from whichever context the caller has.
  let userId = args.noliUserId ?? null;
  let orgId = args.noliOrgId ?? null;
  if (userId && !orgId) {
    orgId = await findPrimaryOrgIdForUser(userId).catch(() => null);
  } else if (!userId && orgId) {
    userId = await resolveOwnerUserId(orgId);
  }
  if (!userId) {
    throw new CrmAiUsageMeteringError(
      'metering_identity_unresolved',
      'AI metering could not resolve a Noli user for the organization',
    );
  }

  await refreshCatalog();
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
  const creditsConsumed = Math.round(costDollars * DISPLAY_TOKENS_PER_DOLLAR);

  const supabase = getNoliCoreClient();
  const normalizedKey = args.idempotencyKey?.trim() || null;
  const receiptId = normalizedKey
      ? (() => {
          const digest = createHash('sha256')
            .update(
              `noli:crm-ai-usage:v2\0${userId}\0${orgId ?? ''}\0${normalizedKey}`,
            )
            .digest('hex')
            .slice(0, 32)
            .split('');
          digest[12] = '5';
          digest[16] = ((Number.parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
          const value = digest.join('');
          return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
        })()
      : null;
  const row = {
      ...(receiptId ? { id: receiptId } : {}),
      user_id: userId,
      organization_id: orgId,
      app: 'crm',
      model: args.model,
      tokens_in: Math.max(0, Math.round(args.tokensIn || 0)),
      tokens_out: Math.max(0, Math.round(args.tokensOut || 0)),
      credits_consumed: creditsConsumed,
      cost_cents: costCents,
      byo_key: args.byoKey ?? false,
      metadata: {
        feature: args.feature ?? null,
        idempotency_key_present: Boolean(normalizedKey),
        ...(args.metadata ?? {}),
      },
  };
  const query = normalizedKey
    ? supabase.from('ai_usage').upsert(row, { onConflict: 'id', ignoreDuplicates: true })
    : supabase.from('ai_usage').insert(row);
  const { error } = await query;
  if (error) {
    throw new CrmAiUsageMeteringError(
      'metering_write_failed',
      'Noli Core rejected the AI usage receipt',
    );
  }
}

/**
 * Legacy CRM metering boundary. Existing non-GTM callers intentionally retain
 * best-effort behavior while they migrate to the strict contract.
 */
export async function logCrmAiUsage(args: CrmAiUsageInput): Promise<void> {
  try {
    await writeCrmAiUsage(args);
  } catch (err) {
    if (err instanceof CrmAiUsageMeteringError) {
      if (err.code === 'metering_write_failed') console.error('[crm ai_usage] insert failed', err);
      return;
    }
    console.error('[crm ai_usage] unexpected error', err);
  }
}

/**
 * Fail-closed metering for consequential customer-facing operations. The
 * caller must await this before returning model output to the customer.
 */
export async function logCrmAiUsageStrict(args: CrmAiUsageInput): Promise<void> {
  await writeCrmAiUsage(args);
}
