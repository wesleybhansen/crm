import crypto from 'crypto'
import { LockMode } from '@mikro-orm/core'
import type { SourceAdapter } from '../adapters/types'
import {
  GtmAuditEvent,
  GtmAutoRefillCycle,
  GtmAutoRefillPolicy,
  GtmCampaign,
  GtmCampaignVersion,
  GtmPlay,
} from '../../data/entities'
import {
  approvalEnvelopeMatches,
} from '../campaign/approve'
import type { CampaignEm, GtmCtx } from '../campaign/build'
import { parseSettings } from '../campaign/build'
import { buildSourcePlan, type ResearchLimitsInput, type SourcePlanSuccess } from '../research/plan'
import {
  autoRefillScheduleCron,
  buildAutoRefillPolicyHash,
  GtmAutoRefillError,
  GTM_AUTO_REFILL_QUEUE,
  parseApprovedAutoRefillConfig,
} from './contract'

export interface AutoRefillEm extends CampaignEm {
  nativeUpdate<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<number>
}

export type AutoRefillScheduler = {
  register(registration: {
    id: string
    name: string
    description: string
    scopeType: 'organization'
    organizationId: string
    tenantId: string
    scheduleType: 'cron'
    scheduleValue: string
    timezone: string
    targetType: 'queue'
    targetQueue: string
    targetPayload: Record<string, unknown>
    requireFeature: 'gtm.launch'
    sourceType: 'module'
    sourceModule: 'gtm'
    isEnabled: boolean
  }): Promise<void>
  unregister(scheduleId: string): Promise<void>
}

export type AutoRefillPlanInput = {
  campaignId: string
  limits: Required<Pick<ResearchLimitsInput, 'targetAccepted' | 'maxRawCandidates' | 'maxCredits'>>
  runHourLocal: number
}

export type AutoRefillPlanResult = {
  campaign: GtmCampaign
  play: GtmPlay
  plan: SourcePlanSuccess
  timezone: string
  runHourLocal: number
}

