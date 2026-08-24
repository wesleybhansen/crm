import { FakeEm } from './support/fake-em'
import { fixtureSourceAdapter } from '../adapters/fixture'
import { buildSourcePlan } from '../research/plan'
import { canonicalHash, invalidateCurrentVersion } from '../campaign/approve'
import {
  GtmAuditEvent,
  GtmAutoRefillPolicy,
  GtmCampaign,
  GtmCampaignVersion,
  GtmPlay,
} from '../../data/entities'
import {
  activateAutoRefillPolicy,
  pauseAutoRefillPolicy,
  planAutoRefill,
  type AutoRefillScheduler,
} from '../auto-refill/policy'

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const WORKSPACE = '33333333-3333-4333-8333-333333333333'
const PLAY = '44444444-4444-4444-8444-444444444444'
const CAMPAIGN = '55555555-5555-4555-8555-555555555555'
const VERSION = '66666666-6666-4666-8666-666666666666'
const CRM_USER = '77777777-7777-4777-8777-777777777777'
const NOLI_USER = '88888888-8888-4888-8888-888888888888'
const NOLI_ORG = '99999999-9999-4999-8999-999999999999'

const ctx = {
  organizationId: ORG,
  tenantId: TENANT,
  userId: CRM_USER,
  requestId: 'request-r38',
}

async function seedApprovedCampaign(em: FakeEm) {
  const play = em.create(GtmPlay, {
    id: PLAY,
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    source: 'authored',
    sourcePlayId: null,
    stableImportKey: null,
    marketType: 'b2b',
    audience: 'B2B companies hiring revenue operations leaders',
    signal: 'hiring_activity',
    signalKind: 'hiring_activity',
    geography: 'California, US',
    entityUnit: 'companies',
    executionEligibility: 'executable',
  })
  const plan = buildSourcePlan(play, [fixtureSourceAdapter], {
    targetAccepted: 5,
    maxRawCandidates: 25,
    maxCredits: 250_000,
  })
  if (!plan.ok) throw new Error(plan.reason)
  const snapshot = {
    campaign_id: CAMPAIGN,
    play_id: PLAY,
    settings: {
      daily_cap: 25,
      send_window: { start_hour: 9, end_hour: 17, timezone: 'America/New_York' },
      jitter_minutes: 10,
      sender_mailbox_id: null,
      sender: null,
      duplicate_override: false,
      postal_address: '100 Test Way, Test City, CA 94105',
      auto_refill: {
        enabled: true,
        target_accepted_per_day: 5,
        max_raw_candidates_per_day: 25,
        max_credits_per_day: 250_000,
        run_hour_local: 7,
        plan_hash: plan.planHash,
      },
    },
    recipients: [],
    rendered: [],
  }
  const version = em.create(GtmCampaignVersion, {
    id: VERSION,
    organizationId: ORG,
    tenantId: TENANT,
    campaignId: CAMPAIGN,
    version: 1,
    snapshot,
    contentHash: canonicalHash(snapshot),
    approvedByUserId: CRM_USER,
    approvedAt: new Date('2026-08-24T12:00:00.000Z'),
    invalidatedAt: null,
  })
  const campaign = em.create(GtmCampaign, {
    id: CAMPAIGN,
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    playId: PLAY,
    name: 'Revenue operations hiring signal',
    status: 'approved',
    currentVersionId: VERSION,
    channelMix: {},
    settings: {
      daily_cap: 25,
      send_window: { start_hour: 9, end_hour: 17, timezone: 'America/New_York' },
      jitter_minutes: 10,
      mailbox_connection_id: null,
      duplicate_override: false,
      auto_refill: snapshot.settings.auto_refill,
    },
  })
  em.persist(play)
  em.persist(version)
  em.persist(campaign)
  await em.flush()
  return { play, plan, snapshot, version, campaign }
}

function scheduler(): AutoRefillScheduler & { register: jest.Mock; unregister: jest.Mock } {
  return {
    register: jest.fn(async () => {}),
    unregister: jest.fn(async () => {}),
  }
}

