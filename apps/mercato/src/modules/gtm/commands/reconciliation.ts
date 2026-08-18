import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CampaignEm, GtmCtx } from '../lib/campaign/build'
import { NoliCoreOperatorReconciler } from '../lib/credits/noli-core-ledger'
import {
  reconcileProviderOperation,
  type GtmOperatorReconciliationDecision,
  type GtmOperatorReconciliationEvidence,
  type GtmOperatorReconciliationResult,
} from '../lib/reconciliation/operator'

export type ReconcileProviderOperationCommandInput = {
  operationId: string
  idempotencyKey: string
  decision: GtmOperatorReconciliationDecision
  evidence: GtmOperatorReconciliationEvidence
}

function resolveGtmContext(ctx: CommandRuntimeContext): GtmCtx {
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  const tenantId = ctx.auth?.tenantId ?? null
  const userId = ctx.auth?.userId ?? ctx.auth?.sub ?? null
  if (!organizationId || !tenantId || !userId) {
    throw new Error('GTM reconciliation requires an exact user, organization, and tenant scope')
  }
  return {
    organizationId,
    tenantId,
    userId,
    requestId: ctx.request?.headers.get('x-request-id') ?? null,
  }
}

const command: CommandHandler<
  ReconcileProviderOperationCommandInput,
  GtmOperatorReconciliationResult
> = {
  id: 'gtm.provider-operations.reconcile',
  async execute(input, runtime) {
    const em = runtime.container.resolve('em') as EntityManager as unknown as CampaignEm
    return reconcileProviderOperation({
      em,
      canonicalReconciler: new NoliCoreOperatorReconciler(),
      ctx: resolveGtmContext(runtime),
      ...input,
    })
  },
  buildLog: ({ input, result }) => ({
    actionLabel: 'Reconcile canonical GTM provider operation',
    resourceKind: 'gtm.provider_operation',
    resourceId: result.operation.id,
    organizationId: result.operation.organizationId,
    tenantId: result.operation.tenantId,
    snapshotAfter: {
      canonical_status: result.canonicalStatus,
      decision: input.decision.outcome,
      idempotency_key: input.idempotencyKey,
      idempotent: result.idempotent,
    },
  }),
}

registerCommand(command)
