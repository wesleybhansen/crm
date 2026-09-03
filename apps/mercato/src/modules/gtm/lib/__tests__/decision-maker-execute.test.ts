import {
  GtmCandidate,
  GtmCandidateMatch,
  GtmCandidateRelation,
  GtmContactPoint,
  GtmEvidence,
  GtmProviderOperation,
  GtmResearchRun,
} from '../../data/entities'
import {
  APIFY_COMPANY_EMPLOYEES_REQUIRED_PRICE_VERSION,
  createApifyCompanyEmployeesAdapter,
} from '../adapters/apify/company-employees'
import type { ApifyRunOutcome } from '../adapters/apify/client'
import {
  APIFY_REQUIRED_PRICE_VERSION,
  APIFY_REQUIRED_TERMS_VERSION,
} from '../adapters/apify/source'
import { FixtureLedger, GtmCreditLedgerError, type GtmCreditLedger } from '../credits/ledger'
import { executeDecisionMakerPlan } from '../decision-makers/execute'
import { buildDecisionMakerPlan } from '../decision-makers/plan'
import { FakeEm } from './support/fake-em'

const CLOCK = new Date('2026-08-22T20:00:00.000Z')
const now = () => CLOCK
const ORG = '10000000-0000-4000-8000-000000000001'
const TENANT = '20000000-0000-4000-8000-000000000001'
const NOLI_ORG = '30000000-0000-4000-8000-000000000001'
const NOLI_USER = '40000000-0000-4000-8000-000000000001'
const WORKSPACE = '50000000-0000-4000-8000-000000000001'
const PLAY = '60000000-0000-4000-8000-000000000001'
const RUN = '70000000-0000-4000-8000-000000000001'
const COMPANY = '80000000-0000-4000-8000-000000000001'
const COMPANY_MATCH = '90000000-0000-4000-8000-000000000001'

const ENABLED_ENV = {
  GTM_APIFY_ENABLED: 'true',
  GTM_APIFY_ACCOUNT_TIER: 'BRONZE',
  GTM_APIFY_TOKEN: 'synthetic-token',
  GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
  GTM_APIFY_TERMS_VERSION: APIFY_REQUIRED_TERMS_VERSION,
  GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
  GTM_APIFY_COMPANY_EMPLOYEES_PRICE_VERSION:
    APIFY_COMPANY_EMPLOYEES_REQUIRED_PRICE_VERSION,
}

function actorOutcome(values: Partial<ApifyRunOutcome> = {}): ApifyRunOutcome {
  return {
    kind: 'ok',
    status: 'ok',
    items: [],
    actorId: 'harvestapi/linkedin-company-employees',
    runId: null,
    itemCount: 0,
    httpStatus: 201,
    retryAfterSeconds: null,
    bodySnippet: null,
    requestUrl: 'https://api.apify.test/redacted',
    attemptedAt: CLOCK.toISOString(),
    error: null,
    billingFinalized: true,
    chargedEventCounts: { 'actor-start': 1, 'full-profile': 1 },
    providerCostUsd: 0.028,
    pricingModel: 'PAY_PER_EVENT',
    ...values,
  }
}

function employeeItem(title = 'Practice Owner') {
  return {
    linkedinUrl: 'https://www.linkedin.com/in/alex-example/',
    firstName: 'Alex',
    lastName: 'Example',
    location: {
      parsed: {
        text: 'San Diego, CA, United States',
        countryCode: 'US',
        state: 'California',
        city: 'San Diego',
      },
    },
    currentPosition: [{
      position: title,
      companyName: 'Example Dental',
      companyLinkedinUrl: 'https://www.linkedin.com/company/example-dental/',
    }],
    _meta: {
      query: {
        currentCompanies: ['https://www.linkedin.com/company/example-dental/'],
      },
    },
  }
}

