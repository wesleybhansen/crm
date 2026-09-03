import { GtmAuditEvent, GtmProviderOperation, GtmResearchRun } from '../../data/entities'

/*
 * Stale-running sweeper (minimum viable answer to synchronous execution).
 *
 * executeResearchRun runs inside one HTTP request. A proxy timeout or a
 * process restart mid-run leaves the run in 'running' forever with its
 * reservations escrowed and no worker to resume or fail it. This sweeper
 * marks such runs failed and parks their provider_started operations as
 * reconciliation_required so the operator surface can see and settle them.
 *
 * It never contacts a provider or the canonical ledger: the local mirror is
 * moved to reconciliation_required only as a shadow of "outcome unknown";
 * the reservation stays escrowed until an explicit operator decision. The
 * sweep is idempotent (a failed run is not matched again) and self-scoped.
 */

export const STALE_RESEARCH_RUN_MINUTES = 30

export interface StaleRunEm {
  transactional<T>(cb: (tem: StaleRunEm) => Promise<T>): Promise<T>
  create<T extends object>(entityClass: new () => T, data: object): T
  persist(entity: object): unknown
  flush(): Promise<void>
  find<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
    options?: { orderBy?: Record<string, 'asc' | 'desc'>; limit?: number },
  ): Promise<T[]>
}

export type FailStaleResearchRunsResult = {
  olderThanMinutes: number
  cutoff: string
  failedRunIds: string[]
  parkedOperationIds: string[]
}

const MAX_RUNS_PER_SWEEP = 50

export async function failStaleResearchRuns(
  em: StaleRunEm,
  scope: { organizationId: string; tenantId: string },
  options: { olderThanMinutes?: number; now?: () => Date; actorUserId?: string | null; requestId?: string | null } = {},
): Promise<FailStaleResearchRunsResult> {
  const olderThanMinutes = Math.max(
    5,
    Math.floor(Number.isFinite(options.olderThanMinutes ?? NaN) ? Number(options.olderThanMinutes) : STALE_RESEARCH_RUN_MINUTES),
  )
  const now = options.now ?? (() => new Date())
  const cutoff = new Date(now().getTime() - olderThanMinutes * 60_000)
  const runs = await em.find(
    GtmResearchRun,
    {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      status: 'running',
      startedAt: { $lt: cutoff },
      deletedAt: null,
    },
    { orderBy: { startedAt: 'asc' }, limit: MAX_RUNS_PER_SWEEP },
  )

  const failedRunIds: string[] = []
  const parkedOperationIds: string[] = []
  for (const run of runs) {
    await em.transactional(async (tem) => {
      const operations = await tem.find(GtmProviderOperation, {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        researchRunId: run.id,
        localStatusMirror: 'provider_started',
        deletedAt: null,
      })
      const parked: string[] = []
      for (const operation of operations) {
        operation.localStatusMirror = 'reconciliation_required'
        operation.receipt = {
          ...(operation.receipt ?? {}),
          stale_run_parked_at: now().toISOString(),
          stale_run_reason: `research run exceeded ${olderThanMinutes} minutes in running state`,
        }
        tem.persist(operation)
        parked.push(operation.id)
      }
      const failureReason = `research run exceeded ${olderThanMinutes} minutes in running state`
      const providerPlan = (run.providerPlan ?? {}) as Record<string, unknown>
      const execution = providerPlan.execution && typeof providerPlan.execution === 'object'
        ? (providerPlan.execution as Record<string, unknown>)
        : {}
      run.status = 'failed'
      run.completedAt = now()
      run.providerPlan = {
        ...providerPlan,
        execution: {
          ...execution,
          status: 'failed',
          failure_reason: failureReason,
          reconciliation_required: parked.length > 0 || execution.reconciliation_required === true,
          stale_run_swept_at: now().toISOString(),
        },
      }
      tem.persist(run)
      tem.persist(
        tem.create(GtmAuditEvent, {
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          actor: options.actorUserId ? 'user_id' : 'system',
          actorUserId: options.actorUserId ?? null,
          action: 'gtm.research_run.stale_failed',
          objectType: 'gtm_research_run',
          objectId: run.id,
          requestId: options.requestId ?? null,
          metadata: {
            older_than_minutes: olderThanMinutes,
            started_at: run.startedAt?.toISOString() ?? null,
            parked_provider_operation_ids: parked,
          },
        }),
      )
      await tem.flush()
      failedRunIds.push(run.id)
      parkedOperationIds.push(...parked)
    })
  }
  return { olderThanMinutes, cutoff: cutoff.toISOString(), failedRunIds, parkedOperationIds }
}
