import { LockMode } from '@mikro-orm/core'
import { EmailConnection } from '../../../email/data/schema'
import { GtmAuditEvent, GtmCampaign } from '../../data/entities'
import {
  buildEditableSequence,
  GtmCampaignError,
  normalizeSettings,
  parseStoredAiDrafts,
  parseStoredMessageOverrides,
  type CampaignEm,
  type CampaignSequenceInput,
  type CampaignSettingsInput,
  type GtmCtx,
  type StoredAiDraft,
  type StoredAiDraftSequence,
  type StoredMessageOverride,
} from './build'
import { computeDraftState, type CampaignDraftState } from './approve'

export type UpdateCampaignSequenceInput = {
  campaignId: string
  expectedContentHash: string
  sequence: CampaignSequenceInput
}

export type UpdateCampaignSettingsInput = {
  campaignId: string
  expectedContentHash: string
  settings: CampaignSettingsInput
}

export type UpdateCampaignDraftResult = {
  campaign: GtmCampaign
  draft: CampaignDraftState
}

export type CampaignSenderOption = {
  id: string
  provider: string
  email_address: string
  is_primary: boolean
  updated_at: string
}

function assertEditable(campaign: GtmCampaign): void {
  if (campaign.status !== 'draft' || campaign.currentVersionId) {
    throw new GtmCampaignError(
      'campaign_not_editable',
      'Invalidate the approved version before editing its sequence or delivery settings',
    )
  }
}

function keepAiDraftsForSteps(
  campaign: GtmCampaign,
  stepKeys: string[],
): Record<string, StoredAiDraftSequence> {
  const stored = parseStoredAiDrafts(campaign)
  const kept: Record<string, StoredAiDraftSequence> = {}
  for (const [candidateId, drafts] of Object.entries(stored)) {
    const sequence: Record<string, StoredAiDraft> = {}
    for (const stepKey of stepKeys) {
      const draft = drafts[stepKey]
      if (draft) sequence[stepKey] = draft
    }
    const first = stepKeys.map((stepKey) => sequence[stepKey]).find(Boolean)
    if (first) kept[candidateId] = { ...first, steps: sequence }
  }
  return kept
}

function keepManualOverridesForSteps(
  campaign: GtmCampaign,
  stepKeys: string[],
): Record<string, Record<string, StoredMessageOverride>> {
  const allowed = new Set(stepKeys)
  const kept: Record<string, Record<string, StoredMessageOverride>> = {}
  for (const [candidateId, overrides] of Object.entries(parseStoredMessageOverrides(campaign))) {
    const candidate: Record<string, StoredMessageOverride> = {}
    for (const [stepKey, override] of Object.entries(overrides)) {
      if (allowed.has(stepKey)) candidate[stepKey] = override
    }
    if (Object.keys(candidate).length > 0) kept[candidateId] = candidate
  }
  return kept
}

