import 'server-only'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import { getNoliCoreClient, resolveOrgByoKeys, type ByoProvider } from '@open-mercato/shared/lib/noli/core-client'
import type { EntityManager } from '@mikro-orm/postgresql'

/*
 * P-3 allowance gate for the CRM customer-facing AI suite, with unified BYOK
 * fall-through. Resolves the noli org from the Mercato org and checks the pooled
 * credit allowance ($40/user first two seats + $30/user extra). Within the pool
 * → allowed (platform key). Over the pool:
 *   - org has a BYO key for this feature's provider → allowed, `byoApiKey` set
 *     (use it for the call + meter byoKey: true).
 *   - no key → blocked with the pause-and-prompt message.
 * Most CRM AI runs on Gemini, so `provider` defaults to 'google'. FAIL-OPEN.
 *
 *   const gate = await checkCustomersAiAllowance(auth)
 *   if (!gate.allowed) return NextResponse.json({ error: gate.message }, { status: 402 })
 *   const apiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY
 *   // ...call the provider with apiKey...
 *   void meterCustomersAi(auth, { ..., byoKey: !!gate.byoApiKey })
 */
const FIRST_TWO_SEAT_CENTS = 4000
const EXTRA_SEAT_CENTS = 3000
const CREDITS_PER_CENT = 2500
const TOKENS_PER_BOOST = 10_000_000 // each purchased token-boost add-on (P-9)

export const ALLOWANCE_BLOCK_MESSAGE =
  "You've used your team's monthly AI allowance. Add your own provider API key or upgrade your plan to keep using AI."

export type AllowanceResult = { allowed: boolean; message?: string; byoApiKey?: string }

export async function checkCustomersAiAllowance(
  auth: { orgId?: string | null } | null | undefined,
  provider: ByoProvider = 'google',
): Promise<AllowanceResult> {
  try {
    if (!auth?.orgId) return { allowed: true }
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const org = await em.findOne(Organization, { id: auth.orgId })
    if (!org?.noliOrgId) return { allowed: true } // not linked to noli-core
    const supabase = getNoliCoreClient()

    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
    const [{ data: members }, { data: usage }, { data: subs }] = await Promise.all([
      supabase.from('organization_members').select('user_id').eq('organization_id', org.noliOrgId),
      supabase
        .from('ai_usage')
        .select('credits_consumed')
        .eq('organization_id', org.noliOrgId)
        .eq('byo_key', false)
        .gte('ts', monthStart),
      supabase
        .from('subscriptions')
        .select('seats, token_boosts, status')
        .eq('organization_id', org.noliOrgId),
    ])
    // Paid seats (base + purchased overflow) drive allowance, matching the hub —
    // a Team with unfilled seats still gets its full pooled budget. Fall back to
    // the member count for legacy/unsubscribed orgs.
    const sub = (((subs as { seats: number | null; token_boosts: number | null; status: string | null }[]) ?? [])
      .find((s) => s.status === 'active' || s.status === 'trialing'))
    const memberSeats = Math.max(1, ((members as unknown[]) ?? []).length)
    const seats = sub?.seats && sub.seats > 0 ? sub.seats : memberSeats
    const tokenBoosts = sub?.token_boosts ?? 0
    const used = (((usage as { credits_consumed: number | null }[]) ?? []).reduce(
      (sum, r) => sum + (r.credits_consumed ?? 0),
      0,
    ))
    // Admin allowance override (comps / support bumps) — sum non-expired
    // user_cap_overrides across the org's members. Mirrors the hub's
    // getOrgAdminOverrideCredits so an override set in the admin dashboard
    // applies to CRM too (CRM inlines its own allowance math).
    const memberIds = ((members as { user_id: string }[]) ?? []).map((m) => m.user_id)
    let overrideCredits = 0
    if (memberIds.length) {
      const { data: ov } = await supabase
        .from('user_cap_overrides')
        .select('monthly_credits, expires_at')
        .in('user_id', memberIds)
      const nowIso = now.toISOString()
      overrideCredits = ((ov as { monthly_credits: number | null; expires_at: string | null }[]) ?? []).reduce(
        (s, r) => (r.expires_at && r.expires_at < nowIso ? s : s + Math.max(0, r.monthly_credits ?? 0)),
        0,
      )
    }
    const allowanceCents =
      Math.min(2, seats) * FIRST_TWO_SEAT_CENTS + Math.max(0, seats - 2) * EXTRA_SEAT_CENTS
    const allowanceCredits = allowanceCents * CREDITS_PER_CENT + tokenBoosts * TOKENS_PER_BOOST + overrideCredits
    if (allowanceCredits > 0 && used >= allowanceCredits) {
      // Over allowance: fall through to the org's own key for this provider.
      const keys = await resolveOrgByoKeys(org.noliOrgId)
      const byoApiKey = keys[provider]
      if (byoApiKey) return { allowed: true, byoApiKey }
      return { allowed: false, message: ALLOWANCE_BLOCK_MESSAGE }
    }
    return { allowed: true }
  } catch {
    return { allowed: true }
  }
}
