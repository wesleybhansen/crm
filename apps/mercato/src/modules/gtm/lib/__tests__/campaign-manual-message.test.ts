import { LockMode } from '@mikro-orm/core'
import { createCampaign, parseStoredMessageOverrides } from '../campaign/build'
import { approveCampaign, computeDraftState } from '../campaign/approve'
import { updateManualMessage } from '../campaign/manual-message'
import { GtmAuditEvent } from '../../data/entities'
import { FakeEm } from './support/fake-em'
import { ctx, seedCandidate, seedPlay, seedRun, WORKSPACE } from './support/campaign-fixtures'

async function setup() {
  const em = new FakeEm()
  const play = await seedPlay(em)
  const run = await seedRun(em, play)
  const candidate = await seedCandidate(em, run)
  const { campaign } = await createCampaign(em, ctx, {
    workspaceId: WORKSPACE,
    playId: play.id,
    name: 'Manual message fixture',
    channelMix: { emails: 2 },
  })
  return { em, campaign, candidate }
}

const SUBJECT = 'A practical next step for Synthetic Co'
const BODY = 'Your current hiring signal suggests the team may benefit from a focused workflow review. I can share a concise example tailored to the operating change you are making this quarter.'

describe('updateManualMessage', () => {
  it('replaces exactly one recipient-by-step artifact and changes the approval hash without a model call', async () => {
    const { em, campaign, candidate } = await setup()
    const findOne = jest.spyOn(em, 'findOne')
    campaign.channelMix = {
      ...((campaign.channelMix ?? {}) as Record<string, unknown>),
      ai_drafts: {
        [candidate.id]: {
          subject: 'Existing AI follow-up',
          body_text: 'This existing AI follow-up offers a different grounded example and a simple next action for the synthetic recipient today.',
          provenance: { author: 'agent' },
          step_key: 'email_2',
          step_order: 2,
        },
      },
    }
    const before = await computeDraftState(em, ctx, campaign)
    const target = before.rendered.find((row) => row.candidateId === candidate.id && row.stepKey === 'email_2')!
    const untouched = before.rendered.find((row) => row.candidateId === candidate.id && row.stepKey === 'email_1')!
    expect(target.provenance).toBe('ai')

    const result = await updateManualMessage(em, ctx, {
      campaignId: campaign.id,
      candidateId: candidate.id,
      stepKey: 'email_2',
      expectedContentHash: before.contentHash,
      expectedMessageHash: target.contentHash,
      subject: SUBJECT,
      bodyText: BODY,
    })

    expect(result.previousMessageHash).toBe(target.contentHash)
    expect(result.draft.contentHash).not.toBe(before.contentHash)
    expect(result.message).toMatchObject({
      candidateId: candidate.id,
      stepKey: 'email_2',
      subject: SUBJECT,
      bodyTextCore: BODY,
      provenance: 'manual',
      needsReview: false,
      qualityIssues: [],
    })
    expect(result.draft.rendered.find((row) => row.stepKey === 'email_1')?.contentHash).toBe(untouched.contentHash)
    expect(parseStoredMessageOverrides(campaign)[candidate.id]?.email_2).toMatchObject({
      subject: SUBJECT,
      body_text: BODY,
      edited_by_user_id: ctx.userId,
      source_message_hash: target.contentHash,
    })
    expect((findOne.mock.calls as unknown[][]).some(
      (call) => (call[2] as { lockMode?: LockMode } | undefined)?.lockMode === LockMode.PESSIMISTIC_WRITE,
    )).toBe(true)
  })

  it('rejects stale draft or message hashes before persisting an override', async () => {
    const { em, campaign, candidate } = await setup()
    const draft = await computeDraftState(em, ctx, campaign)
    const target = draft.rendered.find((row) => row.stepKey === 'email_2')!

    await expect(updateManualMessage(em, ctx, {
      campaignId: campaign.id,
      candidateId: candidate.id,
      stepKey: 'email_2',
      expectedContentHash: '0'.repeat(64),
      expectedMessageHash: target.contentHash,
      subject: SUBJECT,
      bodyText: BODY,
    })).rejects.toMatchObject({ code: 'stale_draft' })

    await expect(updateManualMessage(em, ctx, {
      campaignId: campaign.id,
      candidateId: candidate.id,
      stepKey: 'email_2',
      expectedContentHash: draft.contentHash,
      expectedMessageHash: '1'.repeat(64),
      subject: SUBJECT,
      bodyText: BODY,
    })).rejects.toMatchObject({ code: 'stale_draft' })
    expect(parseStoredMessageOverrides(campaign)).toEqual({})
  })

  it('keeps an approved version immutable until the user explicitly invalidates it', async () => {
    const { em, campaign, candidate } = await setup()
    const draft = await computeDraftState(em, ctx, campaign)
    const target = draft.rendered.find((row) => row.stepKey === 'email_2')!
    const approved = await approveCampaign(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: draft.contentHash,
    })

    await expect(updateManualMessage(em, ctx, {
      campaignId: campaign.id,
      candidateId: candidate.id,
      stepKey: 'email_2',
      expectedContentHash: draft.contentHash,
      expectedMessageHash: target.contentHash,
      subject: SUBJECT,
      bodyText: BODY,
    })).rejects.toMatchObject({ code: 'campaign_not_editable' })
    expect(approved.version.invalidatedAt).toBeNull()
    expect(approved.version.contentHash).toBe(draft.contentHash)
  })

  it.each([
    ['short copy', 'Only five words live here.'],
    ['template token', `${BODY} {{signal}}`],
    ['compliance token', `${BODY}\n\n--\nUnsubscribe: [[unsubscribe_url]]`],
  ])('rejects %s instead of storing unsafe copy', async (_label, bodyText) => {
    const { em, campaign, candidate } = await setup()
    const draft = await computeDraftState(em, ctx, campaign)
    const target = draft.rendered.find((row) => row.stepKey === 'email_2')!
    await expect(updateManualMessage(em, ctx, {
      campaignId: campaign.id,
      candidateId: candidate.id,
      stepKey: 'email_2',
      expectedContentHash: draft.contentHash,
      expectedMessageHash: target.contentHash,
      subject: SUBJECT,
      bodyText,
    })).rejects.toMatchObject({
      code: bodyText.startsWith('Only') ? 'message_review_required' : 'invalid_message',
    })
    expect(parseStoredMessageOverrides(campaign)).toEqual({})
  })

  it('rejects copy that duplicates another step and writes only redacted audit metadata on success', async () => {
    const { em, campaign, candidate } = await setup()
    const draft = await computeDraftState(em, ctx, campaign)
    const first = draft.rendered.find((row) => row.stepKey === 'email_1')!
    const second = draft.rendered.find((row) => row.stepKey === 'email_2')!
    await expect(updateManualMessage(em, ctx, {
      campaignId: campaign.id,
      candidateId: candidate.id,
      stepKey: 'email_2',
      expectedContentHash: draft.contentHash,
      expectedMessageHash: second.contentHash,
      subject: SUBJECT,
      bodyText: first.bodyTextCore,
    })).rejects.toMatchObject({ code: 'message_review_required' })

    await updateManualMessage(em, ctx, {
      campaignId: campaign.id,
      candidateId: candidate.id,
      stepKey: 'email_2',
      expectedContentHash: draft.contentHash,
      expectedMessageHash: second.contentHash,
      subject: SUBJECT,
      bodyText: BODY,
    })
    const audits = em.table(GtmAuditEvent).filter((row) => row.action === 'gtm.campaign.message_edited')
    expect(audits).toHaveLength(1)
    expect(audits[0].metadata).toMatchObject({
      candidate_id: candidate.id,
      step_key: 'email_2',
      previous_message_hash: second.contentHash,
    })
    const serialized = JSON.stringify(audits[0].metadata)
    expect(serialized).not.toContain(SUBJECT)
    expect(serialized).not.toContain(BODY)
    expect(serialized).not.toContain('@')
  })
})
