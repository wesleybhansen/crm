import { EmailConnection } from '../../../email/data/schema'
import { GtmAuditEvent } from '../../data/entities'
import {
  createCampaign,
  parseStoredAiDrafts,
  parseStoredMessageOverrides,
} from '../campaign/build'
import { approveCampaign, computeDraftState } from '../campaign/approve'
import {
  listCampaignSenders,
  updateCampaignSequence,
  updateCampaignSettings,
} from '../campaign/draft-config'
import { FakeEm } from './support/fake-em'
import {
  ctx,
  ORG,
  seedCandidate,
  seedPlay,
  seedRun,
  TENANT,
  USER,
  WORKSPACE,
} from './support/campaign-fixtures'

async function setup() {
  const em = new FakeEm()
  const play = await seedPlay(em)
  const run = await seedRun(em, play)
  const candidate = await seedCandidate(em, run)
  const { campaign } = await createCampaign(em, ctx, {
    workspaceId: WORKSPACE,
    playId: play.id,
    name: 'Editable campaign fixture',
    channelMix: { emails: 3, linkedin: true },
  })
  return { em, campaign, candidate }
}

function seedSender(
  em: FakeEm,
  overrides: Partial<EmailConnection> = {},
): EmailConnection {
  const sender = em.create(EmailConnection, {
    organizationId: ORG,
    tenantId: TENANT,
    userId: USER,
    provider: 'gmail',
    emailAddress: 'owner@fixture.example',
    purpose: null,
    isPrimary: true,
    isActive: true,
    deletedAt: null,
    updatedAt: new Date('2026-08-24T00:00:00.000Z'),
    ...overrides,
  })
  em.persist(sender)
  return sender
}

describe('editable campaign sequence', () => {
  it('changes canonical timing and prunes removed-step AI and manual copy', async () => {
    const { em, campaign, candidate } = await setup()
    campaign.channelMix = {
      ...((campaign.channelMix ?? {}) as Record<string, unknown>),
      ai_drafts: {
        [candidate.id]: {
          subject: 'First AI subject',
          body_text: 'First AI copy remains grounded in the synthetic signal and offers one specific useful next step for the recipient.',
          provenance: { author: 'agent' },
          step_key: 'email_1',
          step_order: 1,
          steps: {
            email_1: {
              subject: 'First AI subject',
              body_text: 'First AI copy remains grounded in the synthetic signal and offers one specific useful next step for the recipient.',
              provenance: { author: 'agent' },
              step_key: 'email_1',
              step_order: 1,
            },
            email_3: {
              subject: 'Third AI subject',
              body_text: 'Third AI copy closes the loop with a materially different summary and a clear permission-based next action.',
              provenance: { author: 'agent' },
              step_key: 'email_3',
              step_order: 3,
            },
          },
        },
      },
      message_overrides: {
        [candidate.id]: {
          email_3: {
            subject: 'Manual third subject',
            body_text: 'Manual third copy offers a distinct grounded example and asks whether a concise outline would be useful this quarter.',
            edited_by_user_id: USER,
            source_message_hash: 'a'.repeat(64),
            step_key: 'email_3',
            step_order: 3,
          },
        },
      },
    }
    const before = await computeDraftState(em, ctx, campaign)

    const result = await updateCampaignSequence(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: before.contentHash,
      sequence: {
        emails: 2,
        email_delay_days: [0, 5],
        linkedin: false,
        x: true,
      },
    })

    expect(result.draft.contentHash).not.toBe(before.contentHash)
    expect(result.draft.steps.map((step) => [step.key, step.delay_days])).toEqual([
      ['email_1', 0],
      ['email_2', 5],
      ['x_dm', 2],
    ])
    expect(parseStoredAiDrafts(campaign)[candidate.id]).toHaveProperty('email_1')
    expect(parseStoredAiDrafts(campaign)[candidate.id]).not.toHaveProperty('email_3')
    expect(parseStoredMessageOverrides(campaign)).toEqual({})
    const audit = em.table(GtmAuditEvent).find((row) => row.action === 'gtm.campaign.sequence_edited')
    expect(audit?.metadata).toMatchObject({ email_steps: 2, email_delay_days: [0, 5], total_steps: 3 })
  })

  it('rejects stale edits and keeps an approved sequence immutable', async () => {
    const { em, campaign } = await setup()
    const draft = await computeDraftState(em, ctx, campaign)
    const input = {
      campaignId: campaign.id,
      expectedContentHash: '0'.repeat(64),
      sequence: { emails: 2, email_delay_days: [0, 4], linkedin: false, x: false },
    }
    await expect(updateCampaignSequence(em, ctx, input)).rejects.toMatchObject({ code: 'stale_draft' })
    await approveCampaign(em, ctx, { campaignId: campaign.id, expectedContentHash: draft.contentHash })
    await expect(updateCampaignSequence(em, ctx, {
      ...input,
      expectedContentHash: draft.contentHash,
    })).rejects.toMatchObject({ code: 'campaign_not_editable' })
  })
})

