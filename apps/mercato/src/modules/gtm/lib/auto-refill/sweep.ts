import { LockMode } from '@mikro-orm/core'
import {
  GtmAuditEvent,
  GtmAutoRefillCycle,
  GtmAutoRefillPolicy,
  GtmResearchRun,
} from '../../data/entities'
import type { AutoRefillEm } from './policy'
import { AUTO_REFILL_CYCLE_SCHEMA_VERSION, AUTO_REFILL_STALE_CYCLE_MS } from './contract'

/*
 * Stale-cycle sweep (review 2026-09-02, H5 / workers M7).
 *
 * A cycle is claimed as 'running' before the research run starts. If the
 * worker process dies mid-run, or the failure path itself throws (a DB blip
 * inside failCycleAfterException), the cycle, its research run, and every
 * escrowed provider reservation stay 'running' forever: no audit row, no
 * operator signal, and the policy fires again the next weekday. This sweep
 * turns any 'running' cycle older than AUTO_REFILL_STALE_CYCLE_MS into
 * reconciliation_required, fails its research run, blocks the policy so it
 * cannot fire again until an owner looks, and writes an audit event.
 *
 * It never touches provider operations or the ledger: the escrow is exactly
 * what reconciliation is for, and guessing a settlement here would be worse
 * than leaving it parked.
 */

export type StaleCycleSweepInput = {
  organizationId: string
  tenantId: string
  now?: Date
  staleAfterMs?: number
}

export type StaleCycleSweepResult = {
  swept: Array<{ cycleId: string; policyId: string; researchRunId: string | null }>
}

export async function sweepStaleAutoRefillCycles(
  em: AutoRefillEm,
  input: StaleCycleSweepInput,
): Promise<StaleCycleSweepResult> {
  const now = input.now ?? new Date()
  const staleAfterMs = Number.isFinite(input.staleAfterMs)
    ? Math.max(0, Number(input.staleAfterMs))
    : AUTO_REFILL_STALE_CYCLE_MS
  const cutoff = new Date(now.getTime() - staleAfterMs)
  const stale = await em.find(GtmAutoRefillCycle, {
    organizationId: input.organizationId,
    tenantId: input.tenantId,
    status: 'running',
    startedAt: { $lte: cutoff },
    deletedAt: null,
  })
  const swept: StaleCycleSweepResult['swept'] = []
  for (const candidate of stale) {
    const result = await em.transactional(async (tem) => {
      const cycle = await tem.findOne(GtmAutoRefillCycle, {
        id: candidate.id,
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        status: 'running',
        deletedAt: null,
      }, { lockMode: LockMode.PESSIMISTIC_WRITE })
      // Finished between the scan and the lock: nothing to do.
      if (!cycle) return null
      const policy = await tem.findOne(GtmAutoRefillPolicy, {
        id: cycle.policyId,
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        deletedAt: null,
      }, { lockMode: LockMode.PESSIMISTIC_WRITE })
      const run = cycle.researchRunId
        ? await tem.findOne(GtmResearchRun, {
            id: cycle.researchRunId,
            organizationId: input.organizationId,
            tenantId: input.tenantId,
            deletedAt: null,
          }, { lockMode: LockMode.PESSIMISTIC_WRITE })
        : null
      cycle.status = 'reconciliation_required'
      cycle.failureCode = 'stale_running_cycle'
      cycle.result = {
        schema_version: AUTO_REFILL_CYCLE_SCHEMA_VERSION,
        research_status: 'failed',
        reconciliation_required: true,
        stale_after_ms: staleAfterMs,
        started_at: cycle.startedAt?.toISOString() ?? null,
      }
      cycle.completedAt = now
      tem.persist(cycle)
      if (run && run.status === 'running') {
        run.status = 'failed'
        run.completedAt = now
        tem.persist(run)
      }
      if (policy && policy.status === 'active') {
        policy.status = 'blocked'
        policy.blockedReason = 'reconciliation_required'
        policy.fence += 1
        tem.persist(policy)
      }
      tem.persist(tem.create(GtmAuditEvent, {
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        actor: 'system',
        actorUserId: null,
        action: 'gtm.auto_refill.cycle_stale',
        objectType: 'gtm_auto_refill_cycle',
        objectId: cycle.id,
        requestId: null,
        metadata: {
          policy_id: cycle.policyId,
          campaign_id: cycle.campaignId,
          research_run_id: cycle.researchRunId ?? null,
          local_date: cycle.localDate,
          status: 'reconciliation_required',
          failure_code: 'stale_running_cycle',
          stale_after_ms: staleAfterMs,
          policy_blocked: policy?.status === 'blocked',
        },
      }))
      await tem.flush()
      return { cycleId: cycle.id, policyId: cycle.policyId, researchRunId: cycle.researchRunId ?? null }
    })
    if (result) swept.push(result)
  }
  return { swept }
}
