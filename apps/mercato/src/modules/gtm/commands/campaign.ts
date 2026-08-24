import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { EntityManager } from '@mikro-orm/postgresql'
import { approveCampaign, type ApproveCampaignResult } from '../lib/campaign/approve'
import type { CampaignEm, GtmCtx } from '../lib/campaign/build'
import {
  updateManualMessage,
  type UpdateManualMessageInput,
  type UpdateManualMessageResult,
} from '../lib/campaign/manual-message'
import {
  updateCampaignSequence,
  updateCampaignSettings,
  type UpdateCampaignDraftResult,
  type UpdateCampaignSequenceInput,
  type UpdateCampaignSettingsInput,
} from '../lib/campaign/draft-config'
import { launchCampaign, type ExecutionEm, type LaunchResult } from '../lib/execute/schedule'
import {
  transitionCampaignLifecycle,
  type CampaignLifecycleAction,
  type CampaignLifecycleResult,
} from '../lib/execute/lifecycle'

type ApproveInput = { campaignId: string; expectedContentHash: string }
type LaunchInput = { campaignId: string; expectedContentHash: string }
export type CampaignLifecycleCommandInput = {
  campaignId: string
  expectedContentHash: string
}

function resolveGtmContext(ctx: CommandRuntimeContext): GtmCtx {
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  const tenantId = ctx.auth?.tenantId ?? null
  const userId = ctx.auth?.userId ?? ctx.auth?.sub ?? null
  if (!organizationId || !tenantId || !userId) {
    throw new Error('GTM command requires an exact user, organization, and tenant scope')
  }
  return {
    organizationId,
    tenantId,
    userId,
    requestId: ctx.request?.headers.get('x-request-id') ?? null,
  }
}

const approveCommand: CommandHandler<ApproveInput, ApproveCampaignResult> = {
  id: 'gtm.campaigns.approve',
  async execute(input, runtime) {
    const em = runtime.container.resolve('em') as EntityManager as unknown as CampaignEm
    return approveCampaign(em, resolveGtmContext(runtime), input)
  },
  buildLog: ({ input, result }) => ({
    actionLabel: 'Approve GTM campaign envelope',
    resourceKind: 'gtm.campaign',
    resourceId: input.campaignId,
    organizationId: result.campaign.organizationId,
    tenantId: result.campaign.tenantId,
    snapshotAfter: {
      version_id: result.version.id,
      content_hash: result.version.contentHash,
      already_approved: result.alreadyApproved,
    },
  }),
}

const updateMessageCommand: CommandHandler<UpdateManualMessageInput, UpdateManualMessageResult> = {
  id: 'gtm.campaigns.update-message',
  async execute(input, runtime) {
    const em = runtime.container.resolve('em') as EntityManager as unknown as CampaignEm
    return updateManualMessage(em, resolveGtmContext(runtime), input)
  },
  buildLog: ({ input, result }) => ({
    actionLabel: 'Edit one GTM campaign message',
    resourceKind: 'gtm.campaign',
    resourceId: input.campaignId,
    organizationId: result.campaign.organizationId,
    tenantId: result.campaign.tenantId,
    snapshotAfter: {
      candidate_id: input.candidateId,
      step_key: input.stepKey,
      previous_message_hash: result.previousMessageHash,
      message_hash: result.message.contentHash,
      draft_hash: result.draft.contentHash,
    },
  }),
}

const updateSequenceCommand: CommandHandler<UpdateCampaignSequenceInput, UpdateCampaignDraftResult> = {
  id: 'gtm.campaigns.update-sequence',
  async execute(input, runtime) {
    const em = runtime.container.resolve('em') as EntityManager as unknown as CampaignEm
    return updateCampaignSequence(em, resolveGtmContext(runtime), input)
  },
  buildLog: ({ input, result }) => ({
    actionLabel: 'Edit GTM campaign sequence',
    resourceKind: 'gtm.campaign',
    resourceId: input.campaignId,
    organizationId: result.campaign.organizationId,
    tenantId: result.campaign.tenantId,
    snapshotAfter: {
      email_steps: input.sequence.emails,
      email_delay_days: input.sequence.email_delay_days,
      linkedin: input.sequence.linkedin,
      x: input.sequence.x,
      draft_hash: result.draft.contentHash,
    },
  }),
}

