import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CampaignEm, GtmCtx } from '../lib/campaign/build'
import { NoliCoreOperatorReconciler, getLedger } from '../lib/credits/noli-core-ledger'
import {
  reconcileProviderOperation,
  repairResolvedResearchRunSummaries,
  replayParkedProviderOutput,
  replayPendingSettlements,
  type GtmOperatorReconciliationDecision,
  type GtmOperatorReconciliationEvidence,
  type GtmOperatorReconciliationResult,
  type GtmResearchRunSummaryRepairResult,
  type ReplayParkedOutputResult,
  type ReplayPendingSettlementsResult,
} from '../lib/reconciliation/operator'

export type ReconcileProviderOperationCommandInput = {
  canonicalIdentity: {
    organizationId: string
    userId: string
  }
  operationId: string
  idempotencyKey: string
  decision: GtmOperatorReconciliationDecision
  evidence: GtmOperatorReconciliationEvidence
}

export type RepairResearchRunSummariesCommandInput = {
  runIds: string[]
}

export type ReplaySettlementsCommandInput = {
  limit?: number
}

export type ReplayParkedOutputCommandInput = {
  operationId: string
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

const reconcileCommand: CommandHandler<
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

const repairRunSummariesCommand: CommandHandler<
  RepairResearchRunSummariesCommandInput,
  GtmResearchRunSummaryRepairResult
> = {
  id: 'gtm.provider-operations.repair-run-summaries',
  async execute(input, runtime) {
    const em = runtime.container.resolve('em') as EntityManager as unknown as CampaignEm
    return repairResolvedResearchRunSummaries(em, resolveGtmContext(runtime), input.runIds)
  },
  buildLog: ({ result, ctx }) => ({
    actionLabel: 'Repair resolved GTM research-run reconciliation summaries',
    resourceKind: 'gtm.research_run_summary',
    organizationId: ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null,
    tenantId: ctx.auth?.tenantId ?? null,
    snapshotAfter: {
      requested_run_ids: result.requestedRunIds,
      repaired_run_ids: result.repairedRunIds,
      unchanged_run_ids: result.unchangedRunIds,
    },
  }),
}

// Re-issues execution-time settlement decisions that never reached Noli Core
// (receipt.gtm_observation.settlement_pending). Same operation ids, no
// provider contact, bounded per call.
const replaySettlementsCommand: CommandHandler<
  ReplaySettlementsCommandInput,
  ReplayPendingSettlementsResult
> = {
  id: 'gtm.reconciliation.replay-settlements',
  async execute(input, runtime) {
    const em = runtime.container.resolve('em') as EntityManager as unknown as CampaignEm
    const ctx = resolveGtmContext(runtime)
    return replayPendingSettlements(em, getLedger(), ctx, { limit: input?.limit })
  },
  buildLog: ({ result, ctx }) => ({
    actionLabel: 'Replay pending GTM provider settlements',
    resourceKind: 'gtm.provider_operation',
    organizationId: ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null,
    tenantId: ctx.auth?.tenantId ?? null,
    snapshotAfter: {
      scanned: result.scanned,
      settled: result.settled.map((row) => row.operationId),
      failed: result.failed.map((row) => row.operationId),
      skipped: result.skipped.map((row) => row.operationId),
    },
  }),
}

// Materializes provider rows retained in a settled operation's receipt.
const replayParkedOutputCommand: CommandHandler<
  ReplayParkedOutputCommandInput,
  ReplayParkedOutputResult
> = {
  id: 'gtm.reconciliation.replay-parked-output',
  async execute(input, runtime) {
    const em = runtime.container.resolve('em') as EntityManager as unknown as CampaignEm
    return replayParkedProviderOutput({ em, ctx: resolveGtmContext(runtime), operationId: input.operationId })
  },
  buildLog: ({ result, ctx }) => ({
    actionLabel: 'Replay parked GTM provider output',
    resourceKind: 'gtm.provider_operation',
    resourceId: result.operationId,
    organizationId: ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null,
    tenantId: ctx.auth?.tenantId ?? null,
    snapshotAfter: {
      idempotent: result.idempotent,
      rows_replayed: result.rowsReplayed,
      candidates_inserted: result.candidatesInserted,
      candidate_matches_created: result.candidateMatchesCreated,
    },
  }),
}

registerCommand(reconcileCommand)
registerCommand(repairRunSummariesCommand)
registerCommand(replaySettlementsCommand)
registerCommand(replayParkedOutputCommand)