export async function planAutoRefill(
  em: AutoRefillEm,
  ctx: GtmCtx,
  input: AutoRefillPlanInput,
  adapters: SourceAdapter[],
): Promise<AutoRefillPlanResult> {
  const campaign = await em.findOne(GtmCampaign, {
    id: input.campaignId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!campaign) throw new GtmAutoRefillError('campaign_not_found', 'Campaign not found')
  const play = await em.findOne(GtmPlay, {
    id: campaign.playId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!play || play.workspaceId !== campaign.workspaceId) {
    throw new GtmAutoRefillError('campaign_not_found', 'Campaign play not found')
  }
  const plan = buildSourcePlan(play, adapters, input.limits)
  if (!plan.ok) throw new GtmAutoRefillError('plan_changed', plan.reason)
  if (!plan.adapterPlan.some((batch) => batch.estimatedCredits <= plan.limits.maxCredits)) {
    throw new GtmAutoRefillError(
      'daily_credit_cap_too_low',
      'The daily credit cap is below the least expensive available provider batch',
    )
  }
  const settings = parseSettings(campaign)
  return {
    campaign,
    play,
    plan,
    timezone: settings.send_window.timezone,
    runHourLocal: input.runHourLocal,
  }
}

export type ActivateAutoRefillInput = {
  campaignId: string
  expectedContentHash: string
  expectedPlanHash: string
  representedNoliUserId: string
  noliOrganizationId: string
}

export type ActivateAutoRefillResult = {
  policy: GtmAutoRefillPolicy
  plan: SourcePlanSuccess
  alreadyActive: boolean
}

function scheduleName(campaign: GtmCampaign): string {
  const compact = campaign.name.trim().replace(/\s+/g, ' ').slice(0, 120)
  return `GTM auto-refill: ${compact || campaign.id}`
}

export async function activateAutoRefillPolicy(
  em: AutoRefillEm,
  ctx: GtmCtx,
  input: ActivateAutoRefillInput,
  deps: { adapters: SourceAdapter[]; scheduler: AutoRefillScheduler },
): Promise<ActivateAutoRefillResult> {
  const prepared = await em.transactional(async (tem) => {
    const campaign = await tem.findOne(GtmCampaign, {
      id: input.campaignId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    if (!campaign) throw new GtmAutoRefillError('campaign_not_found', 'Campaign not found')
    if (!campaign.currentVersionId || !['approved', 'launching', 'active', 'paused'].includes(campaign.status)) {
      throw new GtmAutoRefillError('campaign_not_approved', 'Approve the campaign before activating auto-refill')
    }
    const version = await tem.findOne(GtmCampaignVersion, {
      id: campaign.currentVersionId,
      campaignId: campaign.id,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    if (
      !version
      || !version.approvedAt
      || version.invalidatedAt
      || !approvalEnvelopeMatches(version.snapshot, version.contentHash)
    ) {
      throw new GtmAutoRefillError('campaign_not_approved', 'The current campaign approval is not valid')
    }
    if (version.contentHash !== input.expectedContentHash) {
      throw new GtmAutoRefillError('stale_campaign', 'Campaign approval changed; review it again before activating auto-refill')
    }
    const approved = parseApprovedAutoRefillConfig(version.snapshot)
    if (approved.autoRefill.plan_hash !== input.expectedPlanHash) {
      throw new GtmAutoRefillError('plan_changed', 'The confirmed auto-refill plan does not match the approved campaign')
    }
    const play = await tem.findOne(GtmPlay, {
      id: campaign.playId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    })
    if (!play || play.workspaceId !== campaign.workspaceId) {
      throw new GtmAutoRefillError('campaign_not_found', 'Campaign play not found')
    }
    const plan = buildSourcePlan(play, deps.adapters, {
      targetAccepted: approved.autoRefill.target_accepted_per_day,
      maxRawCandidates: approved.autoRefill.max_raw_candidates_per_day,
      maxCredits: approved.autoRefill.max_credits_per_day,
    })
    if (!plan.ok || plan.planHash !== input.expectedPlanHash) {
      throw new GtmAutoRefillError(
        'plan_changed',
        plan.ok ? 'Provider plan changed; review and approve a refreshed quote' : plan.reason,
      )
    }
    if (!plan.adapterPlan.some((batch) => batch.estimatedCredits <= plan.limits.maxCredits)) {
      throw new GtmAutoRefillError(
        'daily_credit_cap_too_low',
        'The daily credit cap is below the least expensive available provider batch',
      )
    }

    let policy = await tem.findOne(GtmAutoRefillPolicy, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      campaignId: campaign.id,
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    const policyId = policy?.id ?? crypto.randomUUID()
    const scheduledJobId = `gtm-auto-refill-${policyId}`
    const policyMaterial = {
      policyId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      workspaceId: campaign.workspaceId,
      playId: play.id,
      campaignId: campaign.id,
      campaignVersionId: version.id,
      representedNoliUserId: input.representedNoliUserId,
      noliOrganizationId: input.noliOrganizationId,
      requestedByUserId: ctx.userId,
      campaignContentHash: version.contentHash,
      planHash: plan.planHash,
      targetAcceptedPerDay: approved.autoRefill.target_accepted_per_day,
      maxRawCandidatesPerDay: approved.autoRefill.max_raw_candidates_per_day,
      maxCreditsPerDay: approved.autoRefill.max_credits_per_day,
      runHourLocal: approved.autoRefill.run_hour_local,
      timezone: approved.timezone,
    }
    const policyHash = buildAutoRefillPolicyHash(policyMaterial)
    const { policyId: _policyId, ...policyFields } = policyMaterial
    const alreadyActive = policy?.status === 'active' && policy.policyHash === policyHash
    if (!policy) {
      policy = tem.create(GtmAutoRefillPolicy, {
        id: policyId,
        ...policyFields,
        status: 'pending_schedule',
        policyHash,
        scheduledJobId,
        fence: 1,
        blockedReason: null,
      })
    } else {
      Object.assign(policy, policyFields, {
        status: 'pending_schedule',
        policyHash,
        scheduledJobId,
        fence: policy.fence + 1,
        blockedReason: null,
      })
    }
    tem.persist(policy)
    tem.persist(tem.create(GtmAuditEvent, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      actor: 'user_id',
      actorUserId: ctx.userId,
      action: 'gtm.auto_refill.activation_requested',
      objectType: 'gtm_auto_refill_policy',
      objectId: policy.id,
      requestId: ctx.requestId ?? null,
      metadata: {
        campaign_id: campaign.id,
        campaign_version_id: version.id,
        policy_hash: policyHash,
        plan_hash: plan.planHash,
        target_accepted_per_day: policy.targetAcceptedPerDay,
        max_raw_candidates_per_day: policy.maxRawCandidatesPerDay,
        max_credits_per_day: policy.maxCreditsPerDay,
        run_hour_local: policy.runHourLocal,
        timezone: policy.timezone,
      },
    }))
    await tem.flush()
    return { campaign, policy, plan, alreadyActive, activationFence: policy.fence }
  })

  try {
    await deps.scheduler.register({
      id: prepared.policy.scheduledJobId,
      name: scheduleName(prepared.campaign),
      description: 'Find a bounded daily batch of qualified people and queue them for review',
      scopeType: 'organization',
      organizationId: prepared.policy.organizationId,
      tenantId: prepared.policy.tenantId,
      scheduleType: 'cron',
      scheduleValue: autoRefillScheduleCron(prepared.policy.runHourLocal),
      timezone: prepared.policy.timezone,
      targetType: 'queue',
      targetQueue: GTM_AUTO_REFILL_QUEUE,
      targetPayload: {
        policyId: prepared.policy.id,
        organizationId: prepared.policy.organizationId,
        tenantId: prepared.policy.tenantId,
      },
      requireFeature: 'gtm.launch',
      sourceType: 'module',
      sourceModule: 'gtm',
      isEnabled: true,
    })
  } catch {
    throw new GtmAutoRefillError('scheduler_unavailable', 'Auto-refill schedule is unavailable')
  }

  const activated = await em.transactional(async (tem) => {
    const policy = await tem.findOne(GtmAutoRefillPolicy, {
      id: prepared.policy.id,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    if (!policy || policy.status !== 'pending_schedule' || policy.fence !== prepared.activationFence) {
      throw new GtmAutoRefillError('policy_changed', 'Auto-refill policy changed while its schedule was registered')
    }
    policy.status = 'active'
    policy.blockedReason = null
    tem.persist(policy)
    tem.persist(tem.create(GtmAuditEvent, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      actor: 'user_id',
      actorUserId: ctx.userId,
      action: 'gtm.auto_refill.activated',
      objectType: 'gtm_auto_refill_policy',
      objectId: policy.id,
      requestId: ctx.requestId ?? null,
      metadata: {
        campaign_id: policy.campaignId,
        campaign_version_id: policy.campaignVersionId,
        policy_hash: policy.policyHash,
        fence: policy.fence,
      },
    }))
    await tem.flush()
    return policy
  })

  return { policy: activated, plan: prepared.plan, alreadyActive: prepared.alreadyActive }
}

export async function pauseAutoRefillPolicy(
  em: AutoRefillEm,
  ctx: GtmCtx,
  campaignId: string,
  scheduler: AutoRefillScheduler,
): Promise<{ policy: GtmAutoRefillPolicy; alreadyPaused: boolean }> {
  const result = await em.transactional(async (tem) => {
    const policy = await tem.findOne(GtmAutoRefillPolicy, {
      campaignId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    if (!policy) throw new GtmAutoRefillError('policy_not_found', 'Auto-refill policy not found')
    const alreadyPaused = policy.status === 'paused'
    policy.status = 'paused'
    policy.blockedReason = null
    if (!alreadyPaused) policy.fence += 1
    tem.persist(policy)
    tem.persist(tem.create(GtmAuditEvent, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      actor: 'user_id',
      actorUserId: ctx.userId,
      action: 'gtm.auto_refill.paused',
      objectType: 'gtm_auto_refill_policy',
      objectId: policy.id,
      requestId: ctx.requestId ?? null,
      metadata: {
        campaign_id: policy.campaignId,
        policy_hash: policy.policyHash,
        fence: policy.fence,
        already_paused: alreadyPaused,
      },
    }))
    await tem.flush()
    return { policy, alreadyPaused }
  })

  try {
    await scheduler.unregister(result.policy.scheduledJobId)
  } catch {
    // The database status changed first, so even a still-delivering scheduler
    // cannot authorize a cycle. Surface the control-plane failure for repair.
    throw new GtmAutoRefillError('scheduler_unavailable', 'Auto-refill is paused, but its schedule could not be removed')
  }
  return result
}

export type AutoRefillStatus = {
  policy: GtmAutoRefillPolicy | null
  latestCycle: GtmAutoRefillCycle | null
}

export async function getAutoRefillStatus(
  em: AutoRefillEm,
  ctx: GtmCtx,
  campaignId: string,
): Promise<AutoRefillStatus> {
  const campaign = await em.findOne(GtmCampaign, {
    id: campaignId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!campaign) throw new GtmAutoRefillError('campaign_not_found', 'Campaign not found')
  const policy = await em.findOne(GtmAutoRefillPolicy, {
    campaignId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!policy) return { policy: null, latestCycle: null }
  const [latestCycle] = await em.find(GtmAutoRefillCycle, {
    policyId: policy.id,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  }, { orderBy: { createdAt: 'desc' }, limit: 1 })
  return { policy, latestCycle: latestCycle ?? null }
}
