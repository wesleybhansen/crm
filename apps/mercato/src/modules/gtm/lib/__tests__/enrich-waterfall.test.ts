import { FakeEm } from './support/fake-em'
import { FixtureLedger } from '../credits/ledger'
import {
  fixtureEnrichAdapter,
  fixtureEnrichDescriptor,
  fixtureVerifyAdapter,
} from '../adapters/fixture'
import type { EnrichAdapter, EnrichRequest, VerifyAdapter, VerifyRequest } from '../adapters/types'
import { runEnrichmentWaterfall, type EnrichWaterfallDeps } from '../enrich/waterfall'
import { GtmCandidate, GtmContactPoint, GtmProviderOperation } from '../../data/entities'

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const WORKSPACE = '33333333-3333-4333-8333-333333333333'
const RUN = '44444444-4444-4444-8444-444444444444'
const USER = '55555555-5555-4555-8555-555555555555'

type SpyEnrich = EnrichAdapter & { enrich: jest.Mock }
type SpyVerify = VerifyAdapter & { verify: jest.Mock }

function spyEnrich(): SpyEnrich {
  return {
    descriptor: fixtureEnrichAdapter.descriptor,
    enrich: jest.fn((request: EnrichRequest) => fixtureEnrichAdapter.enrich(request)),
  }
}

function spyVerify(): SpyVerify {
  return {
    descriptor: fixtureVerifyAdapter.descriptor,
    verify: jest.fn((request: VerifyRequest) => fixtureVerifyAdapter.verify(request)),
  }
}

let dedupeSeq = 0

async function makeCandidate(
  em: FakeEm,
  options: {
    name: string
    fitStatus?: string
    kind?: 'person' | 'company'
    company?: string | null
    domain?: string | null
  },
): Promise<GtmCandidate> {
  const candidate = em.create(GtmCandidate, {
    organizationId: ORG,
    tenantId: TENANT,
    researchRunId: RUN,
    workspaceId: WORKSPACE,
    entityKind: options.kind ?? 'person',
    identity: {
      name: options.name,
      company: options.company ?? null,
      domain: options.domain ?? null,
    },
    dedupeKey: `dedupe-${dedupeSeq++}`,
    fitStatus: options.fitStatus ?? 'accepted',
  })
  em.persist(candidate)
  await em.flush()
  return candidate
}

async function makePoint(
  em: FakeEm,
  candidate: GtmCandidate,
  value: string,
  state = 'found',
): Promise<GtmContactPoint> {
  const point = em.create(GtmContactPoint, {
    organizationId: ORG,
    tenantId: TENANT,
    candidateId: candidate.id,
    channel: 'email',
    value,
    verificationState: state,
  })
  em.persist(point)
  await em.flush()
  return point
}

function deps(
  em: FakeEm,
  ledger: FixtureLedger,
  enrich: EnrichAdapter[],
  verify: VerifyAdapter[],
  overrides?: Partial<EnrichWaterfallDeps>,
): EnrichWaterfallDeps {
  return {
    em,
    ledger,
    enrichAdapters: enrich,
    verifyAdapters: verify,
    candidates: [...em.table(GtmCandidate)],
    contactPoints: [...em.table(GtmContactPoint)],
    userId: USER,
    runId: RUN,
    markupMultiplier: 2,
    ...overrides,
  }
}

