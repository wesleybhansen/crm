import { LockMode } from '@mikro-orm/core'
import {
  GtmAuditEvent,
  GtmCampaign,
  GtmCampaignVersion,
  GtmEnrollment,
  GtmSendAttempt,
} from '../../data/entities'
import { approvalEnvelopeMatches } from '../campaign/approve'
import type { GtmCtx } from '../campaign/build'
import { GtmExecutionError, type Clock, type ExecutionEm } from './schedule'

export type CampaignLifecycleAction = 'pause' | 'resume' | 'stop'

export type CampaignLifecycleResult = {
  campaign: GtmCampaign
  version: GtmCampaignVersion
  action: CampaignLifecycleAction
  alreadyInState: boolean
  attemptsChanged: number
  enrollmentsStopped: number
}

const NOT_STARTED_STATES = new Set(['planned', 'rendered', 'reviewed', 'approved', 'claimed', 'paused'])

function targetState(action: CampaignLifecycleAction): string {
  return action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'stopped'
}

function auditAction(action: CampaignLifecycleAction): string {
  return action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'stopped'
}

function transitionAllowed(current: string, action: CampaignLifecycleAction): boolean {
  if (action === 'pause') return current === 'active'
  if (action === 'resume') return current === 'paused'
  return current === 'approved' || current === 'active' || current === 'paused'
}

export async function transitionCampaignLifecycle(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: {
    campaignId: string
    expectedContentHash: string
    action: CampaignLifecycleAction
  },
  deps: { clock?: Clock } = {},
): Promise<CampaignLifecycleResult> {
  const now = deps.clock?.now() ?? new Date()
  return em.transactional(async (tem) => {
    const campaign = await tem.findOne(
      GtmCampaign,
      {
        id: input.campaignId,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        deletedAt: null,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (!campaign) throw new GtmExecutionError('campaign_not_found', 'Campaign not found')
    if (!campaign.currentVersionId) {
      throw new GtmExecutionError('not_approved', 'Campaign has no approved version')
    }
    const version = await tem.findOne(GtmCampaignVersion, {
      id: campaign.currentVersionId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
    })
    if (!version?.approvedAt || version.invalidatedAt) {
      throw new GtmExecutionError('not_approved', 'Campaign has no current valid approval')
    }
    if (
      input.expectedContentHash !== version.contentHash
      || !approvalEnvelopeMatches(version.snapshot, version.contentHash)
    ) {
      throw new GtmExecutionError('stale_approval', 'Campaign approval changed; refresh before controlling it')
    }
    const target = targetState(input.action)
    if (campaign.status === target) {
      return {
        campaign,
        version,
        action: input.action,
        alreadyInState: true,
        attemptsChanged: 0,
        enrollmentsStopped: 0,
      }
    }
    if (!transitionAllowed(campaign.status, input.action)) {
      throw new GtmExecutionError(
        'invalid_state',
        `Campaign status '${campaign.status}' cannot ${input.action}`,
      )
    }
    const versions = await tem.find(GtmCampaignVersion, {
      campaignId: campaign.id,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
    })
    const controlledVersionIds = input.action === 'stop'
      ? versions.map((row) => row.id)
      : [version.id]
    const attempts = await tem.find(GtmSendAttempt, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      campaignVersionId: { $in: controlledVersionIds },
      deletedAt: null,
    })
    let attemptsChanged = 0
    for (const attempt of attempts) {
      if (input.action === 'pause' && (attempt.state === 'approved' || attempt.state === 'claimed')) {
        attempt.state = 'paused'
      } else if (input.action === 'resume' && attempt.state === 'paused') {
        attempt.state = 'approved'
      } else if (input.action === 'stop' && NOT_STARTED_STATES.has(attempt.state)) {
        attempt.state = 'failed'
        attempt.failureReason = 'campaign_stopped'
        attempt.failedAt = now
      } else {
        continue
      }
      attempt.claimToken = null
      attempt.claimExpiresAt = null
      attempt.capacitySlotKey = null
      attempt.fence += 1
      attempt.updatedAt = now
      tem.persist(attempt)
      attemptsChanged += 1
    }
    let enrollmentsStopped = 0
    if (input.action === 'stop') {
      const enrollments = await tem.find(GtmEnrollment, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        campaignId: campaign.id,
        status: 'active',
        deletedAt: null,
      })
      for (const enrollment of enrollments) {
        enrollment.status = 'stopped'
        enrollment.stopReason = 'campaign_stopped'
        enrollment.stoppedAt = now
        enrollment.updatedAt = now
        tem.persist(enrollment)
      }
      enrollmentsStopped = enrollments.length
    }
    campaign.status = target
    campaign.updatedAt = now
    tem.persist(campaign)
    tem.persist(tem.create(GtmAuditEvent, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      actor: 'user_id',
      actorUserId: ctx.userId,
      action: `gtm.campaign.${auditAction(input.action)}`,
      objectType: 'gtm_campaign',
      objectId: campaign.id,
      objectVersion: version.version,
      requestId: ctx.requestId ?? null,
      metadata: {
        campaign_version_id: version.id,
        content_hash: version.contentHash,
        attempts_changed: attemptsChanged,
        enrollments_stopped: enrollmentsStopped,
      },
    }))
    await tem.flush()
    return {
      campaign,
      version,
      action: input.action,
      alreadyInState: false,
      attemptsChanged,
      enrollmentsStopped,
    }
  })
}