export async function updateCampaignSequence(
  em: CampaignEm,
  ctx: GtmCtx,
  input: UpdateCampaignSequenceInput,
): Promise<UpdateCampaignDraftResult> {
  const steps = buildEditableSequence(input.sequence)
  const emailStepKeys = steps
    .filter((step) => step.channel === 'email' && step.mode === 'automated_email')
    .map((step) => step.key)

  const campaign = await em.transactional(async (tem) => {
    const row = await tem.findOne(GtmCampaign, {
      id: input.campaignId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    if (!row) throw new GtmCampaignError('campaign_not_found', 'Campaign not found')
    assertEditable(row)
    const before = await computeDraftState(tem, ctx, row)
    if (before.contentHash !== input.expectedContentHash) {
      throw new GtmCampaignError('stale_draft', 'Campaign draft changed; reload before editing its sequence')
    }

    const raw = (row.channelMix ?? {}) as Record<string, unknown>
    row.channelMix = {
      ...raw,
      channels: {
        emails: input.sequence.emails,
        linkedin: input.sequence.linkedin,
        x: input.sequence.x,
      },
      steps,
      ai_drafts: keepAiDraftsForSteps(row, emailStepKeys),
      message_overrides: keepManualOverridesForSteps(row, emailStepKeys),
    }
    tem.persist(row)
    tem.persist(tem.create(GtmAuditEvent, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      actor: 'user_id',
      actorUserId: ctx.userId,
      action: 'gtm.campaign.sequence_edited',
      objectType: 'gtm_campaign',
      objectId: row.id,
      requestId: ctx.requestId ?? null,
      metadata: {
        source_draft_hash: before.contentHash,
        email_steps: input.sequence.emails,
        email_delay_days: input.sequence.email_delay_days,
        linkedin: input.sequence.linkedin,
        x: input.sequence.x,
        total_steps: steps.length,
      },
    }))
    await tem.flush()
    return row
  })

  return { campaign, draft: await computeDraftState(em, ctx, campaign) }
}

export async function updateCampaignSettings(
  em: CampaignEm,
  ctx: GtmCtx,
  input: UpdateCampaignSettingsInput,
): Promise<UpdateCampaignDraftResult> {
  const campaign = await em.transactional(async (tem) => {
    const row = await tem.findOne(GtmCampaign, {
      id: input.campaignId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    if (!row) throw new GtmCampaignError('campaign_not_found', 'Campaign not found')
    assertEditable(row)
    const before = await computeDraftState(tem, ctx, row)
    if (before.contentHash !== input.expectedContentHash) {
      throw new GtmCampaignError('stale_draft', 'Campaign draft changed; reload before editing delivery settings')
    }
    // Rolling-deploy compatibility: an older Hub does not know the additive
    // auto_refill block. Preserve it instead of silently disabling a reviewed
    // standing policy when that client edits an unrelated delivery setting.
    const currentSettings = normalizeSettings((row.settings ?? {}) as CampaignSettingsInput)
    const settings = normalizeSettings({
      ...input.settings,
      auto_refill: input.settings.auto_refill ?? currentSettings.auto_refill,
    })
    if (settings.mailbox_connection_id) {
      const sender = await tem.findOne(EmailConnection, {
        id: settings.mailbox_connection_id,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        purpose: null,
        isActive: true,
        deletedAt: null,
      })
      if (!sender) {
        throw new GtmCampaignError('sender_changed', 'The selected sender is not an active personal mailbox')
      }
    }

    row.settings = settings
    tem.persist(row)
    tem.persist(tem.create(GtmAuditEvent, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      actor: 'user_id',
      actorUserId: ctx.userId,
      action: 'gtm.campaign.settings_edited',
      objectType: 'gtm_campaign',
      objectId: row.id,
      requestId: ctx.requestId ?? null,
      metadata: {
        source_draft_hash: before.contentHash,
        daily_cap: settings.daily_cap,
        send_window: settings.send_window,
        jitter_minutes: settings.jitter_minutes,
        mailbox_connection_id: settings.mailbox_connection_id,
        duplicate_override: settings.duplicate_override,
        auto_refill: {
          enabled: settings.auto_refill.enabled,
          target_accepted_per_day: settings.auto_refill.target_accepted_per_day,
          max_raw_candidates_per_day: settings.auto_refill.max_raw_candidates_per_day,
          max_credits_per_day: settings.auto_refill.max_credits_per_day,
          run_hour_local: settings.auto_refill.run_hour_local,
          plan_hash: settings.auto_refill.plan_hash,
        },
      },
    }))
    await tem.flush()
    return row
  })

  return { campaign, draft: await computeDraftState(em, ctx, campaign) }
}

export async function listCampaignSenders(
  em: CampaignEm,
  ctx: GtmCtx,
): Promise<CampaignSenderOption[]> {
  const rows = await em.find(EmailConnection, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    purpose: null,
    isActive: true,
    deletedAt: null,
  }, { limit: 100 })
  return rows
    .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary)
      || left.emailAddress.localeCompare(right.emailAddress))
    .map((row) => ({
      id: row.id,
      provider: row.provider,
      email_address: row.emailAddress,
      is_primary: row.isPrimary,
      updated_at: row.updatedAt.toISOString(),
    }))
}
