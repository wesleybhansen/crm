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
    deps: { transport: GtmSendTransport },
  ) => Promise<ExecuteOutcome>
  transport: GtmSendTransport
}

export type ExecutionTickResult = {
  ambiguousRecovered: number
  due: number
  claimed: number
  outcomes: ExecuteOutcome[]
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
  const outcomes: ExecuteOutcome[] = []
  for (const claimed of claim.claimed) {
    outcomes.push(
      await deps.executeClaimedAttempt(em, ctx, claimed.attempt, {
        transport: deps.transport,
      }),
    )
  }
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
  const [{ claimDueAttempts, recoverStuckAttempts }, { executeClaimedAttempt }, { mailboxTransport }] = await Promise.all([
    import('../lib/execute/claim'),
    import('../lib/execute/send'),
    import('../lib/execute/transport'),
  ])
  await processExecutionTick(em, payload, `queue:${ctx.jobId}`, {
    recoverStuckAttempts,
    claimDueAttempts,
    executeClaimedAttempt,
    transport: mailboxTransport,
  })
}
