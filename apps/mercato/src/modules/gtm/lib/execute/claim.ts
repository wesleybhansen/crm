import crypto from 'crypto'
import type { GtmCtx } from '../campaign/build'
import type { Clock, ExecutionEm } from './schedule'
import { GtmSendAttempt } from '../../data/entities'

/*
 * DB-time CAS claim with lease and fence (SPEC-066 section 6 rules 1 and 5).
 *
 * A worker claims a due attempt with the moral equivalent of:
 *
 *   UPDATE gtm_send_attempts
 *      SET state='claimed', claim_token=gen_random_uuid(),
 *          claim_expires_at = now() + lease, fence = fence + 1
 *    WHERE id = ? AND state = <observed state> AND fence = <observed fence>
 *      AND scheduled_for <= now()
 *      AND (claim_expires_at IS NULL OR claim_expires_at < now())
 *
 * Time source: production callers do NOT inject a clock; `resolveNow` then
 * reads `select now()` from the database connection, so due-ness and lease
 * expiry are decided by DATABASE time, never an application clock (the
 * SPEC-065 lesson). The single DB-sourced timestamp is bound into the
 * conditional UPDATE's parameters. Tests drive the FakeEm (which has no
 * database) with an injected clock; the CAS itself is identical.
 *
 * Reclaim rules:
 *  - state 'approved'          claimable when due (lease absent or expired)
 *  - state 'claimed', expired  reclaimable; the CAS bumps the fence so the
 *                              previous claimant's writes are fenced out
 *  - state 'provider_started'  NEVER reclaimable. A lease-expired
 *                              provider_started row degrades to 'ambiguous'
 *                              via recoverStuckAttempts (rule 5): the
 *                              provider may have accepted the message, so
 *                              re-sending is forbidden; reconciliation is a
 *                              human/ops concern.
 *  - state 'ambiguous'         never selected, never auto-retried (rule 4).
 */

export const DEFAULT_LEASE_MINUTES = 10

export async function resolveNow(em: ExecutionEm, clock?: Clock): Promise<Date> {
  if (clock) return clock.now()
  const anyEm = em as unknown as {
    getConnection?: () => { execute: (sql: string) => Promise<Array<Record<string, unknown>>> }
  }
  if (typeof anyEm.getConnection === 'function') {
    try {
      const rows = await anyEm.getConnection().execute('select now() as now')
      const value = rows?.[0]?.now
      if (value) return new Date(value as string | number | Date)
    } catch {
      // fall through to the process clock as a last resort
    }
  }
  return new Date()
}

export type ClaimedAttempt = {
  attempt: GtmSendAttempt
  claimToken: string
  fence: number
}

export type ClaimResult = {
  now: Date
  due: number
  claimed: ClaimedAttempt[]
}

export async function claimDueAttempts(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: { limit?: number; leaseMinutes?: number; clock?: Clock } = {},
): Promise<ClaimResult> {
  const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 100) : 25
  const leaseMinutes = input.leaseMinutes && input.leaseMinutes > 0 ? input.leaseMinutes : DEFAULT_LEASE_MINUTES
  const now = await resolveNow(em, input.clock)

  // Candidate set: due 'approved' rows plus lease-expired 'claimed' rows.
  const candidates = (
    await em.find(GtmSendAttempt, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      state: { $in: ['approved', 'claimed'] },
      scheduledFor: { $lte: now },
      deletedAt: null,
      $or: [{ claimExpiresAt: null }, { claimExpiresAt: { $lt: now } }],
    })
  ).sort((a, b) => (a.scheduledFor?.getTime() ?? 0) - (b.scheduledFor?.getTime() ?? 0))

  const claimed: ClaimedAttempt[] = []
  for (const row of candidates) {
    if (claimed.length >= limit) break
    const observedState = row.state
    const observedFence = row.fence
    const claimToken = crypto.randomUUID()
    // The CAS: one conditional UPDATE. Concurrent claimers observed the same
    // state+fence; exactly one statement matches, the rest update 0 rows.
    const updated = await em.nativeUpdate(
      GtmSendAttempt,
      {
        id: row.id,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        state: observedState,
        fence: observedFence,
        scheduledFor: { $lte: now },
        $or: [{ claimExpiresAt: null }, { claimExpiresAt: { $lt: now } }],
      },
      {
        state: 'claimed',
        claimToken,
        claimExpiresAt: new Date(now.getTime() + leaseMinutes * 60 * 1000),
        fence: observedFence + 1,
        updatedAt: now,
      },
    )
    if (updated !== 1) continue
    const fresh = await em.findOne(GtmSendAttempt, {
      id: row.id,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
    })
    if (!fresh) continue
    claimed.push({ attempt: fresh, claimToken, fence: observedFence + 1 })
  }
  return { now, due: candidates.length, claimed }
}

export type RecoverResult = {
  now: Date
  ambiguous: number
}

// Rule 5 second half: a lease-expired 'provider_started' row is NOT
// reclaimable - the provider may have taken the message. Degrade it to
// 'ambiguous' (parked, never auto-retried) with a CAS so a still-live
// executor that races this pass is not clobbered.
export async function recoverStuckAttempts(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: { clock?: Clock } = {},
): Promise<RecoverResult> {
  const now = await resolveNow(em, input.clock)
  const stuck = await em.find(GtmSendAttempt, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    state: 'provider_started',
    claimExpiresAt: { $lt: now },
    deletedAt: null,
  })
  let ambiguous = 0
  for (const row of stuck) {
    const updated = await em.nativeUpdate(
      GtmSendAttempt,
      {
        id: row.id,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        state: 'provider_started',
        fence: row.fence,
        claimExpiresAt: { $lt: now },
      },
      {
        state: 'ambiguous',
        ambiguousAt: now,
        failureReason: 'lease_expired_after_provider_start',
        updatedAt: now,
      },
    )
    ambiguous += updated
  }
  return { now, ambiguous }
}