describe('R38 auto-refill policy', () => {
  it('plans without mutation and exposes the campaign timezone', async () => {
    const em = new FakeEm()
    const seeded = await seedApprovedCampaign(em)
    const result = await planAutoRefill(em, ctx, {
      campaignId: CAMPAIGN,
      limits: { targetAccepted: 5, maxRawCandidates: 25, maxCredits: 250_000 },
      runHourLocal: 7,
    }, [fixtureSourceAdapter])
    expect(result.plan.planHash).toBe(seeded.plan.planHash)
    expect(result.timezone).toBe('America/New_York')
    expect(em.table(GtmAutoRefillPolicy)).toHaveLength(0)
  })

  it('binds the approved content/plan and registers an exact weekday schedule', async () => {
    const em = new FakeEm()
    const seeded = await seedApprovedCampaign(em)
    const jobs = scheduler()
    jobs.register.mockImplementation(async () => {
      expect(em.table(GtmAutoRefillPolicy)[0]?.status).toBe('pending_schedule')
    })
    const result = await activateAutoRefillPolicy(em, ctx, {
      campaignId: CAMPAIGN,
      expectedContentHash: seeded.version.contentHash,
      expectedPlanHash: seeded.plan.planHash,
      representedNoliUserId: NOLI_USER,
      noliOrganizationId: NOLI_ORG,
    }, { adapters: [fixtureSourceAdapter], scheduler: jobs })

    expect(result.policy.status).toBe('active')
    expect(result.policy.campaignVersionId).toBe(VERSION)
    expect(result.policy.representedNoliUserId).toBe(NOLI_USER)
    expect(result.policy.noliOrganizationId).toBe(NOLI_ORG)
    expect(result.policy.policyHash).toMatch(/^[a-f0-9]{64}$/)
    expect(jobs.register).toHaveBeenCalledWith(expect.objectContaining({
      id: `gtm-auto-refill-${result.policy.id}`,
      scopeType: 'organization',
      organizationId: ORG,
      tenantId: TENANT,
      scheduleType: 'cron',
      scheduleValue: '0 7 * * 1-5',
      timezone: 'America/New_York',
      targetType: 'queue',
      targetQueue: 'gtm-auto-refill',
      targetPayload: {
        policyId: result.policy.id,
        organizationId: ORG,
        tenantId: TENANT,
      },
      requireFeature: 'gtm.launch',
      sourceModule: 'gtm',
      isEnabled: true,
    }))
    expect(em.table(GtmAuditEvent).map((event) => event.action)).toEqual(expect.arrayContaining([
      'gtm.auto_refill.activation_requested',
      'gtm.auto_refill.activated',
    ]))
  })

  it('fails stale content or provider-plan drift before scheduler registration', async () => {
    const em = new FakeEm()
    const seeded = await seedApprovedCampaign(em)
    const jobs = scheduler()
    await expect(activateAutoRefillPolicy(em, ctx, {
      campaignId: CAMPAIGN,
      expectedContentHash: 'f'.repeat(64),
      expectedPlanHash: seeded.plan.planHash,
      representedNoliUserId: NOLI_USER,
      noliOrganizationId: NOLI_ORG,
    }, { adapters: [fixtureSourceAdapter], scheduler: jobs })).rejects.toMatchObject({ code: 'stale_campaign' })
    const changedAdapter = {
      ...fixtureSourceAdapter,
      descriptor: {
        ...fixtureSourceAdapter.descriptor,
        cost_model: { ...fixtureSourceAdapter.descriptor.cost_model, price_version: 'changed' },
      },
    }
    await expect(activateAutoRefillPolicy(em, ctx, {
      campaignId: CAMPAIGN,
      expectedContentHash: seeded.version.contentHash,
      expectedPlanHash: seeded.plan.planHash,
      representedNoliUserId: NOLI_USER,
      noliOrganizationId: NOLI_ORG,
    }, { adapters: [changedAdapter], scheduler: jobs })).rejects.toMatchObject({ code: 'plan_changed' })
    expect(jobs.register).not.toHaveBeenCalled()
  })

  it('changes database status before unregistering a schedule', async () => {
    const em = new FakeEm()
    const seeded = await seedApprovedCampaign(em)
    const jobs = scheduler()
    const activated = await activateAutoRefillPolicy(em, ctx, {
      campaignId: CAMPAIGN,
      expectedContentHash: seeded.version.contentHash,
      expectedPlanHash: seeded.plan.planHash,
      representedNoliUserId: NOLI_USER,
      noliOrganizationId: NOLI_ORG,
    }, { adapters: [fixtureSourceAdapter], scheduler: jobs })
    jobs.unregister.mockImplementation(async () => {
      expect(em.table(GtmAutoRefillPolicy)[0]?.status).toBe('paused')
    })
    const paused = await pauseAutoRefillPolicy(em, ctx, CAMPAIGN, jobs)
    expect(paused.policy.status).toBe('paused')
    expect(jobs.unregister).toHaveBeenCalledWith(activated.policy.scheduledJobId)
  })

  it('fences the standing policy when its approved campaign version is invalidated', async () => {
    const em = new FakeEm()
    const seeded = await seedApprovedCampaign(em)
    const activated = await activateAutoRefillPolicy(em, ctx, {
      campaignId: CAMPAIGN,
      expectedContentHash: seeded.version.contentHash,
      expectedPlanHash: seeded.plan.planHash,
      representedNoliUserId: NOLI_USER,
      noliOrganizationId: NOLI_ORG,
    }, { adapters: [fixtureSourceAdapter], scheduler: scheduler() })
    const activeFence = activated.policy.fence

    await invalidateCurrentVersion(em, ctx, CAMPAIGN, 'template_edited')

    const policy = em.table(GtmAutoRefillPolicy)[0]
    expect(policy.status).toBe('blocked')
    expect(policy.blockedReason).toBe('campaign_version_invalidated')
    expect(policy.fence).toBe(activeFence + 1)
  })
})
