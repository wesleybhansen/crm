import { GtmAuditEvent, GtmProviderOperation, GtmResearchRun } from '../../data/entities'
import type { GtmLedgerStatus } from '../credits/ledger'

/*
 * Quoted-but-never-started research runs expire.
 *
 * 'create' persists a run in status 'priced' holding the quote the customer
 * saw. If they never press start, that row used to sit in the runs list as
 * pending forever. After QUOTE_EXPIRY_DAYS it moves to 'expired': a terminal
 * status that is never executed (the priced->running claim only matches
 * 'priced') and reads as expired everywhere.
 *
 * Why 3 days: a quote is a price for a moment. Provider prices, the typical
 * spend shown beside it, and the play itself drift, and execute already
 * refuses a quote whose plan hash no longer matches. Three days still covers
 * a quote made on a Friday and approved on Monday; a fresh quote is free
 * (the 'plan' op calls no provider and charges nothing).
 *
 * Credits: a priced run holds no reservation by construction, because
 * ledger.reserve only happens inside executeResearchRun after the run has
 * been claimed as 'running'. Defensively, any provider operation still
 * mirrored as 'reserved' on an expiring run is released through the ledger
 * when one is available; without a ledger such a run is skipped (left
 * priced) so escrow is never silently orphaned.
 *
 * Reads do not wait for the nightly sweep: effectiveRunStatus() reports
 * 'expired' the moment the window passes, and execute refuses such a run.
 */

export const QUOTE_EXPIRY_DAYS = 3
const DAY_MS = 24 * 60 * 60 * 1000
export const QUOTE_EXPIRY_BATCH = 200

type RunLike = Pick<GtmResearchRun, 'status' | 'createdAt'>

function createdTime(run: RunLike): number | null {
  const created = run.createdAt instanceof Date ? run.createdAt : run.createdAt ? new Date(run.createdAt) : null
  const time = created?.getTime()
  return typeof time === 'number' && Number.isFinite(time) ? time : null
}

/** When a still-priced run's quote stops being startable; null otherwise. */
export function quoteExpiresAt(run: RunLike): Date | null {
  if (run.status !== 'priced') return null
  const created = createdTime(run)
  return created == null ? null : new Date(created + QUOTE_EXPIRY_DAYS * DAY_MS)
}

export function isQuoteExpired(run: RunLike, now: Date = new Date()): boolean {
  const expiresAt = quoteExpiresAt(run)
  return expiresAt != null && expiresAt.getTime() <= now.getTime()
}

/** The status to show: a priced run past its window reads 'expired' even
 *  before the sweep has written it. */
export function effectiveRunStatus(run: RunLike, now: Date = new Date()): string {
  return isQuoteExpired(run, now) ? 'expired' : run.status
}

export interface ExpireQuotesEm {
  transactional<T>(cb: (tem: ExpireQuotesEm) => Promise<T>): Promise<T>
  create<T extends object>(entityClass: new () => T, data: object): T
  persist(entity: object): unknown
  flush(): Promise<void>
  find<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
    options?: { orderBy?: Record<string, 'asc' | 'desc'>; limit?: number },
  ): Promise<T[]>
  nativeUpdate<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<number>
}

export type ExpireQuotesOptions = {
  now?: Date
  // limit to one organization (and optionally one tenant); omitted = all
  orgId?: string | null
  tenantId?: string | null
  // expire exactly this run (execute refusing an expired quote)
  runId?: string | null
  batch?: number
  ledger?: { release(operationId: string): Promise<GtmLedgerStatus> } | null
}

export type ExpireQuotesResult = {
  expiredRunIds: string[]
  releasedOperationIds: string[]
  // expired quotes left priced because a reservation exists and no ledger was available
  skippedReservedRunIds: string[]
}

export async function expireStaleQuotedRuns(
  em: ExpireQuotesEm,
  options: ExpireQuotesOptions = {},
): Promise<ExpireQuotesResult> {
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - QUOTE_EXPIRY_DAYS * DAY_MS)
  const where: Record<string, unknown> = {
    status: 'priced',
    createdAt: { $lte: cutoff },
    deletedAt: null,
  }
  if (options.orgId) where.organizationId = options.orgId
  if (options.tenantId) where.tenantId = options.tenantId
  if (options.runId) where.id = options.runId
  const runs = await em.find(GtmResearchRun, where, {
    orderBy: { createdAt: 'asc' },
    limit: options.batch ?? QUOTE_EXPIRY_BATCH,
  })

  const result: ExpireQuotesResult = { expiredRunIds: [], releasedOperationIds: [], skippedReservedRunIds: [] }
  for (const run of runs) {
    const reserved = await em.find(GtmProviderOperation, {
      organizationId: run.organizationId,
      tenantId: run.tenantId,
      researchRunId: run.id,
      localStatusMirror: 'reserved',
      deletedAt: null,
    })
    if (reserved.length > 0 && !options.ledger) {
      result.skippedReservedRunIds.push(run.id)
      continue
    }

    // Conditional UPDATE: a concurrent execute that already claimed the run
    // ('priced' -> 'running') wins, and this sweep leaves it alone.
    const claimed = await em.nativeUpdate(
      GtmResearchRun,
      { id: run.id, organizationId: run.organizationId, tenantId: run.tenantId, status: 'priced', deletedAt: null },
      { status: 'expired', completedAt: now, updatedAt: now },
    )
    if (claimed === 0) continue
    // The claim is ours; the execution note rides the ORM flush below (jsonb
    // through the entity's own type mapping, not the conditional UPDATE).
    const providerPlan = (run.providerPlan ?? {}) as Record<string, unknown>
    const execution = providerPlan.execution && typeof providerPlan.execution === 'object'
      ? (providerPlan.execution as Record<string, unknown>)
      : {}
    run.status = 'expired'
    run.completedAt = now
    run.providerPlan = {
      ...providerPlan,
      execution: {
        ...execution,
        status: 'expired',
        expired_at: now.toISOString(),
        failure_reason: `quote was not started within ${QUOTE_EXPIRY_DAYS} days`,
      },
    }

    await em.transactional(async (tem) => {
      tem.persist(run)
      const released: string[] = []
      for (const operation of reserved) {
        let status: string
        try {
          status = await options.ledger!.release(operation.noliCoreOperationId)
        } catch (error) {
          console.error('[gtm.research.expire-quotes] could not release reservation', operation.id, error)
          status = 'reconciliation_required'
        }
        operation.localStatusMirror = status
        operation.receipt = {
          ...(operation.receipt ?? {}),
          quote_expired_at: now.toISOString(),
        }
        tem.persist(operation)
        if (status === 'released') released.push(operation.id)
      }
      tem.persist(
        tem.create(GtmAuditEvent, {
          organizationId: run.organizationId,
          tenantId: run.tenantId,
          actor: 'system',
          action: 'gtm.research_run.quote_expired',
          objectType: 'gtm_research_run',
          objectId: run.id,
          metadata: {
            quoted_at: run.createdAt instanceof Date ? run.createdAt.toISOString() : null,
            expiry_days: QUOTE_EXPIRY_DAYS,
            released_provider_operation_ids: released,
          },
        }),
      )
      await tem.flush()
      result.releasedOperationIds.push(...released)
    })
    result.expiredRunIds.push(run.id)
  }
  return result
}
