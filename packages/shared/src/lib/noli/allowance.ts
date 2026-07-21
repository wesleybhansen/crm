import 'server-only';
import { getNoliCoreClient, resolveOrgByoKeys, type ByoProvider } from './core-client';
import {
  LIVE_NOLI_SUBSCRIPTION_STATUSES,
  resolveAllowanceBillingPeriod,
  type NoliBillingSubscription,
} from './billing-period';

/*
 * Shared P-3 allowance gate keyed by noli org id (NOT the Mercato auth). This is
 * the package-importable twin of apps/mercato/src/lib/usage/allowance.ts, for
 * the GAP-4 background/worker + cross-package paths (inbox_ops, attachments OCR,
 * ai-assistant routing) that already resolve `Organization.noliOrgId` to meter
 * but had no gate and no BYOK fall-through.
 *
 * Same pooled math as the app gate ($40/seat = 10M tokens, admin overrides +
 * token-boosts, FAIL-OPEN). Over the pool, returns the org's BYO key for the
 * provider if present, else `{ allowed: false }`.
 *
 * Usage (worker / background — skip over-allowance, never 402):
 *   const gate = await checkOrgAiAllowance(noliOrgId, 'openai')
 *   if (!gate.allowed) return                 // over allowance, no BYO key → skip
 *   const apiKey = gate.byoApiKey || envKey   // thread BYO key when present
 *   ...run, then meter with byoKey: !!gate.byoApiKey
 */

const SEAT_CENTS = 4000; // uniform 10M tokens / seat (2026-06-09 pricing)
const CREDITS_PER_CENT = 2500;
const TOKENS_PER_BOOST = 10_000_000;

export type OrgAllowanceResult = { allowed: boolean; byoApiKey?: string };

export async function checkOrgAiAllowance(
  noliOrgId: string | null | undefined,
  provider: ByoProvider = 'google',
): Promise<OrgAllowanceResult> {
  try {
    if (!noliOrgId) return { allowed: true }; // not linked to noli-core → don't block
    if (!process.env.NOLI_CORE_SUPABASE_URL || !process.env.NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY) {
      return { allowed: true };
    }
    const supabase = getNoliCoreClient();

    const now = new Date();
    const [{ data: members }, { data: subs }] = await Promise.all([
      supabase.from('organization_members').select('user_id').eq('organization_id', noliOrgId),
      supabase
        .from('subscriptions')
        .select('id, seats, token_boosts, status, current_period_start, updated_at')
        .eq('organization_id', noliOrgId)
        .in('status', [...LIVE_NOLI_SUBSCRIPTION_STATUSES]),
    ]);

    type AllowanceSubscription = NoliBillingSubscription & {
      seats: number | null;
      token_boosts: number | null;
    };
    const { subscription: sub, periodStart } = resolveAllowanceBillingPeriod(
      (subs as AllowanceSubscription[] | null) ?? [],
      now,
    );
    const { data: usage } = await supabase
      .from('ai_usage')
      .select('credits_consumed')
      .eq('organization_id', noliOrgId)
      .eq('byo_key', false)
      .gte('ts', periodStart.toISOString());
    const memberSeats = Math.max(1, ((members as unknown[]) ?? []).length);
    const seats = sub?.seats && sub.seats > 0 ? sub.seats : memberSeats;
    const tokenBoosts = sub?.token_boosts ?? 0;
    const used = (((usage as { credits_consumed: number | null }[]) ?? []).reduce(
      (sum, r) => sum + (r.credits_consumed ?? 0),
      0,
    ));

    const memberIds = ((members as { user_id: string }[]) ?? []).map((m) => m.user_id);
    let overrideCredits = 0;
    if (memberIds.length) {
      const { data: ov } = await supabase
        .from('user_cap_overrides')
        .select('monthly_credits, expires_at')
        .in('user_id', memberIds);
      const nowIso = now.toISOString();
      overrideCredits = ((ov as { monthly_credits: number | null; expires_at: string | null }[]) ?? []).reduce(
        (s, r) => (r.expires_at && r.expires_at < nowIso ? s : s + Math.max(0, r.monthly_credits ?? 0)),
        0,
      );
    }

    const allowanceCents = seats * SEAT_CENTS;
    const allowanceCredits = allowanceCents * CREDITS_PER_CENT + tokenBoosts * TOKENS_PER_BOOST + overrideCredits;
    if (allowanceCredits > 0 && used >= allowanceCredits) {
      const keys = await resolveOrgByoKeys(noliOrgId);
      const byoApiKey = keys[provider];
      if (byoApiKey) return { allowed: true, byoApiKey };
      return { allowed: false };
    }
    return { allowed: true };
  } catch {
    return { allowed: true }; // FAIL-OPEN
  }
}
