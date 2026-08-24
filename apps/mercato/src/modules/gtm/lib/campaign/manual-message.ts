import { LockMode } from '@mikro-orm/core'
import {
  GtmCampaignError,
  parseStoredMessageOverrides,
  type CampaignEm,
  type GtmCtx,
} from './build'
import {
  computeDraftState,
  type CampaignDraftState,
} from './approve'
import {
  messagesAreMateriallyDistinct,
  renderManualOverrideForCandidate,
  type RenderedPreview,
} from './render'
import { GtmAuditEvent, GtmCampaign } from '../../data/entities'

export type UpdateManualMessageInput = {
  campaignId: string
  candidateId: string
  stepKey: string
  expectedContentHash: string
  expectedMessageHash: string
  subject: string
  bodyText: string
}

export type UpdateManualMessageResult = {
  campaign: GtmCampaign
  draft: CampaignDraftState
  message: RenderedPreview
  previousMessageHash: string
}

function normalizeManualCopy(input: Pick<UpdateManualMessageInput, 'subject' | 'bodyText'>) {
  const subject = input.subject.trim()
  const bodyText = input.bodyText.replace(/\r\n?/g, '\n').trim()
  if (!subject || subject.length > 500 || !bodyText || bodyText.length > 20_000) {
    throw new GtmCampaignError('invalid_message', 'Subject and message body are required and must fit the supported limits')
  }
  const combined = `${subject}\n${bodyText}`
  if (
    /[{}]/.test(combined)
    || /\[\[|\]\]/.test(combined)
    || /\n\s*--\s*\n/.test(bodyText)
    || /\bunsubscribe\s*:/i.test(bodyText)
  ) {
    throw new GtmCampaignError('invalid_message', 'Message copy cannot contain template or compliance-footer tokens')
  }
  return { subject, bodyText }
}

export async function updateManualMessage(
  em: CampaignEm,
  ctx: GtmCtx,
  input: UpdateManualMessageInput,
): Promise<UpdateManualMessageResult> {
  const copy = normalizeManualCopy(input)
  let previousMessageHash = ''
  const campaign = await em.transactional(async (tem) => {
    const row = await tem.findOne(GtmCampaign, {
      id: input.campaignId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    if (!row) throw new GtmCampaignError('campaign_not_found', 'Campaign not found')
    if (row.status !== 'draft' || row.currentVersionId) {
      throw new GtmCampaignError(
        'campaign_not_editable',
        'Invalidate the approved version before editing its message copy',
      )
    }
    const draft = await computeDraftState(tem, ctx, row)
    if (draft.contentHash !== input.expectedContentHash) {
      throw new GtmCampaignError('stale_draft', 'Campaign draft changed; reload before editing')
    }
    const current = draft.rendered.find(
      (message) => message.candidateId === input.candidateId && message.stepKey === input.stepKey,
    )
    if (!current) {
      throw new GtmCampaignError('message_not_found', 'Campaign message not found')
    }
    if (current.contentHash !== input.expectedMessageHash) {
      throw new GtmCampaignError('stale_draft', 'Campaign message changed; reload before editing')
    }
    const step = draft.steps.find(
      (candidateStep) => candidateStep.key === input.stepKey
        && candidateStep.channel === 'email'
        && candidateStep.mode === 'automated_email',
    )
    if (!step) throw new GtmCampaignError('message_not_found', 'Campaign message not found')

    const prospective = renderManualOverrideForCandidate(
      { subject: copy.subject, body_text: copy.bodyText },
      input.candidateId,
      draft.postalAddress,
      step,
    )
    if (prospective.qualityIssues.length > 0) {
      throw new GtmCampaignError(
        'message_review_required',
        `Message needs review: ${prospective.qualityIssues.join(', ')}`,
      )
    }
    const otherSteps = draft.rendered.filter(
      (message) => message.candidateId === input.candidateId && message.stepKey !== input.stepKey,
    )
    if (otherSteps.some((message) => !messagesAreMateriallyDistinct(prospective.bodyText, message.bodyText))) {
      throw new GtmCampaignError(
        'message_review_required',
        'Each automated email step must contain materially distinct copy',
      )
    }

    previousMessageHash = current.contentHash
    const raw = (row.channelMix ?? {}) as Record<string, unknown>
    const overrides = parseStoredMessageOverrides(row)
    row.channelMix = {
      ...raw,
      message_overrides: {
        ...overrides,
        [input.candidateId]: {
          ...(overrides[input.candidateId] ?? {}),
          [input.stepKey]: {
            subject: copy.subject,
            body_text: copy.bodyText,
            edited_by_user_id: ctx.userId,
            source_message_hash: current.contentHash,
            step_key: input.stepKey,
            step_order: step.order,
          },
        },
      },
    }
    tem.persist(row)
    tem.persist(tem.create(GtmAuditEvent, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      actor: 'user_id',
      actorUserId: ctx.userId,
      action: 'gtm.campaign.message_edited',
      objectType: 'gtm_campaign',
      objectId: row.id,
      requestId: ctx.requestId ?? null,
      metadata: {
        candidate_id: input.candidateId,
        step_key: input.stepKey,
        source_draft_hash: draft.contentHash,
        previous_message_hash: current.contentHash,
        next_message_hash: prospective.contentHash,
        word_count: prospective.wordCount,
      },
    }))
    await tem.flush()
    return row
  })

  const draft = await computeDraftState(em, ctx, campaign)
  const message = draft.rendered.find(
    (row) => row.candidateId === input.candidateId && row.stepKey === input.stepKey,
  )
  if (!message) throw new GtmCampaignError('message_not_found', 'Campaign message not found')
  return { campaign, draft, message, previousMessageHash }
}