async function fixture(title = 'Practice Owner') {
  const em = new FakeEm()
  const run = em.create(GtmResearchRun, {
    id: RUN,
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    playId: PLAY,
  })
  const company = em.create(GtmCandidate, {
    id: COMPANY,
    organizationId: ORG,
    tenantId: TENANT,
    researchRunId: RUN,
    workspaceId: WORKSPACE,
    entityKind: 'company',
    identity: {
      name: 'Example Dental',
      urls: ['https://www.linkedin.com/company/example-dental/'],
    },
    dedupeKey: 'company-key',
    fitStatus: 'accepted',
  })
  const match = em.create(GtmCandidateMatch, {
    id: COMPANY_MATCH,
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    playId: PLAY,
    researchRunId: RUN,
    candidateId: COMPANY,
    fitStatus: 'accepted',
  })
  em.persist(run)
  em.persist(company)
  em.persist(match)
  await em.flush()
  const runActor = jest.fn(async () => actorOutcome({
    items: [employeeItem(title)],
    itemCount: 1,
  }))
  const adapter = createApifyCompanyEmployeesAdapter({ env: ENABLED_ENV, now, runActor })
  const plan = buildDecisionMakerPlan({
    run,
    play: { audience: 'Independent dental practices', likelyBuyer: 'Practice owner' },
    companies: [{
      candidate_id: COMPANY,
      match_id: COMPANY_MATCH,
      name: 'Example Dental',
      linkedin_url: 'https://www.linkedin.com/company/example-dental/',
    }],
    adapter,
    maxProfiles: 5,
  })
  return { em, run, runActor, adapter, plan }
}

