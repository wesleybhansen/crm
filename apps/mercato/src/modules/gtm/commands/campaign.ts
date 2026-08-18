import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { EntityManager } from '@mikro-orm/postgresql'
import { approveCampaign, type ApproveCampaignResult } from '../lib/campaign/approve'
import type { CampaignEm, GtmCtx } from '../lib/campaign/build'
import { launchCampaign, type ExecutionEm, type LaunchResult } from '../lib/execute/schedule'

type ApproveInput = { campaignId: string; expectedContentHash: string }
type LaunchInput = { campaignId: string; expectedContentHash: string }

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

registerCommand(approveCommand)
registerCommand(launchCommand)
