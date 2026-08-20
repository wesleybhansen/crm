import {
  GtmProviderOperation,
  GtmProviderReconciliationAction,
} from '../../data/entities'
import type { CampaignEm, GtmCtx } from '../campaign/build'
import { classifyProviderOperationStatus } from '../reconciliation/operator'

export type ProviderHistoryRow = {
  provider: string
  kind: string
  operations: number
  reserved: number
  started: number
  ambiguous: number
  settled: number
  unknown: number
  reconciliationActions: number
  pendingActions: number
  rejectedActions: number
  distinctResearchRuns: number
  distinctCandidates: number
  lastRequestedAt: Date | null
  lastSettledAt: Date | null
}

export const PROVIDER_HISTORY_OPERATION_CAP = 2_000
export const PROVIDER_HISTORY_ACTION_CAP = 5_000

function maxDate(left: Date | null, right: Date | null | undefined): Date | null {
  if (!right) return left
  return !left || right > left ? right : left
}

export async function getProviderHistoryDiagnostics(
  em: CampaignEm,
  ctx: GtmCtx,
): Promise<{
  totals: Omit<ProviderHistoryRow, 'provider' | 'kind'>
  providers: ProviderHistoryRow[]
  window: { operationCap: number; actionCap: number; truncated: boolean }
}> {
  const operationWindow = await em.find(GtmProviderOperation, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  }, { orderBy: { requestedAt: 'desc' }, limit: PROVIDER_HISTORY_OPERATION_CAP + 1 })
  const operations = operationWindow.slice(0, PROVIDER_HISTORY_OPERATION_CAP)
  const operationIds = operations.map((operation) => operation.id)
  const actionWindow = operationIds.length > 0
    ? await em.find(GtmProviderReconciliationAction, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        providerOperationId: { $in: operationIds },
        deletedAt: null,
      }, { orderBy: { createdAt: 'desc' }, limit: PROVIDER_HISTORY_ACTION_CAP + 1 })
    : []
  const actions = actionWindow.slice(0, PROVIDER_HISTORY_ACTION_CAP)
  const distinctResearchRunIds = new Set<string>()
  const distinctCandidateIds = new Set<string>()
  const grouped = new Map<string, ProviderHistoryRow & { runIds: Set<string>; candidateIds: Set<string> }>()
  for (const operation of operations) {
    const key = `${operation.provider}\u0000${operation.kind}`
    const row = grouped.get(key) ?? {
      provider: operation.provider,
      kind: operation.kind,
      operations: 0,
      reserved: 0,
      started: 0,
      ambiguous: 0,
      settled: 0,
      unknown: 0,
      reconciliationActions: 0,
      pendingActions: 0,
      rejectedActions: 0,
      distinctResearchRuns: 0,
      distinctCandidates: 0,
      lastRequestedAt: null,
      lastSettledAt: null,
      runIds: new Set<string>(),
      candidateIds: new Set<string>(),
    }
    row.operations += 1
    row[classifyProviderOperationStatus(operation.localStatusMirror)] += 1
    if (operation.researchRunId) {
      row.runIds.add(operation.researchRunId)
      distinctResearchRunIds.add(operation.researchRunId)
    }
    if (operation.candidateId) {
      row.candidateIds.add(operation.candidateId)
      distinctCandidateIds.add(operation.candidateId)
    }
    row.lastRequestedAt = maxDate(row.lastRequestedAt, operation.requestedAt)
    row.lastSettledAt = maxDate(row.lastSettledAt, operation.settledAt)
    const operationActions = actions.filter((action) => action.providerOperationId === operation.id)
    row.reconciliationActions += operationActions.length
    row.pendingActions += operationActions.filter((action) => action.status === 'pending').length
    row.rejectedActions += operationActions.filter((action) => action.status === 'rejected').length
    grouped.set(key, row)
  }
  const providers = [...grouped.values()]
    .map(({ runIds, candidateIds, ...row }) => ({
      ...row,
      distinctResearchRuns: runIds.size,
      distinctCandidates: candidateIds.size,
    }))
    .sort((left, right) =>
      left.provider.localeCompare(right.provider) || left.kind.localeCompare(right.kind),
    )
  const totals = providers.reduce<Omit<ProviderHistoryRow, 'provider' | 'kind'>>(
    (sum, row) => ({
      operations: sum.operations + row.operations,
      reserved: sum.reserved + row.reserved,
      started: sum.started + row.started,
      ambiguous: sum.ambiguous + row.ambiguous,
      settled: sum.settled + row.settled,
      unknown: sum.unknown + row.unknown,
      reconciliationActions: sum.reconciliationActions + row.reconciliationActions,
      pendingActions: sum.pendingActions + row.pendingActions,
      rejectedActions: sum.rejectedActions + row.rejectedActions,
      distinctResearchRuns: 0,
      distinctCandidates: 0,
      lastRequestedAt: maxDate(sum.lastRequestedAt, row.lastRequestedAt),
      lastSettledAt: maxDate(sum.lastSettledAt, row.lastSettledAt),
    }),
    {
      operations: 0,
      reserved: 0,
      started: 0,
      ambiguous: 0,
      settled: 0,
      unknown: 0,
      reconciliationActions: 0,
      pendingActions: 0,
      rejectedActions: 0,
      distinctResearchRuns: 0,
      distinctCandidates: 0,
      lastRequestedAt: null,
      lastSettledAt: null,
    },
  )
  totals.distinctResearchRuns = distinctResearchRunIds.size
  totals.distinctCandidates = distinctCandidateIds.size
  return {
    totals,
    providers,
    window: {
      operationCap: PROVIDER_HISTORY_OPERATION_CAP,
      actionCap: PROVIDER_HISTORY_ACTION_CAP,
      truncated:
        operationWindow.length > PROVIDER_HISTORY_OPERATION_CAP
        || actionWindow.length > PROVIDER_HISTORY_ACTION_CAP,
    },
  }
}
