import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { z } from 'zod'
import type { GtmCtx } from '../lib/campaign/build'
import type { ClaimResult, RecoverResult } from '../lib/execute/claim'
import type { ExecuteOutcome } from '../lib/execute/send'
import type { ExecutionEm } from '../lib/execute/schedule'
import type { GtmSendTransport } from '../lib/execute/transport'
import {
  GTM_EXECUTION_TICK_QUEUE,
  type GtmExecutionTickJob,
} from '../lib/execute/queue-contract'
import { gtmEnabled } from '../lib/flags'
import { GtmSendAttempt } from '../data/entities'

export { GTM_EXECUTION_TICK_QUEUE } from '../lib/execute/queue-contract'

export const metadata: WorkerMeta = {
  queue: GTM_EXECUTION_TICK_QUEUE,
  id: 'gtm:execution-tick',
  concurrency: 1,
}

const payloadSchema: z.ZodType<GtmExecutionTickJob> = z.object({
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
  requestedByUserId: z.string().uuid(),
  limit: z.number().int().min(1).max(100).optional(),
  _idempotencyKey: z.string().min(1).max(512).optional(),
}).strict()

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

export type ExecutionTickDependencies = {
  recoverStuckAttempts: (
    em: ExecutionEm,
    ctx: GtmCtx,
  ) => Promise<RecoverResult>
  claimDueAttempts: (
    em: ExecutionEm,
    ctx: GtmCtx,
    input: { limit?: number },
  ) => Promise<ClaimResult>
  executeClaimedAttempt: (
    em: ExecutionEm,
    ctx: GtmCtx,
    attempt: ClaimResult['claimed'][number]['attempt'],
    deps: { transport: GtmSendTransport; now?: Date },
  ) => Promise<ExecuteOutcome>
  transport: GtmSendTransport
}

export type ExecutionTickResult = {
  ambiguousRecovered: number
  due: number
  claimed: number
  outcomes: ExecuteOutcome[]
}

// A claim whose lease has less than this left is released instead of
// executed: the executor's own re-lease happens only at provider_started,
// after nine DB round trips, and a lease that lapses in between hands the
// row to a concurrent reclaim while this executor is still working (M2).
export const LEASE_RELEASE_MARGIN_MS = 90 * 1000

// Each attempt runs in its OWN EntityManager fork (C1). MikroORM copies the
// identity map into every transaction fork and flushes it on commit, so a
// managed entity from attempt A that is still in the shared context would be
// flushed back over A's row during attempt B's start transaction. A fresh
// fork per attempt makes that impossible regardless of what the executor
// loads; production ORM instances expose fork(), the FakeEm in identity-map
// mode mirrors it, and a plain slice without fork() falls back to the shared
// context.
type ForkableEm = ExecutionEm & { fork?: () => ExecutionEm }

function forkFor(em: ExecutionEm): ExecutionEm {
  const forkable = em as ForkableEm
  return typeof forkable.fork === 'function' ? forkable.fork() : em
}

/*
 * Execute the claimed attempts of one tick serially. Shared by the queue
 * worker and the internal execution route so both apply the per-attempt fork,
 * the DB-anchored `now`, and the lease-margin release identically.
 */
export async function executeClaimedBatch(
  em: ExecutionEm,
  ctx: GtmCtx,
  claim: ClaimResult,
  deps: Pick<ExecutionTickDependencies, 'executeClaimedAttempt' | 'transport'>,
): Promise<ExecuteOutcome[]> {
  const outcomes: ExecuteOutcome[] = []
  const anchoredAt = Date.now()
  const nowFromClaim = () => new Date(claim.now.getTime() + (Date.now() - anchoredAt))
  for (const claimed of claim.claimed) {
    const now = nowFromClaim()
    const expiresAt = claimed.attempt.claimExpiresAt?.getTime() ?? null
    if (expiresAt != null && expiresAt - now.getTime() < LEASE_RELEASE_MARGIN_MS) {
      // Give the row back untouched, under the fence, so the next tick picks
      // it up immediately rather than after the lease lapses.
      const released = await em.nativeUpdate(
        GtmSendAttempt,
        {
          id: claimed.attempt.id,
          organizationId: ctx.organizationId,
          tenantId: ctx.tenantId,
          state: 'claimed',
          claimToken: claimed.claimToken,
          fence: claimed.fence,
        },
        { state: 'approved', claimToken: null, claimExpiresAt: null, updatedAt: now },
      )
      outcomes.push(
        released === 1
          ? { outcome: 'released', attemptId: claimed.attempt.id, reason: 'lease_expiring' }
          : { outcome: 'fenced', attemptId: claimed.attempt.id },
      )
      continue
    }
    outcomes.push(
      await deps.executeClaimedAttempt(forkFor(em), ctx, claimed.attempt, {
        transport: deps.transport,
        now,
      }),
    )
  }
  return outcomes
}

export async function processExecutionTick(
  em: ExecutionEm,
  payload: GtmExecutionTickJob,
  requestId: string,
  deps: ExecutionTickDependencies,
): Promise<ExecutionTickResult> {
  const ctx: GtmCtx = {
    organizationId: payload.organizationId,
    tenantId: payload.tenantId,
    userId: payload.requestedByUserId,
    requestId,
  }
  // Park lease-expired provider_started rows before claiming new work. They
  // are never retried: provider acceptance is unknowable until reconciled.
  const recovery = await deps.recoverStuckAttempts(em, ctx)
  const claim = await deps.claimDueAttempts(em, ctx, { limit: payload.limit })
  const outcomes = await executeClaimedBatch(em, ctx, claim, deps)
  return {
    ambiguousRecovered: recovery.ambiguous,
    due: claim.due,
    claimed: claim.claimed.length,
    outcomes,
  }
}

export default async function handle(
  job: QueuedJob<GtmExecutionTickJob>,
  ctx: HandlerContext,
): Promise<void> {
  // Safety invariant: neither the untrusted payload nor a dependency is
  // touched while either gate is dark. Merely registering the worker cannot
  // claim an attempt or construct/reach a mailbox transport.
  if (!gtmEnabled() || process.env.GTM_EXECUTION_ENABLED !== 'true') return

  const payload = payloadSchema.parse(job.payload)
  const rootEm = ctx.resolve<EntityManager>('em')
  const em = rootEm.fork() as unknown as ExecutionEm
  const [
    { claimDueAttempts, recoverStuckAttempts },
    { executeClaimedAttempt },
    { createPersistingMailboxTransport },
    { EmailConnection },
  ] = await Promise.all([
    import('../lib/execute/claim'),
    import('../lib/execute/send'),
    import('../lib/execute/transport'),
    import('../../email/data/schema'),
  ])
  await processExecutionTick(em, payload, `queue:${ctx.jobId}`, {
    recoverStuckAttempts,
    claimDueAttempts,
    executeClaimedAttempt,
    // Refreshed OAuth tokens are persisted on the connection row (M4).
    transport: createPersistingMailboxTransport(em, EmailConnection),
  })
}