describe('decision-maker execution', () => {
  it('settles once and persists a person, contextual match, evidence, and company relation', async () => {
    const { em, run, runActor, adapter, plan } = await fixture()
    const ledger = new FixtureLedger({ poolBalance: 100_000 })
    const result = await executeDecisionMakerPlan({
      em,
      ledger,
      adapter,
      run,
      plan,
      noliOrgId: NOLI_ORG,
      noliUserId: NOLI_USER,
      now,
    })
    expect(result).toEqual(expect.objectContaining({
      outcome: 'ok',
      charged_credits: 14_000,
      reconciliation_required: false,
      people_created: 1,
      matches_created: 1,
      relations_created: 1,
      evidence_created: 1,
      accepted: 1,
      review: 0,
      rejected: 0,
    }))
    expect(runActor).toHaveBeenCalledTimes(1)
    expect(ledger.listOperations()[0]).toEqual(expect.objectContaining({
      status: 'charged',
      estimatedCredits: 30_000,
      chargedCredits: 14_000,
    }))
    const people = em.table(GtmCandidate).filter((candidate) => candidate.entityKind === 'person')
    expect(people).toHaveLength(1)
    expect(people[0].identity).toEqual(expect.objectContaining({
      name: 'Alex Example',
      company: 'Example Dental',
      title: 'Practice Owner',
    }))
    expect(em.table(GtmCandidateMatch).filter((row) => row.candidateId === people[0].id)).toEqual([
      // v2: head-of-title match plus negation/seniority guards (see qualify.ts)
      expect.objectContaining({ fitStatus: 'accepted', qualificationVersion: 'decision-maker-v2' }),
    ])
    expect(em.table(GtmCandidateRelation)).toEqual([
      expect.objectContaining({
        parentCandidateId: COMPANY,
        childCandidateId: people[0].id,
        relationshipKind: 'current_employee',
      }),
    ])
    expect(em.table(GtmEvidence).filter((row) => row.candidateId === people[0].id)).toHaveLength(1)
    expect(em.table(GtmContactPoint)).toHaveLength(0)
  })

  it('replays the same confirmed plan without another provider call', async () => {
    const { em, run, runActor, adapter, plan } = await fixture()
    const ledger = new FixtureLedger({ poolBalance: 100_000 })
    const args = { em, ledger, adapter, run, plan, noliOrgId: NOLI_ORG, noliUserId: NOLI_USER, now }
    await executeDecisionMakerPlan(args)
    const replay = await executeDecisionMakerPlan(args)
    expect(replay).toEqual(expect.objectContaining({
      outcome: 'replayed',
      ledger_status: 'charged',
      relations_created: 1,
    }))
    expect(runActor).toHaveBeenCalledTimes(1)
    expect(ledger.listOperations()).toHaveLength(1)
    expect(em.table(GtmProviderOperation)).toHaveLength(1)
    expect(em.table(GtmCandidateRelation)).toHaveLength(1)
  })

  it('gives concurrent callers one provider owner and one reconciliation-safe loser', async () => {
    const { em, run, runActor, adapter, plan } = await fixture()
    const ledger = new FixtureLedger({ poolBalance: 100_000 })
    const args = { em, ledger, adapter, run, plan, noliOrgId: NOLI_ORG, noliUserId: NOLI_USER, now }
    const [first, second] = await Promise.all([
      executeDecisionMakerPlan(args),
      executeDecisionMakerPlan(args),
    ])
    expect(runActor).toHaveBeenCalledTimes(1)
    expect([first.outcome, second.outcome]).toEqual(expect.arrayContaining(['ok', 'ambiguous']))
    expect([first.reconciliation_required, second.reconciliation_required]).toContain(true)
    expect(em.table(GtmProviderOperation)).toHaveLength(1)
    expect(em.table(GtmCandidateRelation)).toHaveLength(1)
  })

  it('keeps an uncertain current title in review rather than inheriting company acceptance', async () => {
    const { em, run, adapter, plan } = await fixture('Clinical Director')
    const result = await executeDecisionMakerPlan({
      em,
      ledger: new FixtureLedger({ poolBalance: 100_000 }),
      adapter,
      run,
      plan,
      noliOrgId: NOLI_ORG,
      noliUserId: NOLI_USER,
      now,
    })
    expect(result).toEqual(expect.objectContaining({ review: 1, accepted: 0 }))
    const personMatch = em.table(GtmCandidateMatch).find((row) => row.candidateId !== COMPANY)
    expect(personMatch).toEqual(expect.objectContaining({ fitStatus: 'review' }))
  })

  it('withholds all person output when the provider outcome is ambiguous', async () => {
    const { em, run, adapter, plan } = await fixture()
    const ambiguousAdapter = createApifyCompanyEmployeesAdapter({
      env: ENABLED_ENV,
      now,
      runActor: async () => actorOutcome({
        kind: 'transport_unknown', status: 'ambiguous', items: [], itemCount: 0,
        error: 'transport_unknown',
      }),
    })
    const ledger = new FixtureLedger({ poolBalance: 100_000 })
    const result = await executeDecisionMakerPlan({
      em,
      ledger,
      adapter: ambiguousAdapter,
      run,
      plan,
      noliOrgId: NOLI_ORG,
      noliUserId: NOLI_USER,
      now,
    })
    expect(result).toEqual(expect.objectContaining({
      outcome: 'ambiguous', reconciliation_required: true, people_created: 0,
    }))
    expect(ledger.listOperations()[0].status).toBe('reconciliation_required')
    expect(em.table(GtmCandidate).filter((candidate) => candidate.entityKind === 'person')).toHaveLength(0)
    expect(em.table(GtmCandidateRelation)).toHaveLength(0)
  })

  it('withholds provider output when canonical settlement is unavailable', async () => {
    const { em, run, adapter, plan } = await fixture()
    const base = new FixtureLedger({ poolBalance: 100_000 })
    const ledger: GtmCreditLedger = {
      reserve: (input) => base.reserve(input),
      start: (operationId) => base.start(operationId),
      settle: async () => { throw new Error('synthetic noli-core outage') },
      markAmbiguous: (operationId, detail) => base.markAmbiguous(operationId, detail),
      release: (operationId) => base.release(operationId),
    }
    const result = await executeDecisionMakerPlan({
      em,
      ledger,
      adapter,
      run,
      plan,
      noliOrgId: NOLI_ORG,
      noliUserId: NOLI_USER,
      now,
    })
    expect(result).toEqual(expect.objectContaining({
      outcome: 'ambiguous', reconciliation_required: true, people_created: 0,
    }))
    expect(em.table(GtmCandidateRelation)).toHaveLength(0)
    expect(em.table(GtmProviderOperation)[0].receipt).toEqual(expect.objectContaining({
      gtm_observation: expect.objectContaining({
        settlement_pending: true,
        settlement_error: expect.stringContaining('synthetic noli-core outage'),
      }),
    }))
  })

  it('retains paid observations before settle and materialises them on replay when the settle response was lost', async () => {
    const { em, run, runActor, adapter, plan } = await fixture()
    const base = new FixtureLedger({ poolBalance: 100_000 })
    // The canonical ledger COMMITS the charge, then the response is lost.
    const ledger: GtmCreditLedger = {
      reserve: (input) => base.reserve(input),
      start: (operationId) => base.start(operationId),
      settle: async (operationId, outcome, credits, receipt) => {
        await base.settle(operationId, outcome, credits, receipt)
        throw new Error('synthetic gateway timeout after commit')
      },
      markAmbiguous: (operationId, detail) => base.markAmbiguous(operationId, detail),
      release: (operationId) => base.release(operationId),
    }
    const args = { em, ledger, adapter, run, plan, noliOrgId: NOLI_ORG, noliUserId: NOLI_USER, now }
    const first = await executeDecisionMakerPlan(args)
    expect(first).toEqual(expect.objectContaining({ outcome: 'ambiguous', reconciliation_required: true, people_created: 0 }))
    expect(base.listOperations()[0].status).toBe('charged')
    const shadow = em.table(GtmProviderOperation)[0]
    expect(shadow.localStatusMirror).toBe('provider_started')
    // The paid profiles are already in the receipt, written BEFORE settle.
    expect((shadow.receipt?.gtm_observation as Record<string, unknown>).retained_data).toEqual([
      expect.objectContaining({ current_title: 'Practice Owner' }),
    ])
    expect(em.table(GtmCandidateRelation)).toHaveLength(0)

    // Replay: reserve returns 'charged'; the retained data is materialised
    // idempotently with NO second provider call and NO second charge.
    const replay = await executeDecisionMakerPlan({ ...args, ledger: base })
    expect(replay).toEqual(expect.objectContaining({
      outcome: 'replayed',
      ledger_status: 'charged',
      people_created: 1,
      matches_created: 1,
      relations_created: 1,
      accepted: 1,
      reconciliation_required: false,
    }))
    expect(runActor).toHaveBeenCalledTimes(1)
    expect(base.listOperations()).toHaveLength(1)
    expect(em.table(GtmCandidateRelation)).toHaveLength(1)
    expect(shadow.localStatusMirror).toBe('charged')
    expect(shadow.settledAt).toBeInstanceOf(Date)

    // A third replay rewrites nothing.
    const again = await executeDecisionMakerPlan({ ...args, ledger: base })
    expect(again).toEqual(expect.objectContaining({ outcome: 'replayed', people_created: 0, people_reused: 1, relations_created: 1 }))
    expect(em.table(GtmCandidateRelation)).toHaveLength(1)
    expect(em.table(GtmCandidate).filter((candidate) => candidate.entityKind === 'person')).toHaveLength(1)
  })

  it('fails closed on insufficient credits before any provider call', async () => {
    const { em, run, runActor, adapter, plan } = await fixture()
    const ledger = new FixtureLedger({ poolBalance: 1 })
    const err = await executeDecisionMakerPlan({
      em, ledger, adapter, run, plan, noliOrgId: NOLI_ORG, noliUserId: NOLI_USER, now,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(GtmCreditLedgerError)
    expect((err as GtmCreditLedgerError).code).toBe('insufficient_credits')
    expect(runActor).not.toHaveBeenCalled()
    expect(em.table(GtmProviderOperation)).toHaveLength(0)
  })

  it('parks an ok result that cannot state its cost instead of charging zero', async () => {
    const { em, run, plan } = await fixture()
    const base = createApifyCompanyEmployeesAdapter({ env: ENABLED_ENV, now, runActor: async () => actorOutcome() })
    const adapter = {
      ...base,
      resolve: async () => ({ status: 'ok' as const, data: [], receipt: { provider_request_id: 'r' }, cost_units: null }),
    }
    const ledger = new FixtureLedger({ poolBalance: 100_000 })
    const result = await executeDecisionMakerPlan({
      em, ledger, adapter, run, plan, noliOrgId: NOLI_ORG, noliUserId: NOLI_USER, now,
    })
    expect(result).toEqual(expect.objectContaining({ outcome: 'ambiguous', reconciliation_required: true, charged_credits: 0 }))
    expect(ledger.listOperations()[0].status).toBe('reconciliation_required')
    expect(em.table(GtmProviderOperation)[0].settledAt).toBeUndefined()
  })

  it('charges a definitive provider error that reports a nonzero cost instead of refunding it', async () => {
    const { em, run, plan } = await fixture()
    const base = createApifyCompanyEmployeesAdapter({ env: ENABLED_ENV, now, runActor: async () => actorOutcome() })
    const adapter = {
      ...base,
      resolve: async () => ({ status: 'error' as const, data: null, receipt: null, cost_units: 1, error: 'actor failed after start' }),
    }
    const ledger = new FixtureLedger({ poolBalance: 100_000 })
    const result = await executeDecisionMakerPlan({
      em, ledger, adapter, run, plan, noliOrgId: NOLI_ORG, noliUserId: NOLI_USER, now,
    })
    expect(result.outcome).toBe('error')
    expect(ledger.listOperations()[0]).toEqual(expect.objectContaining({ status: 'charged' }))
    expect(ledger.listOperations()[0].chargedCredits).toBeGreaterThan(0)
  })

  it('parks the operation when the canonical settle echoes a different status than intended', async () => {
    const { em, run, adapter, plan } = await fixture()
    const base = new FixtureLedger({ poolBalance: 100_000 })
    const ledger: GtmCreditLedger = {
      reserve: (input) => base.reserve(input),
      start: (operationId) => base.start(operationId),
      settle: async (operationId, _outcome, _credits, receipt) => base.settle(operationId, 'refunded', 0, receipt),
      markAmbiguous: (operationId, detail) => base.markAmbiguous(operationId, detail),
      release: (operationId) => base.release(operationId),
    }
    const result = await executeDecisionMakerPlan({
      em, ledger, adapter, run, plan, noliOrgId: NOLI_ORG, noliUserId: NOLI_USER, now,
    })
    expect(result).toEqual(expect.objectContaining({ outcome: 'ambiguous', reconciliation_required: true, people_created: 0 }))
    expect(em.table(GtmProviderOperation)[0].receipt).toEqual(expect.objectContaining({
      gtm_observation: expect.objectContaining({
        settlement_pending: true,
        settlement_error: expect.stringContaining('does not match intended charged'),
      }),
    }))
    expect(em.table(GtmCandidateRelation)).toHaveLength(0)
  })

  it('caps the provider spend and settle amount by the reservation echo when the ledger reserved less', async () => {
    const { em, run, plan } = await fixture()
    const base = new FixtureLedger({ poolBalance: 100_000 })
    const maxCharge: number[] = []
    const inner = createApifyCompanyEmployeesAdapter({
      env: ENABLED_ENV, now, runActor: async () => actorOutcome({ items: [employeeItem()], itemCount: 1 }),
    })
    const adapter = {
      ...inner,
      resolve: async (request: Parameters<typeof inner.resolve>[0]) => {
        maxCharge.push(request.max_charge_usd ?? -1)
        return inner.resolve(request)
      },
    }
    const ledger: GtmCreditLedger = {
      reserve: async (input) => ({ ...(await base.reserve(input)), reservedCredits: 5_000 }),
      start: (operationId) => base.start(operationId),
      settle: (operationId, outcome, credits, receipt) => base.settle(operationId, outcome, credits, receipt),
      markAmbiguous: (operationId, detail) => base.markAmbiguous(operationId, detail),
      release: (operationId) => base.release(operationId),
    }
    const result = await executeDecisionMakerPlan({
      em, ledger, adapter, run, plan, noliOrgId: NOLI_ORG, noliUserId: NOLI_USER, now,
    })
    expect(result.charged_credits).toBe(5_000)
    expect(maxCharge).toEqual([0.01])
  })

  it('releases the reservation when start fails in transport and rethrows', async () => {
    const { em, run, runActor, adapter, plan } = await fixture()
    const base = new FixtureLedger({ poolBalance: 100_000 })
    const ledger: GtmCreditLedger = {
      reserve: (input) => base.reserve(input),
      start: async () => { throw new Error('start transport failure') },
      settle: (operationId, outcome, credits, receipt) => base.settle(operationId, outcome, credits, receipt),
      markAmbiguous: (operationId, detail) => base.markAmbiguous(operationId, detail),
      release: (operationId) => base.release(operationId),
    }
    await expect(executeDecisionMakerPlan({
      em, ledger, adapter, run, plan, noliOrgId: NOLI_ORG, noliUserId: NOLI_USER, now,
    })).rejects.toThrow('start transport failure')
    expect(runActor).not.toHaveBeenCalled()
    expect(base.listOperations()[0].status).toBe('released')
    expect(em.table(GtmProviderOperation)[0].localStatusMirror).toBe('released')
    expect(base.availableCredits()).toBe(100_000)
  })
})