const updateSettingsCommand: CommandHandler<UpdateCampaignSettingsInput, UpdateCampaignDraftResult> = {
  id: 'gtm.campaigns.update-settings',
  async execute(input, runtime) {
    const em = runtime.container.resolve('em') as EntityManager as unknown as CampaignEm
    return updateCampaignSettings(em, resolveGtmContext(runtime), input)
  },
  buildLog: ({ input, result }) => ({
    actionLabel: 'Edit GTM campaign delivery settings',
    resourceKind: 'gtm.campaign',
    resourceId: input.campaignId,
    organizationId: result.campaign.organizationId,
    tenantId: result.campaign.tenantId,
    snapshotAfter: {
      daily_cap: result.draft.settings.daily_cap,
      send_window: result.draft.settings.send_window,
      jitter_minutes: result.draft.settings.jitter_minutes,
      mailbox_connection_id: result.draft.settings.mailbox_connection_id,
      duplicate_override: result.draft.settings.duplicate_override,
      auto_refill: {
        enabled: result.draft.settings.auto_refill.enabled,
        target_accepted_per_day: result.draft.settings.auto_refill.target_accepted_per_day,
        max_raw_candidates_per_day: result.draft.settings.auto_refill.max_raw_candidates_per_day,
        max_credits_per_day: result.draft.settings.auto_refill.max_credits_per_day,
        run_hour_local: result.draft.settings.auto_refill.run_hour_local,
        plan_hash: result.draft.settings.auto_refill.plan_hash,
      },
      draft_hash: result.draft.contentHash,
    },
  }),
}

const launchCommand: CommandHandler<LaunchInput, LaunchResult> = {
  id: 'gtm.campaigns.launch',
  async execute(input, runtime) {
    const em = runtime.container.resolve('em') as EntityManager as unknown as ExecutionEm
    return launchCampaign(em, resolveGtmContext(runtime), input)
  },
  buildLog: ({ input, result }) => ({
    actionLabel: 'Launch approved GTM campaign envelope',
    resourceKind: 'gtm.campaign',
    resourceId: input.campaignId,
    organizationId: result.campaign.organizationId,
    tenantId: result.campaign.tenantId,
    snapshotAfter: {
      version_id: result.version.id,
      content_hash: result.version.contentHash,
      attempts: result.attempts.length,
      already_launched: result.alreadyLaunched,
    },
  }),
}

function lifecycleCommand(
  action: CampaignLifecycleAction,
): CommandHandler<CampaignLifecycleCommandInput, CampaignLifecycleResult> {
  return {
    id: `gtm.campaigns.${action}`,
    async execute(input, runtime) {
      const em = runtime.container.resolve('em') as EntityManager as unknown as ExecutionEm
      return transitionCampaignLifecycle(em, resolveGtmContext(runtime), { ...input, action })
    },
    buildLog: ({ result }) => ({
      actionLabel: `${action[0]?.toUpperCase()}${action.slice(1)} GTM campaign`,
      resourceKind: 'gtm.campaign',
      resourceId: result.campaign.id,
      organizationId: result.campaign.organizationId,
      tenantId: result.campaign.tenantId,
      snapshotAfter: {
        version_id: result.version.id,
        content_hash: result.version.contentHash,
        status: result.campaign.status,
        attempts_changed: result.attemptsChanged,
        enrollments_stopped: result.enrollmentsStopped,
        enrollments_completed: result.enrollmentsCompleted,
        already_in_state: result.alreadyInState,
      },
    }),
  }
}

registerCommand(approveCommand)
registerCommand(updateMessageCommand)
registerCommand(updateSequenceCommand)
registerCommand(updateSettingsCommand)
registerCommand(launchCommand)
registerCommand(lifecycleCommand('pause'))
registerCommand(lifecycleCommand('resume'))
registerCommand(lifecycleCommand('stop'))
registerCommand(lifecycleCommand('complete'))
