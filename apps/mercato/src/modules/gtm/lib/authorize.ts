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

const CAMPAIGN_READ_OPS = new Set(['list', 'analytics', 'draft-state', 'list-senders', 'status'])
const CANDIDATE_READ_OPS = new Set(['list', 'detail'])
const CHAT_READ_OPS = new Set(['thread-list', 'messages'])
const ENRICHMENT_READ_OPS = new Set(['plan', 'status'])
const DECISION_MAKER_READ_OPS = new Set(['plan', 'status'])
const INBOX_READ_OPS = new Set(['list', 'thread'])
const HANDOFF_READ_OPS = new Set(['assets-list', 'asset-status'])
const RESEARCH_READ_OPS = new Set(['list', 'plan', 'status'])
const STRATEGY_READ_OPS = new Set(['icp-list', 'icp-get', 'voice-list', 'voice-get'])
const TASK_READ_OPS = new Set(['list', 'timeline'])

export function campaignFeatureForOp(op: string): GtmFeature {
  if (op === 'approve') return 'gtm.approve'
  return CAMPAIGN_READ_OPS.has(op) ? 'gtm.view' : 'gtm.edit'
}

export function executionFeatureForOp(op: string): GtmFeature {
  return op === 'status' || op === 'cursor-status' ? 'gtm.view' : 'gtm.launch'
}

export function reconciliationFeatureForOp(op: string): GtmFeature {
  return op === 'list'
    || op === 'history'
    || op === 'catalog'
    || op === 'ai-telemetry'
    || op === 'opportunity-quality'
    ? 'gtm.view'
    : 'gtm.approve'
}

export function candidateFeatureForOp(op: string): GtmFeature {
  return CANDIDATE_READ_OPS.has(op) ? 'gtm.view' : 'gtm.edit'
}

export function chatFeatureForOp(op: string): GtmFeature {
  return CHAT_READ_OPS.has(op) ? 'gtm.view' : 'gtm.edit'
}

export function enrichmentFeatureForOp(op: string): GtmFeature {
  return ENRICHMENT_READ_OPS.has(op) ? 'gtm.view' : 'gtm.launch'
}

export function decisionMakerFeatureForOp(op: string): GtmFeature {
  return DECISION_MAKER_READ_OPS.has(op) ? 'gtm.view' : 'gtm.launch'
}

export function inboxFeatureForOp(op: string): GtmFeature {
  if (INBOX_READ_OPS.has(op)) return 'gtm.view'
  return op === 'approve-draft' ? 'gtm.launch' : 'gtm.edit'
}

export function handoffFeatureForOp(op: string): GtmFeature {
  if (HANDOFF_READ_OPS.has(op)) return 'gtm.view'
  return op === 'asset-request' ? 'gtm.approve' : 'gtm.edit'
}

export function researchFeatureForOp(op: string): GtmFeature {
  if (RESEARCH_READ_OPS.has(op)) return 'gtm.view'
  return op === 'execute' || op === 'retention-sweep' ? 'gtm.launch' : 'gtm.edit'
}

export function autoRefillFeatureForOp(op: string): GtmFeature {
  return op === 'plan' || op === 'status' ? 'gtm.view' : 'gtm.launch'
}

export function strategyFeatureForOp(op: string): GtmFeature {
  return STRATEGY_READ_OPS.has(op) ? 'gtm.view' : 'gtm.edit'
}

export function taskFeatureForOp(op: string): GtmFeature {
  if (TASK_READ_OPS.has(op)) return 'gtm.view'
  return op === 'override-dependency' ? 'gtm.launch' : 'gtm.edit'
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
