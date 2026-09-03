import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { z } from 'zod'
import { GtmAuditEvent, GtmAutoRefillPolicy } from '../data/entities'
import type { AutoRefillEm } from '../lib/auto-refill/policy'
import {
  GTM_AUTO_REFILL_QUEUE,
  type GtmAutoRefillJob,
} from '../lib/auto-refill/contract'
import { gtmEnabled } from '../lib/flags'

export { GTM_AUTO_REFILL_QUEUE } from '../lib/auto-refill/contract'

export const metadata: WorkerMeta = {
  queue: GTM_AUTO_REFILL_QUEUE,
  id: 'gtm:auto-refill',
  concurrency: 1,
}

const payloadSchema: z.ZodType<GtmAutoRefillJob> = z.object({
  policyId: z.string().uuid(),
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
  _idempotencyKey: z.string().min(1).max(512).optional(),
}).strict()

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

async function blockPolicy(
  em: AutoRefillEm,
  policy: GtmAutoRefillPolicy,
  failureCode: 'identity_changed' | 'dependencies_unavailable' | 'cycle_unresolved',
): Promise<void> {
  await em.transactional(async (tem) => {
    const current = await tem.findOne(GtmAutoRefillPolicy, {
      id: policy.id,
      organizationId: policy.organizationId,
      tenantId: policy.tenantId,
      status: 'active',
      policyHash: policy.policyHash,
      fence: policy.fence,
      deletedAt: null,
    })
    if (!current) return
    current.status = 'blocked'
    current.blockedReason = failureCode
    current.fence += 1
    tem.persist(current)
    tem.persist(tem.create(GtmAuditEvent, {
      organizationId: policy.organizationId,
      tenantId: policy.tenantId,
      actor: 'system',
      actorUserId: null,
      action: 'gtm.auto_refill.policy_blocked',
      objectType: 'gtm_auto_refill_policy',
      objectId: policy.id,
      requestId: null,
      metadata: {
        campaign_id: policy.campaignId,
        policy_hash: policy.policyHash,
        failure_code: failureCode,
      },
    }))
    await tem.flush()
  })
}

export default async function handle(
  job: QueuedJob<GtmAutoRefillJob>,
  ctx: HandlerContext,
): Promise<void> {
  // Merely registering or scheduling this worker cannot inspect a payload,
  // resolve a credential-bearing dependency, reserve credits, or contact a
  // provider while either product gate is dark.
  if (!gtmEnabled() || process.env.GTM_AUTO_REFILL_ENABLED !== 'true') return

  const payload = payloadSchema.parse(job.payload)
  const rootEm = ctx.resolve<EntityManager>('em')
  const em = rootEm.fork() as unknown as AutoRefillEm

  // Stale-cycle sweep at worker start (review 2026-09-02, H5): a cycle left
  // 'running' by a dead worker is parked for reconciliation before this
  // delivery can claim another day. Scoped to the job's tenant; best effort,
  // because a sweep failure must not hide the cycle failure that follows.
  try {
    const { sweepStaleAutoRefillCycles } = await import('../lib/auto-refill/sweep')
    await sweepStaleAutoRefillCycles(em, {
      organizationId: payload.organizationId,
      tenantId: payload.tenantId,
    })
  } catch {
    // reported by the cycle path if the database is really unavailable
  }

  const policy = await em.findOne(GtmAutoRefillPolicy, {
    id: payload.policyId,
    organizationId: payload.organizationId,
    tenantId: payload.tenantId,
    status: 'active',
    deletedAt: null,
  })
  if (!policy) return

  const { findNoliUserById, findPrimaryOrgIdForUser } = await import(
    '@open-mercato/shared/lib/noli/core-client'
  )
  const noliUser = await findNoliUserById(policy.representedNoliUserId)
  const noliOrganizationId = noliUser
    ? await findPrimaryOrgIdForUser(noliUser.id)
    : null
  if (
    !noliUser?.clerk_user_id
    || !noliOrganizationId
    || noliOrganizationId !== policy.noliOrganizationId
  ) {
    await blockPolicy(em, policy, 'identity_changed')
    return
  }

  const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
  const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
  if (
    !auth?.userId
    || !auth.orgId
    || !auth.tenantId
    || auth.userId !== policy.requestedByUserId
    || auth.orgId !== policy.organizationId
    || auth.tenantId !== policy.tenantId
  ) {
    await blockPolicy(em, policy, 'identity_changed')
    return
  }

  const { hasGtmFeature } = await import('../lib/authorize')
  if (!(await hasGtmFeature(ctx, {
    organizationId: policy.organizationId,
    tenantId: policy.tenantId,
    userId: policy.requestedByUserId,
  }, 'gtm.launch'))) {
    await blockPolicy(em, policy, 'identity_changed')
    return
  }

  const lastCycleAtBeforeDependencies = policy.lastCycleAt?.getTime() ?? null
  try {
    const [{ sourceAdapterRegistry }, { getLedger }, { processAutoRefillCycle }] = await Promise.all([
      import('../lib/adapters/registry'),
      import('../lib/credits/noli-core-ledger'),
      import('../lib/auto-refill/cycle'),
    ])
    await processAutoRefillCycle(em, {
      organizationId: policy.organizationId,
      tenantId: policy.tenantId,
      policyId: policy.id,
      noliOrganizationId,
      representedNoliUserId: policy.representedNoliUserId,
    }, {
      adapters: sourceAdapterRegistry(),
      ledger: getLedger(),
    })
  } catch (error) {
    // Registry/ledger construction happens before a cycle claim and before a
    // provider operation. Fail closed and require an explicit owner repair.
    const fresh = await em.findOne(GtmAutoRefillPolicy, {
      id: policy.id,
      organizationId: policy.organizationId,
      tenantId: policy.tenantId,
      status: 'active',
      deletedAt: null,
    })
    if (
      fresh
      && (fresh.lastCycleAt?.getTime() ?? null) === lastCycleAtBeforeDependencies
    ) {
      await blockPolicy(em, fresh, 'dependencies_unavailable')
      return
    }
    // The cycle WAS claimed and its own failure path still threw (review
    // 2026-09-02, H5 / workers M7). Swallowing this left the cycle, the
    // research run, and every escrowed reservation at 'running' with no
    // operator signal and the policy firing again tomorrow. Record it, block
    // the policy, and rethrow so the queue records a failed job. The queue
    // strategy sets no retry attempts, so this is a signal, not a re-run.
    if (fresh) {
      try {
        await blockPolicy(em, fresh, 'cycle_unresolved')
      } catch {
        // the rethrow below is the durable signal when even this write fails
      }
    }
    try {
      await em.transactional(async (tem) => {
        tem.persist(tem.create(GtmAuditEvent, {
          organizationId: policy.organizationId,
          tenantId: policy.tenantId,
          actor: 'system',
          actorUserId: null,
          action: 'gtm.auto_refill.cycle_unresolved',
          objectType: 'gtm_auto_refill_policy',
          objectId: policy.id,
          requestId: null,
          metadata: {
            campaign_id: policy.campaignId,
            policy_hash: policy.policyHash,
            failure_code: 'cycle_unresolved',
            job_id: job.id,
            error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          },
        }))
        await tem.flush()
      })
    } catch {
      // same: the rethrow is the signal of last resort
    }
    throw error
  }
}
