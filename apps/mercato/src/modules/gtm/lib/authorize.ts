export type GtmFeature = 'gtm.view' | 'gtm.edit' | 'gtm.approve' | 'gtm.launch'

export type GtmFeatureContext = {
  userId: string
  tenantId: string
  organizationId: string
}

type GtmRbacService = {
  userHasAllFeatures(
    userId: string,
    features: string[],
    scope: { tenantId: string | null; organizationId: string | null },
  ): Promise<boolean>
}

type GtmContainer = {
  resolve(name: string): unknown
}

const CAMPAIGN_READ_OPS = new Set(['list', 'draft-state', 'status'])

export function campaignFeatureForOp(op: string): GtmFeature {
  if (op === 'approve') return 'gtm.approve'
  return CAMPAIGN_READ_OPS.has(op) ? 'gtm.view' : 'gtm.edit'
}

export function executionFeatureForOp(op: string): GtmFeature {
  return op === 'status' || op === 'cursor-status' ? 'gtm.view' : 'gtm.launch'
}

export function reconciliationFeatureForOp(op: string): GtmFeature {
  return op === 'list' || op === 'history' || op === 'ai-telemetry'
    ? 'gtm.view'
    : 'gtm.approve'
}

/** Server-side RBAC for shared-secret GTM routes. The service secret proves
 * the caller is Noli, not what the represented human may view, edit, approve,
 * or launch.
 * Dependency or shape ambiguity fails closed. */
export async function hasGtmFeature(
  container: GtmContainer,
  ctx: GtmFeatureContext,
  feature: GtmFeature,
): Promise<boolean> {
  try {
    const rbac = container.resolve('rbacService') as GtmRbacService | null
    if (!rbac || typeof rbac.userHasAllFeatures !== 'function') return false
    return await rbac.userHasAllFeatures(ctx.userId, [feature], {
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
    })
  } catch {
    return false
  }
}
