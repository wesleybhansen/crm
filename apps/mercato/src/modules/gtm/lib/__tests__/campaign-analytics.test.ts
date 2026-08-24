import crypto from 'crypto'
import {
  GtmCampaign,
  GtmEnrollment,
  GtmReply,
  GtmSendAttempt,
} from '../../data/entities'
import { campaignFeatureForOp } from '../authorize'
import {
  getCampaignAnalytics,
  GTM_CAMPAIGN_ANALYTICS_LIMIT,
} from '../campaign/analytics'
import { gtmCampaignsBodySchema } from '../../data/validators'
import { ORG, OTHER_ORG, TENANT, WORKSPACE } from './support/campaign-fixtures'
import { FakeEm } from './support/fake-em'

const OTHER_TENANT = 'bbbbbbbb-9999-4999-8999-999999999999'
const OTHER_WORKSPACE = 'cccccccc-9999-4999-8999-999999999999'
const VERSION = 'dddddddd-1111-4111-8111-111111111111'
const OLD_VERSION = 'dddddddd-2222-4222-8222-222222222222'
const ctx = { organizationId: ORG, tenantId: TENANT }

function persist<T extends object>(em: FakeEm, entity: T): T {
  em.persist(entity)
  return entity
}

function campaign(
  em: FakeEm,
  overrides: Partial<GtmCampaign> = {},
): GtmCampaign {
  return persist(em, em.create(GtmCampaign, {
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    playId: 'eeeeeeee-1111-4111-8111-111111111111',
    name: 'Synthetic campaign',
    status: 'active',
    currentVersionId: VERSION,
    createdAt: new Date('2026-08-24T12:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  }))
}

function enrollment(
  em: FakeEm,
  campaignId: string,
  candidateId: string,
  overrides: Partial<GtmEnrollment> = {},
): GtmEnrollment {
  return persist(em, em.create(GtmEnrollment, {
    organizationId: ORG,
    tenantId: TENANT,
    campaignId,
    campaignVersionId: VERSION,
    candidateId,
    status: 'active',
    deletedAt: null,
    ...overrides,
  }))
}

function attempt(
  em: FakeEm,
  enrollmentId: string,
  state: string,
  overrides: Partial<GtmSendAttempt> = {},
): GtmSendAttempt {
  return persist(em, em.create(GtmSendAttempt, {
    organizationId: ORG,
    tenantId: TENANT,
    enrollmentId,
    stepId: crypto.randomUUID(),
    campaignVersionId: VERSION,
    state,
    idempotencyKey: crypto.randomUUID(),
    deletedAt: null,
    ...overrides,
  }))
}

function reply(
  em: FakeEm,
  enrollmentId: string,
  classification: string | null,
  overrides: Partial<GtmReply> = {},
): GtmReply {
  return persist(em, em.create(GtmReply, {
    organizationId: ORG,
    tenantId: TENANT,
    enrollmentId,
    channel: 'email',
    direction: 'inbound',
    eventKind: 'human_reply',
    classification,
    deletedAt: null,
    ...overrides,
  }))
}

describe('campaign analytics', () => {
  it('separates acceptance, delivery, delivery failures, and unique human outcomes', async () => {
    const em = new FakeEm()
    const currentCampaign = campaign(em)
    const recipientA = enrollment(em, currentCampaign.id, crypto.randomUUID())
    const recipientB = enrollment(em, currentCampaign.id, crypto.randomUUID(), { status: 'stopped' })
    const oldRecipient = enrollment(em, currentCampaign.id, crypto.randomUUID(), {
      campaignVersionId: OLD_VERSION,
    })

    const acceptedAttempt = attempt(em, recipientA.id, 'accepted', {
      acceptedAt: new Date('2026-08-24T12:05:00.000Z'),
      providerReceipt: { address: 'must-not-leak@example.test' },
    })
    attempt(em, recipientA.id, 'delivered', {
      acceptedAt: new Date('2026-08-24T12:06:00.000Z'),
      deliveredAt: new Date('2026-08-24T12:07:00.000Z'),
    })
    const bouncedAttempt = attempt(em, recipientB.id, 'bounced', {
      acceptedAt: new Date('2026-08-24T12:08:00.000Z'),
      bouncedAt: new Date('2026-08-24T12:09:00.000Z'),
    })
    const oldAttempt = attempt(em, oldRecipient.id, 'delivered', {
      campaignVersionId: OLD_VERSION,
      deliveredAt: new Date('2026-08-23T12:00:00.000Z'),
    })

    reply(em, recipientA.id, 'interested', { sendAttemptId: acceptedAttempt.id })
    reply(em, recipientA.id, 'referral', { sendAttemptId: acceptedAttempt.id })
    reply(em, recipientB.id, null, { sendAttemptId: bouncedAttempt.id })
    reply(em, recipientB.id, 'interested', {
      eventKind: 'delivery_status',
      sendAttemptId: bouncedAttempt.id,
    })
    reply(em, oldRecipient.id, 'interested', { sendAttemptId: oldAttempt.id })
    await em.flush()

    const result = await getCampaignAnalytics(em, ctx, WORKSPACE)
    expect(result.scope).toBe('current_campaign_versions')
    expect(result.campaigns).toHaveLength(1)
    expect(result.campaigns[0]).toMatchObject({
      recipient_enrollments: 2,
      active_enrollments: 1,
      stopped_enrollments: 1,
      provider_accepted_recipients: 2,
      confirmed_delivered_recipients: 1,
      bounced_recipients: 1,
      complained_recipients: 0,
      human_reply_recipients: 2,
      positive_reply_recipients: 1,
      unclassified_human_reply_recipients: 1,
      send_attempts: 3,
      human_reply_events: 3,
    })
    expect(result.campaigns[0].attempts_by_state).toMatchObject({ accepted: 1, delivered: 1, bounced: 1 })
    expect(result.campaigns[0].reply_events_by_classification).toMatchObject({
      interested: 1,
      referral: 1,
      unclassified: 1,
    })
    expect(result.totals).toMatchObject({
      campaigns: 1,
      provider_accepted_recipients: 2,
      confirmed_delivered_recipients: 1,
      human_reply_recipients: 2,
      positive_reply_recipients: 1,
    })
    expect(JSON.stringify(result)).not.toContain('must-not-leak@example.test')
  })

  it('uses only the exact org, tenant, workspace, live rows, and current version', async () => {
    const em = new FakeEm()
    const mine = campaign(em)
    enrollment(em, mine.id, crypto.randomUUID())

    const foreignOrg = campaign(em, { organizationId: OTHER_ORG, name: 'Foreign org' })
    enrollment(em, foreignOrg.id, crypto.randomUUID(), { organizationId: OTHER_ORG })
    const foreignTenant = campaign(em, { tenantId: OTHER_TENANT, name: 'Foreign tenant' })
    enrollment(em, foreignTenant.id, crypto.randomUUID(), { tenantId: OTHER_TENANT })
    campaign(em, { workspaceId: OTHER_WORKSPACE, name: 'Other workspace' })
    campaign(em, { deletedAt: new Date(), name: 'Deleted campaign' })
    await em.flush()

    const result = await getCampaignAnalytics(em, ctx, WORKSPACE)
    expect(result.campaigns.map((row) => row.campaign_id)).toEqual([mine.id])
    expect(result.totals.recipient_enrollments).toBe(1)
  })

  it('bounds the newest campaign page and reports truncation honestly', async () => {
    const em = new FakeEm()
    for (let index = 0; index < GTM_CAMPAIGN_ANALYTICS_LIMIT + 3; index += 1) {
      campaign(em, { createdAt: new Date(Date.UTC(2026, 7, 24, 0, index)) })
    }
    await em.flush()

    const result = await getCampaignAnalytics(em, ctx, WORKSPACE)
    expect(result.campaigns).toHaveLength(GTM_CAMPAIGN_ANALYTICS_LIMIT)
    expect(result.truncated).toBe(true)
    expect(result.campaign_limit).toBe(GTM_CAMPAIGN_ANALYTICS_LIMIT)
    expect(result.campaigns[0].created_at.getTime()).toBeGreaterThan(
      result.campaigns[result.campaigns.length - 1].created_at.getTime(),
    )
  })

  it('validates analytics as a bounded view operation', () => {
    expect(gtmCampaignsBodySchema.safeParse({
      op: 'analytics',
      noliUserId: 'user-1',
      workspaceId: WORKSPACE,
    }).success).toBe(true)
    expect(gtmCampaignsBodySchema.safeParse({
      op: 'analytics',
      noliUserId: 'user-1',
    }).success).toBe(false)
    expect(campaignFeatureForOp('analytics')).toBe('gtm.view')
  })
})