describe('editable delivery settings and sender catalog', () => {
  it('binds an active personal sender and changes the exact approval envelope', async () => {
    const { em, campaign } = await setup()
    const sender = seedSender(em)
    await em.flush()
    const before = await computeDraftState(em, ctx, campaign)
    const result = await updateCampaignSettings(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: before.contentHash,
      settings: {
        daily_cap: 12,
        send_window: { start_hour: 8, end_hour: 16, timezone: 'America/Los_Angeles' },
        jitter_minutes: 6,
        mailbox_connection_id: sender.id,
        duplicate_override: false,
      },
    })
    expect(result.draft.contentHash).not.toBe(before.contentHash)
    expect(result.draft.settings).toMatchObject({
      daily_cap: 12,
      jitter_minutes: 6,
      mailbox_connection_id: sender.id,
      duplicate_override: false,
    })
    expect(result.draft.sender).toMatchObject({ email_address: 'owner@fixture.example', provider: 'gmail' })
    const audit = em.table(GtmAuditEvent).find((row) => row.action === 'gtm.campaign.settings_edited')
    expect(JSON.stringify(audit?.metadata)).not.toContain('owner@fixture.example')
  })

  it('returns only current-user active personal mailboxes, primary first, without credentials', async () => {
    const em = new FakeEm()
    const secondary = seedSender(em, {
      emailAddress: 'z-secondary@fixture.example',
      isPrimary: false,
      accessToken: 'must-not-leak',
    })
    const primary = seedSender(em, { emailAddress: 'a-primary@fixture.example' })
    seedSender(em, { emailAddress: 'other-user@fixture.example', userId: 'cccccccc-9999-4999-8999-999999999999' })
    seedSender(em, { emailAddress: 'support@fixture.example', purpose: 'customer_service' })
    seedSender(em, { emailAddress: 'inactive@fixture.example', isActive: false })
    await em.flush()

    const senders = await listCampaignSenders(em, ctx)
    expect(senders.map((sender) => sender.id)).toEqual([primary.id, secondary.id])
    expect(senders[0]).toEqual({
      id: primary.id,
      provider: 'gmail',
      email_address: 'a-primary@fixture.example',
      is_primary: true,
      updated_at: '2026-08-24T00:00:00.000Z',
    })
    expect(JSON.stringify(senders)).not.toContain('must-not-leak')
  })

  it('rejects a mailbox outside the represented user scope', async () => {
    const { em, campaign } = await setup()
    const sender = seedSender(em, { userId: 'cccccccc-9999-4999-8999-999999999999' })
    await em.flush()
    const draft = await computeDraftState(em, ctx, campaign)
    await expect(updateCampaignSettings(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: draft.contentHash,
      settings: {
        daily_cap: 10,
        send_window: { start_hour: 9, end_hour: 17, timezone: 'America/Los_Angeles' },
        jitter_minutes: 5,
        mailbox_connection_id: sender.id,
        duplicate_override: false,
      },
    })).rejects.toMatchObject({ code: 'sender_changed' })
  })
})
