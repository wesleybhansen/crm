import type { SourceAdapter, SourceSearchPlan } from '../adapters/types'
import { fixtureSourceAdapter } from '../adapters/fixture'
import { FixtureLedger } from '../credits/ledger'
import { canonicalHash } from '../campaign/approve'
import { buildSourcePlan } from '../research/plan'
import { processAutoRefillCycle } from '../auto-refill/cycle'
import { buildAutoRefillPolicyHash } from '../auto-refill/contract'
import { FakeEm } from './support/fake-em'
import {
  GtmAutoRefillCycle,
  GtmAutoRefillPolicy,
  GtmCampaign,
  GtmCampaignVersion,
  GtmCandidate,
  GtmEnrollment,
  GtmPlay,
  GtmResearchRun,
  GtmSendAttempt,
} from '../../data/entities'

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const WORKSPACE = '33333333-3333-4333-8333-333333333333'
const PLAY = '44444444-4444-4444-8444-444444444444'
const CAMPAIGN = '55555555-5555-4555-8555-555555555555'
const VERSION = '66666666-6666-4666-8666-666666666666'
const CRM_USER = '77777777-7777-4777-8777-777777777777'
const NOLI_USER = '88888888-8888-4888-8888-888888888888'
const NOLI_ORG = '99999999-9999-4999-8999-999999999999'

type SpyAdapter = SourceAdapter & { search: jest.Mock }

function spyAdapter(): SpyAdapter {
  return {
    descriptor: fixtureSourceAdapter.descriptor,
    quote: fixtureSourceAdapter.quote,
    search: jest.fn((plan: SourceSearchPlan) => fixtureSourceAdapter.search(plan)),
  }
}

async function seed(em: FakeEm, adapter: SourceAdapter) {
  const play = em.create(GtmPlay, {
    id: PLAY,
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    source: 'authored',
    marketType: 'b2b',
    audience: 'B2B companies hiring revenue operations leaders',
    signal: 'hiring_activity',
    signalKind: 'hiring_activity',
    geography: 'California, US',
    entityUnit: 'companies',
    executionEligibility: 'executable',
  })
  const plan = buildSourcePlan(play, [adapter], {
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
      auto_refill: {
        enabled: true,
        target_accepted_per_day: 5,
        max_raw_candidates_per_day: 25,
        max_credits_per_day: 250_000,
        run_hour_local: 7,
        plan_hash: plan.planHash,
      },
    },
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
    name: 'Auto-refill campaign',
    status: 'approved',
    currentVersionId: VERSION,
  })
  const policyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const material = {
    policyId,
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    playId: PLAY,
    campaignId: CAMPAIGN,
    campaignVersionId: VERSION,
    representedNoliUserId: NOLI_USER,
    noliOrganizationId: NOLI_ORG,
    requestedByUserId: CRM_USER,
    campaignContentHash: version.contentHash,
    planHash: plan.planHash,
    targetAcceptedPerDay: 5,
    maxRawCandidatesPerDay: 25,
    maxCreditsPerDay: 250_000,
    runHourLocal: 7,
    timezone: 'America/New_York',
  }
  const policy = em.create(GtmAutoRefillPolicy, {
    id: policyId,
    ...Object.fromEntries(Object.entries(material).filter(([key]) => key !== 'policyId')),
    status: 'active',
    policyHash: buildAutoRefillPolicyHash(material),
    scheduledJobId: policyId,
    fence: 1,
  })
  for (const row of [play, version, campaign, policy]) em.persist(row)
  await em.flush()
  return { play, plan, version, campaign, policy }
}

