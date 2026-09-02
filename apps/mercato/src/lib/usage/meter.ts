import 'server-only'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import {
  logCrmAiUsage,
  logCrmAiUsageStrict,
  type CrmAiUsageInput,
} from '@open-mercato/shared/lib/noli/ai-usage'
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
type CustomerAiMeterInput = Omit<CrmAiUsageInput, 'noliOrgId'>

export class CustomerAiMeteringError extends Error {
  constructor(
    public readonly code: 'metering_context_missing' | 'metering_identity_missing' | 'idempotency_key_missing' | 'metering_write_failed',
    message: string,
  ) {
    super(message)
    this.name = 'CustomerAiMeteringError'
  }
}

async function resolveNoliOrgId(auth: { orgId?: string | null } | null | undefined): Promise<string | null> {
  if (!auth?.orgId) return null
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const org = await em.findOne(Organization, { id: auth.orgId })
  return org?.noliOrgId ?? null
}

export async function meterCustomersAi(
  auth: { orgId?: string | null } | null | undefined,
  args: CustomerAiMeterInput,
): Promise<void> {
  try {
    if (!auth?.orgId || !args.model) return
    const noliOrgId = await resolveNoliOrgId(auth)
    if (!noliOrgId) return
    await logCrmAiUsage({
      noliUserId: args.noliUserId ?? null,
      noliOrgId,
      model: args.model,
      tokensIn: Math.max(0, args.tokensIn || 0),
      tokensOut: Math.max(0, args.tokensOut || 0),
      feature: args.feature,
      byoKey: args.byoKey ?? false,
      idempotencyKey: args.idempotencyKey ?? null,
      metadata: args.metadata,
    })
  } catch {
    /* metering must never break the feature */
  }
}

/**
 * GTM uses this strict boundary: every model operation has a stable operation
 * key, a linked Noli organization, and an awaited canonical receipt. Any
 * failure prevents the route from returning customer-visible model output.
 */
export async function meterCustomersAiStrict(
  auth: { orgId?: string | null } | null | undefined,
  args: CustomerAiMeterInput,
): Promise<void> {
  if (!auth?.orgId || !args.model?.trim()) {
    throw new CustomerAiMeteringError('metering_context_missing', 'AI metering context is incomplete')
  }
  if (!args.idempotencyKey?.trim()) {
    throw new CustomerAiMeteringError('idempotency_key_missing', 'AI metering requires an operation key')
  }
  const noliOrgId = await resolveNoliOrgId(auth)
  if (!noliOrgId) {
    throw new CustomerAiMeteringError('metering_identity_missing', 'The CRM organization is not linked to Noli Core')
  }
  try {
    await logCrmAiUsageStrict({
      noliUserId: args.noliUserId ?? null,
      noliOrgId,
      model: args.model,
      tokensIn: Math.max(0, args.tokensIn || 0),
      tokensOut: Math.max(0, args.tokensOut || 0),
      feature: args.feature,
      byoKey: args.byoKey ?? false,
      idempotencyKey: args.idempotencyKey,
      metadata: args.metadata,
    })
  } catch (error) {
    throw new CustomerAiMeteringError(
      'metering_write_failed',
      error instanceof Error ? error.message : 'AI usage receipt failed',
    )
  }
}