describe('runEnrichmentWaterfall', () => {
  it('enriches and verifies ONLY accepted candidates (spec 4.1 step 6)', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const enrich = spyEnrich()
    const verify = spyVerify()
    const accepted = await makeCandidate(em, { name: 'Alex Example' })
    const rejected = await makeCandidate(em, { name: 'Jamie Fixture', fitStatus: 'rejected' })
    const unscored = await makeCandidate(em, { name: 'Casey Synthetic', fitStatus: 'unscored' })

    const summary = await runEnrichmentWaterfall(deps(em, ledger, [enrich], [verify]))

    // one enrich + one verify call, both for the accepted candidate only
    expect(enrich.enrich).toHaveBeenCalledTimes(1)
    expect(enrich.enrich.mock.calls[0][0].candidate.identity.name).toBe('Alex Example')
    expect(verify.verify).toHaveBeenCalledTimes(1)
    expect(verify.verify.mock.calls[0][0].value).toBe('alex.example@example-dynamics.example')

    const points = em.table(GtmContactPoint)
    expect(points).toHaveLength(1)
    expect(points[0].candidateId).toBe(accepted.id)
    expect(points[0].channel).toBe('email')
    expect(points[0].verificationState).toBe('verified')
    expect(points[0].verifiedAt).toBeInstanceOf(Date)
    // provider_operation_id = the shadow row id, not the noli-core id
    const shadows = em.table(GtmProviderOperation)
    expect(shadows.map((shadow) => shadow.id)).toContain(points[0].providerOperationId)
    const enrichShadow = shadows.find((shadow) => shadow.id === points[0].providerOperationId)!
    expect(enrichShadow.kind).toBe('contact_enrich')
    expect(enrichShadow.candidateId).toBe(accepted.id)
    expect(enrichShadow.researchRunId).toBe(RUN)
    expect(enrichShadow.localStatusMirror).toBe('charged')

    // rejected and unscored candidates were never touched
    expect(points.some((point) => point.candidateId === rejected.id)).toBe(false)
    expect(points.some((point) => point.candidateId === unscored.id)).toBe(false)

    // enrich 1 unit x 2 quoted x 2 markup = 4, verify 1 x 1 x 2 = 2
    expect(summary).toMatchObject({
      enriched: 1,
      verified: 1,
      risky: 0,
      catch_all: 0,
      not_found: 0,
      ambiguous: 0,
      credits: 6,
      stopped: 'completed',
      candidatesConsidered: 1,
    })
    expect(ledger.listOperations()).toHaveLength(2)
  })

  it('pay_on_found: a definitive no_result settles refunded 0', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const enrich = spyEnrich()
    const verify = spyVerify()
    // trigger token in the candidate name selects the crafted no_result case
    await makeCandidate(em, { name: 'Robin fixture-no-result' })

    const summary = await runEnrichmentWaterfall(deps(em, ledger, [enrich], [verify]))

    expect(enrich.enrich).toHaveBeenCalledTimes(1)
    expect(verify.verify).not.toHaveBeenCalled()
    expect(em.table(GtmContactPoint)).toHaveLength(0)
    expect(summary.enriched).toBe(0)
    expect(summary.credits).toBe(0)

    const op = ledger.listOperations()[0]
    expect(op.status).toBe('refunded')
    expect(op.chargedCredits).toBe(0)
    // refunded reservation frees the pool again
    expect(ledger.availableCredits()).toBe(100)
  })

  it('non-pay_on_found: a definitive no_result still settles charged', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const paidLookup: SpyEnrich = {
      descriptor: {
        ...fixtureEnrichDescriptor,
        adapter_id: 'fixture-enrich-paid-lookup',
        cost_model: { ...fixtureEnrichDescriptor.cost_model, pay_on_found: false },
      },
      enrich: jest.fn(async () => ({
        status: 'no_result' as const,
        data: null,
        receipt: { provider_request_id: 'req-1', provider_status: 'no_result' },
        cost_units: 1,
      })),
    }
    await makeCandidate(em, { name: 'Robin Synthetic', domain: 'synthetic.example' })

    const summary = await runEnrichmentWaterfall(deps(em, ledger, [paidLookup], []))

    expect(paidLookup.enrich).toHaveBeenCalledTimes(1)
    const op = ledger.listOperations()[0]
    expect(op.status).toBe('charged')
    // 1 unit x 2 quoted x 2 markup = 4, charged even though nothing was found
    expect(op.chargedCredits).toBe(4)
    expect(summary.credits).toBe(4)
    expect(em.table(GtmContactPoint)).toHaveLength(0)
  })

  it('maps verification outcomes onto the frozen state set', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const verify = spyVerify()
    const cases: Array<[value: string, expected: string]> = [
      ['alex.example@example-dynamics.example', 'verified'],
      ['jamie.fixture@sample-synthetics.example', 'risky'],
      ['hello@example-dynamics.example', 'catch_all'],
      ['unknown@test-owned-domain.example', 'not_found'],
      ['contact@fixture-ambiguous-acceptance.example', 'provider_ambiguous'],
    ]
    const points: GtmContactPoint[] = []
    for (const [value] of cases) {
      const candidate = await makeCandidate(em, { name: `Holder of ${value}` })
      points.push(await makePoint(em, candidate, value))
    }

    const summary = await runEnrichmentWaterfall(deps(em, ledger, [], [verify]))

    for (let i = 0; i < cases.length; i += 1) {
      expect(points[i].verificationState).toBe(cases[i][1])
    }
    expect(summary).toMatchObject({
      verified: 1,
      risky: 1,
      catch_all: 1,
      not_found: 1,
      ambiguous: 1,
    })

    // the ambiguous operation is parked on the canonical ledger, not settled
    const parked = ledger
      .listOperations()
      .filter((op) => op.status === 'reconciliation_required')
    expect(parked).toHaveLength(1)
    const parkedShadow = em
      .table(GtmProviderOperation)
      .find((shadow) => shadow.noliCoreOperationId === parked[0].operationId)!
    expect(parkedShadow.localStatusMirror).toBe('reconciliation_required')
    expect(parkedShadow.settledAt).toBeUndefined()
  })

  it('parks provider_ambiguous points: a re-run never auto-retries them', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const verify = spyVerify()
    const candidate = await makeCandidate(em, { name: 'Ambiguous Holder' })
    const point = await makePoint(em, candidate, 'contact@fixture-ambiguous-acceptance.example')

    await runEnrichmentWaterfall(deps(em, ledger, [], [verify]))
    expect(point.verificationState).toBe('provider_ambiguous')
    expect(verify.verify).toHaveBeenCalledTimes(1)

    const again = await runEnrichmentWaterfall(deps(em, ledger, [], [verify]))
    // parked: no second provider call, no new reservation, state unchanged
    expect(verify.verify).toHaveBeenCalledTimes(1)
    expect(ledger.listOperations()).toHaveLength(1)
    expect(point.verificationState).toBe('provider_ambiguous')
    expect(again.ambiguous).toBe(0)
  })

  it('stops a candidate at its first verified point', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const verify = spyVerify()
    const candidate = await makeCandidate(em, { name: 'Two Point Holder' })
    const first = await makePoint(em, candidate, 'alex.example@example-dynamics.example')
    const second = await makePoint(em, candidate, 'jamie.fixture@sample-synthetics.example')

    const summary = await runEnrichmentWaterfall(deps(em, ledger, [], [verify]))

    expect(verify.verify).toHaveBeenCalledTimes(1)
    expect(first.verificationState).toBe('verified')
    // the second point was never verified: the candidate stopped
    expect(second.verificationState).toBe('found')
    expect(summary.verified).toBe(1)
    expect(ledger.listOperations()).toHaveLength(1)
  })

  it('is idempotent per candidate: a re-run neither re-reserves nor re-calls for verified candidates', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const enrich = spyEnrich()
    const verify = spyVerify()
    await makeCandidate(em, { name: 'Alex Example' })

    const firstRun = await runEnrichmentWaterfall(deps(em, ledger, [enrich], [verify]))
    expect(firstRun.verified).toBe(1)
    const opsAfterFirst = ledger.listOperations().length
    expect(opsAfterFirst).toBe(2)

    const secondRun = await runEnrichmentWaterfall(deps(em, ledger, [enrich], [verify]))

    expect(enrich.enrich).toHaveBeenCalledTimes(1)
    expect(verify.verify).toHaveBeenCalledTimes(1)
    expect(ledger.listOperations()).toHaveLength(opsAfterFirst)
    expect(em.table(GtmContactPoint)).toHaveLength(1)
    expect(secondRun).toMatchObject({
      enriched: 0,
      verified: 0,
      credits: 0,
      candidatesConsidered: 0,
      candidatesSkippedVerified: 1,
    })
  })

  it('skips the adapter call when the idempotency key maps to an already-settled operation', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const enrich = spyEnrich()
    const candidate = await makeCandidate(em, { name: 'Refund Case fixture-no-result' })

    // First run: no_result, refunded (pay_on_found).
    await runEnrichmentWaterfall(deps(em, ledger, [enrich], []))
    expect(enrich.enrich).toHaveBeenCalledTimes(1)
    expect(ledger.listOperations()[0].status).toBe('refunded')

    // Second run: same `enrich:{candidateId}:{adapter_id}` key resolves to the
    // settled operation; the provider is NOT called again and nothing new is
    // reserved (deterministic no-double-spend semantics).
    const summary = await runEnrichmentWaterfall(deps(em, ledger, [enrich], []))
    expect(enrich.enrich).toHaveBeenCalledTimes(1)
    expect(ledger.listOperations()).toHaveLength(1)
    expect(summary.credits).toBe(0)
    expect(candidate.fitStatus).toBe('accepted')
  })

  it('enforces the per-run maxCredits budget BEFORE each reserve', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const enrich = spyEnrich()
    const verify = spyVerify()
    await makeCandidate(em, { name: 'Alex Example' })
    await makeCandidate(em, { name: 'Jamie Fixture' })

    // enrich reserve = 4 credits; the follow-up verify reserve (2) would
    // exceed 4, so the run stops before that reserve ever happens.
    const summary = await runEnrichmentWaterfall(
      deps(em, ledger, [enrich], [verify], { maxCredits: 4 }),
    )

    expect(enrich.enrich).toHaveBeenCalledTimes(1)
    expect(verify.verify).not.toHaveBeenCalled()
    expect(summary.stopped).toBe('budget_exhausted')
    expect(summary.credits).toBe(4)
    // exactly one operation: the enrich; the blocked verify reserved nothing
    expect(ledger.listOperations()).toHaveLength(1)
    // the point exists but stays unverified until a later run with budget
    expect(em.table(GtmContactPoint)).toHaveLength(1)
    expect(em.table(GtmContactPoint)[0].verificationState).toBe('found')
  })

  it('fails closed on insufficient ledger credits with zero adapter calls', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 1 })
    const enrich = spyEnrich()
    const verify = spyVerify()
    await makeCandidate(em, { name: 'Alex Example' })

    const summary = await runEnrichmentWaterfall(deps(em, ledger, [enrich], [verify]))

    expect(enrich.enrich).not.toHaveBeenCalled()
    expect(verify.verify).not.toHaveBeenCalled()
    expect(summary.stopped).toBe('insufficient_credits')
    expect(summary.credits).toBe(0)
    expect(em.table(GtmContactPoint)).toHaveLength(0)
    expect(ledger.listOperations()).toHaveLength(0)
  })
})
