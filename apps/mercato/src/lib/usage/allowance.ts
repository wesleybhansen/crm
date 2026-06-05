import 'server-only'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import { getNoliCoreClient } from '@open-mercato/shared/lib/noli/core-client'
import type { EntityManager } from '@mikro-orm/postgresql'

/*
 * P-3 allowance gate for the CRM customer-facing AI suite. Resolves the noli org
 * from the Mercato org and checks the pooled credit allowance ($40/user first
 * two seats + $30/user extra, enforced on precise credits). Over the pool →
 * blocked with the pause-and-prompt message. FAIL-OPEN. Call BEFORE the AI fetch:
 *   const gate = await checkCustomersAiAllowance(auth)
 *   if (!gate.allowed) return NextResponse.json({ error: gate.message }, { status: 402 })
 */
const FIRST_TWO_SEAT_CENTS = 4000
const EXTRA_SEAT_CENTS = 3000
const CREDITS_PER_CENT = 2500

export const ALLOWANCE_BLOCK_MESSAGE =
  "You've used your team's monthly AI allowance. Add your own provider API key or upgrade your plan to keep using AI."

export async function checkCustomersAiAllowance(
  auth: { orgId?: string | null } | null | undefined,
): Promise<{ allowed: boolean; message?: string }> {
  try {
    if (!auth?.orgId) return { allowed: true }
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const org = await em.findOne(Organization, { id: auth.orgId })
    if (!org?.noliOrgId) return { allowed: true } // not linked to noli-core
    const supabase = getNoliCoreClient()

    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
    const [{ data: members }, { data: usage }] = await Promise.all([
      supabase.from('organization_members').select('user_id').eq('organization_id', org.noliOrgId),
      supabase
        .from('ai_usage')
        .select('credits_consumed')
        .eq('organization_id', org.noliOrgId)
        .eq('byo_key', false)
        .gte('ts', monthStart),
    ])
    const seats = Math.max(1, ((members as unknown[]) ?? []).length)
    const used = (((usage as { credits_consumed: number | null }[]) ?? []).reduce(
      (sum, r) => sum + (r.credits_consumed ?? 0),
      0,
    ))
    const allowanceCents =
      Math.min(2, seats) * FIRST_TWO_SEAT_CENTS + Math.max(0, seats - 2) * EXTRA_SEAT_CENTS
    const allowanceCredits = allowanceCents * CREDITS_PER_CENT
    if (allowanceCredits > 0 && used >= allowanceCredits) {
      return { allowed: false, message: ALLOWANCE_BLOCK_MESSAGE }
    }
    return { allowed: true }
  } catch {
    return { allowed: true }
  }
}
