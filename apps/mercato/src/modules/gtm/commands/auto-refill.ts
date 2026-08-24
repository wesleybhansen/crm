import type { EntityManager } from '@mikro-orm/postgresql'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { sourceAdapterList } from '../lib/adapters/registry'
import {
  activateAutoRefillPolicy,
  pauseAutoRefillPolicy,
  type ActivateAutoRefillInput,
  type ActivateAutoRefillResult,
  type AutoRefillEm,
  type AutoRefillScheduler,
} from '../lib/auto-refill/policy'
import { GtmAutoRefillError } from '../lib/auto-refill/contract'
import type { GtmCtx } from '../lib/campaign/build'
import type { GtmAutoRefillPolicy } from '../data/entities'

export type ActivateAutoRefillCommandInput = ActivateAutoRefillInput
export type PauseAutoRefillCommandInput = { campaignId: string }

function resolveGtmContext(ctx: CommandRuntimeContext): GtmCtx {
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  const tenantId = ctx.auth?.tenantId ?? null
  const userId = ctx.auth?.userId ?? ctx.auth?.sub ?? null
  if (!organizationId || !tenantId || !userId) {
    throw new Error('GTM auto-refill command requires an exact user, organization, and tenant scope')
  }
  return {
    organizationId,
    tenantId,
    userId,
    requestId: ctx.request?.headers.get('x-request-id') ?? null,
  }
}

function resolveScheduler(runtime: CommandRuntimeContext): AutoRefillScheduler {
  try {
    const scheduler = runtime.container.resolve('schedulerService') as AutoRefillScheduler | null
    if (
      !scheduler
      || typeof scheduler.register !== 'function'
      || typeof scheduler.unregister !== 'function'
    ) {
      throw new Error('invalid scheduler')
    }
    return scheduler
  } catch {
    throw new GtmAutoRefillError('scheduler_unavailable', 'Auto-refill scheduler is unavailable')
  }
}

const activateCommand: CommandHandler<ActivateAutoRefillCommandInput, ActivateAutoRefillResult> = {
  id: 'gtm.auto-refill.activate',
  async execute(input, runtime) {
    const em = runtime.container.resolve('em') as EntityManager as unknown as AutoRefillEm
    return activateAutoRefillPolicy(em, resolveGtmContext(runtime), input, {
      adapters: sourceAdapterList(),
      scheduler: resolveScheduler(runtime),
    })
  },
  buildLog: ({ result }) => ({
    actionLabel: 'Activate bounded GTM auto-refill',
    resourceKind: 'gtm.auto_refill_policy',
    resourceId: result.policy.id,
    organizationId: result.policy.organizationId,
    tenantId: result.policy.tenantId,
    snapshotAfter: {
      campaign_id: result.policy.campaignId,
      campaign_version_id: result.policy.campaignVersionId,
      status: result.policy.status,
      policy_hash: result.policy.policyHash,
      plan_hash: result.policy.planHash,
      target_accepted_per_day: result.policy.targetAcceptedPerDay,
      max_raw_candidates_per_day: result.policy.maxRawCandidatesPerDay,
      max_credits_per_day: result.policy.maxCreditsPerDay,
      run_hour_local: result.policy.runHourLocal,
      timezone: result.policy.timezone,
      already_active: result.alreadyActive,
    },
  }),
}

type PauseResult = { policy: GtmAutoRefillPolicy; alreadyPaused: boolean }

const pauseCommand: CommandHandler<PauseAutoRefillCommandInput, PauseResult> = {
  id: 'gtm.auto-refill.pause',
  async execute(input, runtime) {
    const em = runtime.container.resolve('em') as EntityManager as unknown as AutoRefillEm
    return pauseAutoRefillPolicy(
      em,
      resolveGtmContext(runtime),
      input.campaignId,
      resolveScheduler(runtime),
    )
  },
  buildLog: ({ result }) => ({
    actionLabel: 'Pause GTM auto-refill',
    resourceKind: 'gtm.auto_refill_policy',
    resourceId: result.policy.id,
    organizationId: result.policy.organizationId,
    tenantId: result.policy.tenantId,
    snapshotAfter: {
      campaign_id: result.policy.campaignId,
      status: result.policy.status,
      policy_hash: result.policy.policyHash,
      fence: result.policy.fence,
      already_paused: result.alreadyPaused,
    },
  }),
}

registerCommand(activateCommand)
registerCommand(pauseCommand)
