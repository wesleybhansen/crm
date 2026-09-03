import { FakeEm } from './support/fake-em'
import { FixtureLedger } from '../credits/ledger'
import { fixtureEnrichAdapter, fixtureEnrichDescriptor, fixtureVerifyAdapter } from '../adapters/fixture'
import type { EnrichAdapter, EnrichRequest, VerifyAdapter, VerifyRequest } from '../adapters/types'
import {
  providerVerificationState,
  resolveParkedContactPoints,
  runEnrichmentWaterfall,
  type EnrichWaterfallDeps,
} from '../enrich/waterfall'
import type { GtmCreditLedger } from '../credits/ledger'
import { GtmCandidate, GtmContactPoint, GtmProviderOperation } from '../../data/entities'

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const WORKSPACE = '33333333-3333-4333-8333-333333333333'
const RUN = '44444444-4444-4444-8444-444444444444'
const USER = '55555555-5555-4555-8555-555555555555'
const NOLI_ORG = '66666666-6666-4666-8666-666666666666'

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
    kind?: 'person' | 'company' | 'opportunity'
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
    noliOrgId: NOLI_ORG,
    noliUserId: USER,
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
    const acceptedCompany = await makeCandidate(em, {
      name: 'Example Dynamics LLC',
      kind: 'company',
    })
    await makeCandidate(em, {
      name: 'South Bay Homebuyer Community',
      kind: 'opportunity',
    })
    const rejected = await makeCandidate(em, {
      name: 'Jamie Fixture',
      fitStatus: 'rejected',
    })
    const unscored = await makeCandidate(em, {
      name: 'Casey Synthetic',
      fitStatus: 'unscored',
    })

    const summary = await runEnrichmentWaterfall(deps(em, ledger, [enrich], [verify]))

    // One enrich + one verify call, both for the accepted person only. The
    // accepted company and opportunity never cross the spend boundary.
    expect(enrich.enrich).toHaveBeenCalledTimes(1)
    expect(enrich.enrich.mock.calls[0][0].candidate.identity.name).toBe('Alex Example')
    expect(verify.verify).toHaveBeenCalledTimes(1)
    expect(verify.verify.mock.calls[0][0].value).toBe('alex.example@example-dynamics.example')
    expect(verify.verify.mock.calls[0][0].max_charge_usd).toBe(0.01)

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
    expect(points.some((point) => point.candidateId === acceptedCompany.id)).toBe(false)

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
    expect(ledger.listOperations().every((operation) => operation.orgId === NOLI_ORG)).toBe(true)
    expect(ledger.listOperations().every((operation) => operation.userId === USER)).toBe(true)
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
        cost_model: {
          ...fixtureEnrichDescriptor.cost_model,
          pay_on_found: false,
        },
      },
      enrich: jest.fn(async () => ({
        status: 'no_result' as const,
        data: null,
        receipt: { provider_request_id: 'req-1', provider_status: 'no_result' },
        cost_units: 1,
      })),
    }
    await makeCandidate(em, {
      name: 'Robin Synthetic',
      domain: 'synthetic.example',
    })

    const summary = await runEnrichmentWaterfall(deps(em, ledger, [paidLookup], []))

    expect(paidLookup.enrich).toHaveBeenCalledTimes(1)
    const op = ledger.listOperations()[0]
    expect(op.status).toBe('charged')
    // 1 unit x 2 quoted x 2 markup = 4, charged even though nothing was found
    expect(op.chargedCredits).toBe(4)
    expect(summary.credits).toBe(4)
    expect(em.table(GtmContactPoint)).toHaveLength(0)
  })

  it('retains the enrichment receipt and parks the candidate when canonical settlement fails', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const enrich = spyEnrich()
    const candidate = await makeCandidate(em, { name: 'Alex Example' })
    jest.spyOn(ledger, 'settle').mockRejectedValueOnce(new Error('canonical ledger unavailable'))

    const summary = await runEnrichmentWaterfall(deps(em, ledger, [enrich], []))

    expect(enrich.enrich).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ enriched: 0, ambiguous: 1, credits: 0 })
    expect(em.table(GtmContactPoint)).toHaveLength(0)
    const shadow = em.table(GtmProviderOperation)[0]
    expect(shadow.candidateId).toBe(candidate.id)
    expect(shadow.localStatusMirror).toBe('provider_started')
    expect(shadow.settledAt).toBeUndefined()
    expect(shadow.receipt).toEqual(
      expect.objectContaining({
        provider_request_id: expect.any(String),
        gtm_observation: expect.objectContaining({
          adapter_status: 'ok',
          intended_ledger_action: 'charged',
          settlement_pending: true,
          canonical_status: 'provider_started',
          settlement_error: expect.stringContaining('canonical ledger unavailable'),
        }),
      }),
    )

    const again = await runEnrichmentWaterfall(deps(em, ledger, [enrich], []))
    expect(again.ambiguous).toBe(1)
    expect(enrich.enrich).toHaveBeenCalledTimes(1)
    expect(ledger.listOperations()).toHaveLength(1)
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
    const parked = ledger.listOperations().filter((op) => op.status === 'reconciliation_required')
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

  it('verifies a normalized address once and reuses the terminal result for duplicate rows', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const verify = spyVerify()
    const firstCandidate = await makeCandidate(em, { name: 'First Holder' })
    const secondCandidate = await makeCandidate(em, { name: 'Second Holder' })
    const first = await makePoint(em, firstCandidate, 'alex.example@example-dynamics.example')
    const duplicate = await makePoint(em, secondCandidate, ' ALEX.EXAMPLE@example-dynamics.example ')

    const summary = await runEnrichmentWaterfall(deps(em, ledger, [], [verify]))

    expect(verify.verify).toHaveBeenCalledTimes(1)
    expect(ledger.listOperations()).toHaveLength(1)
    expect(first.verificationState).toBe('verified')
    expect(duplicate.verificationState).toBe('verified')
    expect(duplicate.provenance).toEqual(
      expect.objectContaining({
        verification: expect.objectContaining({
          deduplicated: true,
          reused_from_contact_point_id: first.id,
        }),
      }),
    )
    expect(summary.verified).toBe(2)
    expect(summary.credits).toBe(2)
  })

  it('refuses to reuse a conflicting historical terminal state', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const verify = spyVerify()
    const verifiedCandidate = await makeCandidate(em, {
      name: 'Verified Holder',
    })
    const rejectedCandidate = await makeCandidate(em, {
      name: 'Rejected Holder',
    })
    const pendingCandidate = await makeCandidate(em, {
      name: 'Pending Holder',
    })
    const duplicatePendingCandidate = await makeCandidate(em, {
      name: 'Duplicate Pending Holder',
    })
    await makePoint(em, verifiedCandidate, 'alex.example@example-dynamics.example', 'verified')
    await makePoint(em, rejectedCandidate, 'alex.example@example-dynamics.example', 'not_found')
    const pending = await makePoint(em, pendingCandidate, 'alex.example@example-dynamics.example')
    const duplicatePending = await makePoint(em, duplicatePendingCandidate, 'ALEX.EXAMPLE@example-dynamics.example')

    await runEnrichmentWaterfall(deps(em, ledger, [], [verify]))

    expect(verify.verify).toHaveBeenCalledTimes(1)
    expect(ledger.listOperations()).toHaveLength(1)
    expect(pending.verificationState).toBe('verified')
    expect(duplicatePending.verificationState).toBe('verified')
    expect(pending.provenance).not.toEqual(
      expect.objectContaining({
        verification: expect.objectContaining({ deduplicated: true }),
      }),
    )
    expect(duplicatePending.provenance).toEqual(
      expect.objectContaining({
        verification: expect.objectContaining({
          deduplicated: true,
          reused_from_contact_point_id: pending.id,
        }),
      }),
    )
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

  it('honors contextual accepted match ids even when the legacy candidate verdict differs', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const enrich = spyEnrich()
    const verify = spyVerify()
    const contextual = await makeCandidate(em, {
      name: 'Context Match',
      fitStatus: 'rejected',
    })
    await makeCandidate(em, { name: 'Legacy Accept', fitStatus: 'accepted' })

    await runEnrichmentWaterfall(
      deps(em, ledger, [enrich], [verify], {
        acceptedCandidateIds: new Set([contextual.id]),
      }),
    )

    expect(enrich.enrich).toHaveBeenCalledTimes(1)
    expect(enrich.enrich.mock.calls[0][0].candidate.identity.name).toBe('Context Match')
    expect(em.table(GtmContactPoint).map((point) => point.candidateId)).toEqual([contextual.id])
  })

  it('skips the adapter call when the idempotency key maps to an already-settled operation', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const enrich = spyEnrich()
    const candidate = await makeCandidate(em, {
      name: 'Refund Case fixture-no-result',
    })

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
    const summary = await runEnrichmentWaterfall(deps(em, ledger, [enrich], [verify], { maxCredits: 4 }))

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

  // ---------------------------------------------------------------------
  // Money-path hardening (H10, M11, M12, M13, T8, L8, L9, L10, H12)
  // ---------------------------------------------------------------------

  function committingButLostSettle(base: FixtureLedger): GtmCreditLedger {
    // The canonical ledger COMMITS the settle, then the response is lost.
    return {
      reserve: (input) => base.reserve(input),
      start: (operationId) => base.start(operationId),
      settle: async (operationId, outcome, credits, receipt) => {
        await base.settle(operationId, outcome, credits, receipt)
        throw new Error('synthetic gateway timeout after commit')
      },
      markAmbiguous: (operationId, detail) => base.markAmbiguous(operationId, detail),
      release: (operationId) => base.release(operationId),
    }
  }

  it('settle-committed-response-lost: retains found points before settle and rehydrates them instead of paying the next adapter', async () => {
    const em = new FakeEm()
    const base = new FixtureLedger({ poolBalance: 100 })
    const first = spyEnrich()
    const second: SpyEnrich = {
      descriptor: { ...fixtureEnrichDescriptor, adapter_id: 'fixture-enrich-second' },
      enrich: jest.fn(async () => ({
        status: 'ok' as const,
        data: [{ channel: 'email' as const, value: 'second@example-dynamics.example' }],
        receipt: { provider_request_id: 'req-2' },
        cost_units: 1,
      })),
    }
    const candidate = await makeCandidate(em, { name: 'Alex Example' })

    const lost = await runEnrichmentWaterfall(deps(em, committingButLostSettle(base), [first, second], []))
    expect(first.enrich).toHaveBeenCalledTimes(1)
    expect(lost).toMatchObject({ enriched: 0, ambiguous: 1, credits: 0 })
    expect(base.listOperations()[0].status).toBe('charged')
    const shadow = em.table(GtmProviderOperation)[0]
    expect(shadow.localStatusMirror).toBe('provider_started')
    expect(em.table(GtmContactPoint)).toHaveLength(0)
    // The paid-for data is in the receipt, written before settle was called.
    expect((shadow.receipt?.gtm_observation as Record<string, unknown>).retained_data).toEqual([
      expect.objectContaining({ channel: 'email', value: 'alex.example@example-dynamics.example' }),
    ])
    // The second adapter was never consulted for a candidate the first one
    // already found (and was paid for).
    expect(second.enrich).not.toHaveBeenCalled()

    // Re-run: reserve returns 'charged'; the points are rehydrated from the
    // receipt. No provider call, no new reservation, no second adapter.
    const again = await runEnrichmentWaterfall(deps(em, base, [first, second], []))
    expect(first.enrich).toHaveBeenCalledTimes(1)
    expect(second.enrich).not.toHaveBeenCalled()
    expect(base.listOperations()).toHaveLength(1)
    expect(again).toMatchObject({ enriched: 1, ambiguous: 0, credits: 0 })
    const points = em.table(GtmContactPoint)
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({
      candidateId: candidate.id,
      value: 'alex.example@example-dynamics.example',
      verificationState: 'found',
      providerOperationId: shadow.id,
    })
    expect(points[0].provenance).toEqual(expect.objectContaining({ rehydrated_from_receipt: true }))

    // A third run finds the point in the index and writes nothing new.
    const third = await runEnrichmentWaterfall(deps(em, base, [first, second], []))
    expect(third.enriched).toBe(0)
    expect(em.table(GtmContactPoint)).toHaveLength(1)
  })

  it('parks (never re-buys) a paid legacy operation whose receipt retained nothing', async () => {
    const em = new FakeEm()
    const base = new FixtureLedger({ poolBalance: 100 })
    const first = spyEnrich()
    const second = spyEnrich()
    second.descriptor = { ...fixtureEnrichDescriptor, adapter_id: 'fixture-enrich-second' }
    await makeCandidate(em, { name: 'Alex Example' })
    await runEnrichmentWaterfall(deps(em, committingButLostSettle(base), [first], []))
    // Simulate a pre-fix shadow: strip the retained data.
    const shadow = em.table(GtmProviderOperation)[0]
    const observation = shadow.receipt!.gtm_observation as Record<string, unknown>
    delete observation.retained_data

    const again = await runEnrichmentWaterfall(deps(em, base, [first, second], []))
    expect(again).toMatchObject({ enriched: 0, ambiguous: 1 })
    expect(second.enrich).not.toHaveBeenCalled()
    expect(base.listOperations()).toHaveLength(1)
  })

  it('honours the plan: a candidate whose earlier operation needs reconciliation is parked before any reserve', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const enrich = spyEnrich()
    const candidate = await makeCandidate(em, { name: 'Alex Example' })
    const summary = await runEnrichmentWaterfall(deps(em, ledger, [enrich], [], {
      existingEnrichmentOperations: [{
        candidateId: candidate.id,
        kind: 'contact_enrich',
        provider: fixtureEnrichDescriptor.adapter_id,
        localStatusMirror: 'reconciliation_required',
      }],
    }))
    expect(enrich.enrich).not.toHaveBeenCalled()
    expect(ledger.listOperations()).toHaveLength(0)
    expect(summary).toMatchObject({ ambiguous: 1, enriched: 0, candidatesConsidered: 1 })
  })

  it('L9: the enrich idempotency key carries the candidate domain, so a corrected domain is a new lookup', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const enrich: SpyEnrich = {
      descriptor: fixtureEnrichDescriptor,
      enrich: jest.fn(async () => ({ status: 'no_result' as const, data: null, receipt: {}, cost_units: 0 })),
    }
    const candidate = await makeCandidate(em, { name: 'Robin Synthetic', domain: 'wrong-company.com' })
    await runEnrichmentWaterfall(deps(em, ledger, [enrich], []))
    expect(enrich.enrich).toHaveBeenCalledTimes(1)
    expect(ledger.listOperations()[0].idempotencyKey).toMatch(/^enrich:[^:]+:fixture-enrich:d:[0-9a-f]{16}$/)
    expect(em.table(GtmProviderOperation)[0].receipt).toEqual(expect.objectContaining({
      gtm_request: expect.objectContaining({ request_fingerprint: expect.stringMatching(/^d:[0-9a-f]{16}$/) }),
    }))

    // Same domain: the settled operation is reused, no second call.
    await runEnrichmentWaterfall(deps(em, ledger, [enrich], []))
    expect(enrich.enrich).toHaveBeenCalledTimes(1)

    // Corrected domain: a genuinely new request.
    candidate.identity = { ...candidate.identity, domain: 'right-company.com' }
    await runEnrichmentWaterfall(deps(em, ledger, [enrich], []))
    expect(enrich.enrich).toHaveBeenCalledTimes(2)
    expect(ledger.listOperations()).toHaveLength(2)
  })

  it('H12: a generic-host domain never reaches the enrichment adapter', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const enrich = spyEnrich()
    await makeCandidate(em, {
      name: 'Alex Example',
      company: 'Acme Dental',
      domain: 'https://www.facebook.com/AcmeDental',
    })
    await runEnrichmentWaterfall(deps(em, ledger, [enrich], []))
    expect(enrich.enrich).toHaveBeenCalledTimes(1)
    const identity = enrich.enrich.mock.calls[0][0].candidate.identity as Record<string, unknown>
    expect(identity).not.toHaveProperty('domain')
    expect(identity.company).toBe('Acme Dental')
  })

  it('M11: trusts a LeadMagic verdict, skips the paid verifier, and stops at that verified point', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const verify = spyVerify()
    const leadmagic: SpyEnrich = {
      descriptor: { ...fixtureEnrichDescriptor, adapter_id: 'leadmagic-enrich' },
      enrich: jest.fn(async () => ({
        status: 'ok' as const,
        data: [{
          channel: 'email' as const,
          value: 'alex@acme-dental.com',
          provenance: { provider: 'leadmagic', method: 'email_finder', provider_status: 'valid' },
        }],
        receipt: { provider_request_id: 'lm-1' },
        cost_units: 1,
      })),
    }
    await makeCandidate(em, { name: 'Alex Example' })
    const summary = await runEnrichmentWaterfall(deps(em, ledger, [leadmagic], [verify]))
    expect(verify.verify).not.toHaveBeenCalled()
    expect(ledger.listOperations()).toHaveLength(1)
    const point = em.table(GtmContactPoint)[0]
    expect(point.verificationState).toBe('verified')
    expect(point.verifiedAt).toBeInstanceOf(Date)
    expect(point.provenance).toEqual(expect.objectContaining({
      verification: expect.objectContaining({ source: 'provider_status', state: 'verified', provider_status: 'valid' }),
    }))
    expect(summary).toMatchObject({ enriched: 1, verified: 1, credits: 4 })

    expect(providerVerificationState({ provider: 'leadmagic', provider_status: 'valid_catch_all' })).toBe('catch_all')
    expect(providerVerificationState({ provider: 'leadmagic', provider_status: 'invalid' })).toBe('not_found')
    expect(providerVerificationState({ provider: 'leadmagic', provider_status: 'unknown' })).toBeNull()
    // An untrusted provider's word is not a verification.
    expect(providerVerificationState({ provider: 'website-crawl', provider_status: 'valid' })).toBeNull()
    expect(providerVerificationState({ method: 'derived_pattern' })).toBeNull()
  })

  it('L10: an unknown verdict falls through to the next verifier; unknown sticks only when nobody answers', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const unsure: SpyVerify = {
      descriptor: { ...fixtureVerifyAdapter.descriptor, adapter_id: 'fixture-verify-unsure' },
      verify: jest.fn(async (request: VerifyRequest) => ({
        status: 'ok' as const,
        data: { channel: 'email' as const, value: request.value, verification_state: 'unknown' as const },
        receipt: {},
        cost_units: 1,
      })),
    }
    const sure = spyVerify()
    const candidate = await makeCandidate(em, { name: 'Holder' })
    const point = await makePoint(em, candidate, 'alex.example@example-dynamics.example')
    const summary = await runEnrichmentWaterfall(deps(em, ledger, [], [unsure, sure]))
    expect(unsure.verify).toHaveBeenCalledTimes(1)
    expect(sure.verify).toHaveBeenCalledTimes(1)
    expect(point.verificationState).toBe('verified')
    expect(summary).toMatchObject({ verified: 1, unknown: 0 })

    const lonely = await makeCandidate(em, { name: 'Lonely Holder' })
    const lonelyPoint = await makePoint(em, lonely, 'nobody@example-dynamics.example')
    const only = await runEnrichmentWaterfall(deps(em, ledger, [], [unsure], {
      candidates: [lonely], contactPoints: [lonelyPoint],
    }))
    expect(lonelyPoint.verificationState).toBe('unknown')
    expect(only).toMatchObject({ unknown: 1, verified: 0 })
  })

  it('T8: a non-ambiguous result with cost_units null is parked, never charged zero; an error with cost is charged', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const costless: SpyEnrich = {
      descriptor: fixtureEnrichDescriptor,
      enrich: jest.fn(async () => ({
        status: 'ok' as const,
        data: [{ channel: 'email' as const, value: 'free@example-dynamics.example' }],
        receipt: {},
        cost_units: null,
      })),
    }
    await makeCandidate(em, { name: 'Alex Example' })
    const summary = await runEnrichmentWaterfall(deps(em, ledger, [costless], []))
    expect(summary).toMatchObject({ enriched: 0, ambiguous: 1, credits: 0 })
    expect(em.table(GtmContactPoint)).toHaveLength(0)
    expect(ledger.listOperations()[0].status).toBe('reconciliation_required')

    const em2 = new FakeEm()
    const ledger2 = new FixtureLedger({ poolBalance: 100 })
    const billedError: SpyEnrich = {
      descriptor: { ...fixtureEnrichDescriptor, adapter_id: 'fixture-enrich-billed-error' },
      enrich: jest.fn(async () => ({
        status: 'error' as const, data: null, receipt: {}, cost_units: 1, error: 'provider failed after billing',
      })),
    }
    await makeCandidate(em2, { name: 'Alex Example' })
    const errored = await runEnrichmentWaterfall(deps(em2, ledger2, [billedError], []))
    expect(ledger2.listOperations()[0]).toMatchObject({ status: 'charged', chargedCredits: 4 })
    expect(errored.credits).toBe(4)
  })

  it('M13: a settle echo that differs from the intended outcome parks the operation and withholds the data', async () => {
    const em = new FakeEm()
    const base = new FixtureLedger({ poolBalance: 100 })
    const ledger: GtmCreditLedger = {
      reserve: (input) => base.reserve(input),
      start: (operationId) => base.start(operationId),
      settle: async (operationId, _outcome, _credits, receipt) => base.settle(operationId, 'refunded', 0, receipt),
      markAmbiguous: (operationId, detail) => base.markAmbiguous(operationId, detail),
      release: (operationId) => base.release(operationId),
    }
    const enrich = spyEnrich()
    await makeCandidate(em, { name: 'Alex Example' })
    const summary = await runEnrichmentWaterfall(deps(em, ledger, [enrich], []))
    expect(summary).toMatchObject({ enriched: 0, ambiguous: 1, credits: 0 })
    expect(em.table(GtmContactPoint)).toHaveLength(0)
    expect(em.table(GtmProviderOperation)[0].receipt).toEqual(expect.objectContaining({
      gtm_observation: expect.objectContaining({
        settlement_pending: true,
        settlement_error: expect.stringContaining('does not match intended charged'),
      }),
    }))
    expect(em.table(GtmProviderOperation)[0].settledAt).toBeUndefined()
  })

  it('M13: the reservation echo caps the provider spend cap and the settle amount', async () => {
    const em = new FakeEm()
    const base = new FixtureLedger({ poolBalance: 100 })
    const ledger: GtmCreditLedger = {
      // the ledger escrowed less than the local estimate of 4
      reserve: async (input) => ({ ...(await base.reserve(input)), reservedCredits: 3 }),
      start: (operationId) => base.start(operationId),
      settle: (operationId, outcome, credits, receipt) => base.settle(operationId, outcome, credits, receipt),
      markAmbiguous: (operationId, detail) => base.markAmbiguous(operationId, detail),
      release: (operationId) => base.release(operationId),
    }
    const enrich = spyEnrich()
    await makeCandidate(em, { name: 'Alex Example' })
    const summary = await runEnrichmentWaterfall(deps(em, ledger, [enrich], []))
    expect(summary.credits).toBe(3)
    expect(base.listOperations()[0].chargedCredits).toBe(3)
    expect(enrich.enrich.mock.calls[0][0].max_charge_usd).toBe(0.01)
    expect(em.table(GtmProviderOperation)[0].receipt).toEqual(expect.objectContaining({
      gtm_request: expect.objectContaining({ reserved_credits: 3, estimated_credits: 4 }),
    }))
  })

  it('L8: a start transport failure releases the escrow and propagates the error', async () => {
    const em = new FakeEm()
    const base = new FixtureLedger({ poolBalance: 100 })
    const ledger: GtmCreditLedger = {
      reserve: (input) => base.reserve(input),
      start: async () => { throw new Error('start transport failure') },
      settle: (operationId, outcome, credits, receipt) => base.settle(operationId, outcome, credits, receipt),
      markAmbiguous: (operationId, detail) => base.markAmbiguous(operationId, detail),
      release: (operationId) => base.release(operationId),
    }
    const enrich = spyEnrich()
    await makeCandidate(em, { name: 'Alex Example' })
    await expect(runEnrichmentWaterfall(deps(em, ledger, [enrich], []))).rejects.toThrow('start transport failure')
    expect(enrich.enrich).not.toHaveBeenCalled()
    expect(base.listOperations()[0].status).toBe('released')
    expect(base.availableCredits()).toBe(100)
    expect(em.table(GtmProviderOperation)[0].localStatusMirror).toBe('released')
  })

  it('M12: parking never propagates to duplicate addresses through the reuse map', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const verify = spyVerify()
    const parkedHolder = await makeCandidate(em, { name: 'Parked Holder' })
    await makePoint(em, parkedHolder, 'contact@fixture-ambiguous-acceptance.example', 'provider_ambiguous')
    const fresh = await makeCandidate(em, { name: 'Fresh Holder' })
    const freshPoint = await makePoint(em, fresh, 'CONTACT@fixture-ambiguous-acceptance.example')
    await runEnrichmentWaterfall(deps(em, ledger, [], [verify]))
    // The duplicate got its OWN verify call (which the fixture also parks),
    // rather than inheriting the historical parked row.
    expect(verify.verify).toHaveBeenCalledTimes(1)
    expect(freshPoint.provenance).not.toEqual(expect.objectContaining({
      verification: expect.objectContaining({ deduplicated: true }),
    }))
  })

  it('M12: resolveParkedContactPoints un-parks the rows of ONE reconciled verify operation', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const verify = spyVerify()
    const candidate = await makeCandidate(em, { name: 'Ambiguous Holder' })
    const point = await makePoint(em, candidate, 'contact@fixture-ambiguous-acceptance.example')
    const other = await makeCandidate(em, { name: 'Other Holder' })
    const otherPoint = await makePoint(em, other, 'other@fixture-ambiguous-acceptance.example')
    await runEnrichmentWaterfall(deps(em, ledger, [], [verify]))
    expect(point.verificationState).toBe('provider_ambiguous')
    expect(otherPoint.verificationState).toBe('provider_ambiguous')
    const shadowId = (point.provenance!.verification as Record<string, unknown>).provider_operation_shadow_id as string
    const ctx = { organizationId: ORG, tenantId: TENANT }

    // Still unresolved: nothing changes.
    expect(await resolveParkedContactPoints(em, ctx, { providerOperationShadowId: shadowId, canonicalStatus: 'reconciliation_required' }))
      .toEqual({ resolved: 0, state: null })
    expect(point.verificationState).toBe('provider_ambiguous')

    // Refunded: the provider never answered for money; the point can be verified again.
    expect(await resolveParkedContactPoints(em, ctx, { providerOperationShadowId: shadowId, canonicalStatus: 'refunded' }))
      .toEqual({ resolved: 1, state: 'found' })
    expect(point.verificationState).toBe('found')
    expect(point.provenance).toEqual(expect.objectContaining({
      verification: expect.objectContaining({ parked: false, resolved_from_canonical_status: 'refunded' }),
    }))
    // The other candidate's parked row belongs to a different operation.
    expect(otherPoint.verificationState).toBe('provider_ambiguous')

    // Charged with nothing retained (the ambiguous run had no verdict): honest 'unknown'.
    point.verificationState = 'provider_ambiguous'
    expect(await resolveParkedContactPoints(em, ctx, { providerOperationShadowId: shadowId, canonicalStatus: 'charged' }))
      .toEqual({ resolved: 1, state: 'unknown' })
    expect(point.verificationState).toBe('unknown')

    // Wrong tenant scope: nothing is touched.
    point.verificationState = 'provider_ambiguous'
    expect(await resolveParkedContactPoints(em, { organizationId: ORG, tenantId: '00000000-0000-4000-8000-00000000dead' }, {
      providerOperationShadowId: shadowId, canonicalStatus: 'refunded',
    })).toEqual({ resolved: 0, state: null })
    expect(point.verificationState).toBe('provider_ambiguous')
  })

  it('rehydrates a paid verification verdict whose settle response was lost', async () => {
    const em = new FakeEm()
    const base = new FixtureLedger({ poolBalance: 100 })
    const verify = spyVerify()
    const candidate = await makeCandidate(em, { name: 'Holder' })
    const point = await makePoint(em, candidate, 'alex.example@example-dynamics.example')
    const lost = await runEnrichmentWaterfall(deps(em, committingButLostSettle(base), [], [verify]))
    expect(lost).toMatchObject({ verified: 0, ambiguous: 1 })
    expect(point.verificationState).toBe('provider_ambiguous')
    // Reconciliation resolves the canonical op; then the waterfall re-run
    // sees 'charged' and takes the verdict from the retained receipt data.
    point.verificationState = 'found'
    const again = await runEnrichmentWaterfall(deps(em, base, [], [verify]))
    expect(verify.verify).toHaveBeenCalledTimes(1)
    expect(base.listOperations()).toHaveLength(1)
    expect(point.verificationState).toBe('verified')
    expect(again).toMatchObject({ verified: 1 })
    expect(point.provenance).toEqual(expect.objectContaining({
      verification: expect.objectContaining({ rehydrated_from_receipt: true, state: 'verified' }),
    }))
  })
})