describe('R38 auto-refill cycle', () => {
  it('runs one bounded research cycle and never enrolls or sends', async () => {
    const em = new FakeEm()
    const adapter = spyAdapter()
    const seeded = await seed(em, adapter)
    const now = () => new Date('2026-08-24T15:00:00.000Z')
    const result = await processAutoRefillCycle(em, {
      organizationId: ORG,
      tenantId: TENANT,
      policyId: seeded.policy.id,
      noliOrganizationId: NOLI_ORG,
      representedNoliUserId: NOLI_USER,
    }, {
      adapters: { [adapter.descriptor.adapter_id]: adapter },
      ledger: new FixtureLedger({ poolBalance: 1_000_000 }),
      now,
    })
    expect(result.outcome).toBe('completed')
    expect(adapter.search).toHaveBeenCalledTimes(1)
    expect(em.table(GtmAutoRefillCycle)).toHaveLength(1)
    expect(em.table(GtmResearchRun)).toHaveLength(1)
    expect(em.table(GtmCandidate)).toHaveLength(3)
    expect(em.table(GtmEnrollment)).toHaveLength(0)
    expect(em.table(GtmSendAttempt)).toHaveLength(0)
    const cycle = em.table(GtmAutoRefillCycle)[0]
    expect(cycle.localDate).toBe('2026-08-24')
    expect(cycle.result).toEqual(expect.objectContaining({
      research_status: 'completed',
      reconciliation_required: false,
    }))
    expect(JSON.stringify(cycle.result)).not.toContain('synthetic.example')
  })

  it('deduplicates duplicate scheduler delivery by policy-local date', async () => {
    const em = new FakeEm()
    const adapter = spyAdapter()
    const seeded = await seed(em, adapter)
    const input = {
      organizationId: ORG,
      tenantId: TENANT,
      policyId: seeded.policy.id,
      noliOrganizationId: NOLI_ORG,
      representedNoliUserId: NOLI_USER,
    }
    const deps = {
      adapters: { [adapter.descriptor.adapter_id]: adapter },
      ledger: new FixtureLedger({ poolBalance: 1_000_000 }),
      now: () => new Date('2026-08-24T15:00:00.000Z'),
    }
    expect((await processAutoRefillCycle(em, input, deps)).outcome).toBe('completed')
    expect((await processAutoRefillCycle(em, input, deps)).outcome).toBe('already_processed')
    expect(adapter.search).toHaveBeenCalledTimes(1)
    expect(em.table(GtmAutoRefillCycle)).toHaveLength(1)
  })

  // Review 2026-09-02 (M13): 'paused' was an allowed campaign status here,
  // so a customer who paused on Friday still paid for weekday refills.
  it('blocks the cycle with a clear reason while the campaign is paused', async () => {
    const em = new FakeEm()
    const adapter = spyAdapter()
    const seeded = await seed(em, adapter)
    seeded.campaign.status = 'paused'
    const result = await processAutoRefillCycle(em, {
      organizationId: ORG,
      tenantId: TENANT,
      policyId: seeded.policy.id,
      noliOrganizationId: NOLI_ORG,
      representedNoliUserId: NOLI_USER,
    }, {
      adapters: { [adapter.descriptor.adapter_id]: adapter },
      ledger: new FixtureLedger({ poolBalance: 1_000_000 }),
      now: () => new Date('2026-08-24T15:00:00.000Z'),
    })
    expect(result.outcome).toBe('blocked')
    expect(adapter.search).not.toHaveBeenCalled()
    expect(em.table(GtmResearchRun)).toHaveLength(0)
    expect(em.table(GtmAutoRefillPolicy)[0]).toEqual(expect.objectContaining({
      status: 'blocked',
      blockedReason: 'campaign_paused',
    }))
    expect(em.table(GtmAutoRefillCycle)[0]).toEqual(expect.objectContaining({
      status: 'blocked',
      failureCode: 'campaign_paused',
    }))
  })

  // Review 2026-09-02 (M14): blockCycle locked the policy without checking
  // status/fence/hash, so a late delivery that raced a re-activation blocked
  // the fresh policy and burned its day with a blocked cycle.
  it('does not block a policy that was re-activated under a stale delivery', async () => {
    const em = new FakeEm()
    const adapter = spyAdapter()
    const seeded = await seed(em, adapter)
    const changed: SpyAdapter = {
      ...adapter,
      descriptor: {
        ...adapter.descriptor,
        cost_model: { ...adapter.descriptor.cost_model, price_version: 'changed' },
      },
      search: jest.fn(),
    }
    const originalFindOne = em.findOne.bind(em)
    let raced = false
    // Simulate a concurrent re-activation between the policy read and the
    // blocking transaction: the delivery holds a snapshot of the policy while
    // the stored row's fence moves on (hash and status unchanged).
    em.findOne = (async (Ctor: new () => object, where: Record<string, unknown>) => {
      const row = await originalFindOne(Ctor, where)
      if (!raced && row && Ctor === GtmAutoRefillPolicy) {
        raced = true
        const snapshot = Object.assign(new GtmAutoRefillPolicy(), row)
        seeded.policy.fence += 1
        return snapshot
      }
      return row
    }) as FakeEm['findOne']
    const result = await processAutoRefillCycle(em, {
      organizationId: ORG,
      tenantId: TENANT,
      policyId: seeded.policy.id,
      noliOrganizationId: NOLI_ORG,
      representedNoliUserId: NOLI_USER,
    }, {
      adapters: { [changed.descriptor.adapter_id]: changed },
      ledger: new FixtureLedger({ poolBalance: 1_000_000 }),
      now: () => new Date('2026-08-24T15:00:00.000Z'),
    })
    expect(raced).toBe(true)
    expect(result.outcome).toBe('inactive')
    expect(changed.search).not.toHaveBeenCalled()
    expect(em.table(GtmAutoRefillCycle)).toHaveLength(0)
    expect(em.table(GtmAutoRefillPolicy)[0]).toEqual(expect.objectContaining({
      status: 'active',
      fence: 2,
    }))
    expect(em.table(GtmAutoRefillPolicy)[0].blockedReason).toBeFalsy()
  })

  it('blocks plan drift before a provider operation', async () => {
    const em = new FakeEm()
    const adapter = spyAdapter()
    const seeded = await seed(em, adapter)
    const changed: SpyAdapter = {
      ...adapter,
      descriptor: {
        ...adapter.descriptor,
        cost_model: { ...adapter.descriptor.cost_model, price_version: 'changed' },
      },
      search: jest.fn(),
    }
    const result = await processAutoRefillCycle(em, {
      organizationId: ORG,
      tenantId: TENANT,
      policyId: seeded.policy.id,
      noliOrganizationId: NOLI_ORG,
      representedNoliUserId: NOLI_USER,
    }, {
      adapters: { [changed.descriptor.adapter_id]: changed },
      ledger: new FixtureLedger({ poolBalance: 1_000_000 }),
      now: () => new Date('2026-08-24T15:00:00.000Z'),
    })
    expect(result.outcome).toBe('blocked')
    expect(changed.search).not.toHaveBeenCalled()
    expect(em.table(GtmResearchRun)).toHaveLength(0)
    expect(em.table(GtmAutoRefillPolicy)[0].status).toBe('blocked')
    expect(em.table(GtmAutoRefillCycle)[0]).toEqual(expect.objectContaining({
      status: 'blocked',
      failureCode: 'plan_changed',
    }))
  })
})
