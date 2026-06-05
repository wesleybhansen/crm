import 'server-only'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import { logCrmAiUsage } from '@open-mercato/shared/lib/noli/ai-usage'
import type { EntityManager } from '@mikro-orm/postgresql'

/*
 * Cross-product metering for the CRM customer-facing AI suite (apps/mercato
 * customers/landing_pages/sequences AI). Each feature does its own raw provider
 * fetch and has a Mercato `auth` (orgId). This resolves the noli org from the
 * Mercato org (Organization.noliOrgId) and logs to noli-core ai_usage so the
 * usage counts toward the customer's pooled allowance + P-3 capping.
 *
 * Fire-and-forget; never throws into the feature. Drop-in one-liner:
 *   void meterCustomersAi(auth, { model, tokensIn, tokensOut, feature: 'scan-website' })
 */
export async function meterCustomersAi(
  auth: { orgId?: string | null } | null | undefined,
  args: { model: string; tokensIn: number; tokensOut: number; feature: string },
): Promise<void> {
  try {
    if (!auth?.orgId || !args.model) return
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const org = await em.findOne(Organization, { id: auth.orgId })
    if (!org?.noliOrgId) return
    await logCrmAiUsage({
      noliOrgId: org.noliOrgId,
      model: args.model,
      tokensIn: Math.max(0, args.tokensIn || 0),
      tokensOut: Math.max(0, args.tokensOut || 0),
      feature: args.feature,
    })
  } catch {
    /* metering must never break the feature */
  }
}
