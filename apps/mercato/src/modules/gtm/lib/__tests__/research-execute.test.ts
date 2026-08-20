import { FakeEm } from './support/fake-em'
import { FixtureLedger } from '../credits/ledger'
import {
  PROVIDER_MIN_CHARGE_USD,
  creditsForUnits,
  creditsFromUsd,
  providerSpendCapUsd,
} from '../credits/markup'
import { fixtureSourceAdapter, fixtureSourceDescriptor } from '../adapters/fixture'
import type { SourceAdapter, SourceSearchPlan } from '../adapters/types'
import {
  candidateDedupeKey,
  executeResearchRun,
  type ExecuteResearchRunDeps,
} from '../research/execute'
import {
  GtmCandidate,
  GtmEvidence,
  GtmProviderOperation,
  GtmResearchRun,
} from '../../data/entities'

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const WORKSPACE = '33333333-3333-4333-8333-333333333333'
const PLAY_ID = '44444444-4444-4444-8444-444444444444'
const USER = '55555555-5555-4555-8555-555555555555'

const play = {
  id: PLAY_ID,
  signal: 'hiring_activity',
  entityUnit: 'companies',
  geography: 'US',
}

type SpyAdapter = SourceAdapter & { search: jest.Mock }

function spyAdapter(adapterId = 'fixture-source'): SpyAdapter {
  return {
    descriptor: { ...fixtureSourceDescriptor, adapter_id: adapterId },
    quote: fixtureSourceAdapter.quote,
    search: jest.fn((plan: SourceSearchPlan) => fixtureSourceAdapter.search(plan)),
  }
}

function plannedBatch(adapterId: string, units: number) {
  return {
    adapter_id: adapterId,
    capability: { signal_kind: 'hiring_activity', entity_unit: 'companies', geography: 'US' },
    estimatedUnits: units,
    quotedCreditsPerUnit: 1,
    estimatedCredits: creditsForUnits(units, 1, 2),
  }
}

function makeRun(
  em: FakeEm,
  options: {
    adapterPlan: ReturnType<typeof plannedBatch>[]
    query: string
    maxCandidates: number
    maxCredits: number
  },
): GtmResearchRun {
  return em.create(GtmResearchRun, {
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    playId: PLAY_ID,
    status: 'running',
    providerPlan: { adapterPlan: options.adapterPlan, query: options.query },
    limits: { maxCandidates: options.maxCandidates, maxCredits: options.maxCredits },
    estimatedCredits: String(
      options.adapterPlan.reduce((sum, batch) => sum + batch.estimatedCredits, 0),
    ),
  })
}

function deps(
  em: FakeEm,
  ledger: FixtureLedger,
  run: GtmResearchRun,
  adapters: SpyAdapter[],
): ExecuteResearchRunDeps {
  return {
    em,
    ledger,
    adapters: Object.fromEntries(adapters.map((adapter) => [adapter.descriptor.adapter_id, adapter])),
    run,
    play,
    userId: USER,
    markupMultiplier: 2,
  }
}

describe('executeResearchRun', () => {
  it('completes a normal run: reserve, start, search, settle, candidates, evidence', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapter = spyAdapter()
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 5)],
      query: 'companies hiring revenue operations leads',
      maxCandidates: 5,
      maxCredits: 10,
    })

    const result = await executeResearchRun(deps(em, ledger, run, [adapter]))

    // fixture pool has 3 synthetic companies: charged 3 x 1 x 2 = 6
    expect(result.status).toBe('completed')
    expect(result.candidatesInserted).toBe(3)
    expect(result.evidenceInserted).toBe(3)
    expect(result.reconciledCredits).toBe(6)
    expect(result.reconciliationRequired).toBe(false)
    expect(adapter.search).toHaveBeenCalledTimes(1)

    // run row finalized
    expect(run.status).toBe('completed')
    expect(run.reconciledCredits).toBe('6')
    expect(run.completedAt).toBeInstanceOf(Date)
    const execution = (run.providerPlan as Record<string, any>).execution
    expect(execution.reconciliation_required).toBe(false)
    expect(execution.batches).toHaveLength(1)
    expect(execution.batches[0].idempotency_key).toBe(`${run.id}:fixture-source:1`)

    // candidates qualified deterministically with retention set
    const candidates = em.table(GtmCandidate)
    expect(candidates).toHaveLength(3)
    for (const candidate of candidates) {
      expect(candidate.fitStatus).toBe('accepted')
      expect(Number(candidate.fitScore)).toBeGreaterThanOrEqual(60)
      expect(candidate.rejectReason).toBeNull()
      expect(candidate.retentionExpiresAt).toBeInstanceOf(Date)
      expect(candidate.dedupeKey).toMatch(/^[0-9a-f]{64}$/)
    }

    // evidence linked to inserted candidates and carrying provider provenance
    const candidateIds = new Set(candidates.map((candidate) => candidate.id))
    for (const evidence of em.table(GtmEvidence)) {
      expect(candidateIds.has(evidence.candidateId)).toBe(true)
      expect((evidence.providerRef as Record<string, unknown>).provider).toBe('fixture-source')
      expect(evidence.claim.length).toBeGreaterThan(0)
    }

    // shadow row mirrors the canonical operation, never a balance
    const shadows = em.table(GtmProviderOperation)
    expect(shadows).toHaveLength(1)
    expect(shadows[0].localStatusMirror).toBe('charged')
    expect(shadows[0].settledAt).toBeInstanceOf(Date)
    const op = ledger.getOperation(shadows[0].noliCoreOperationId)!
    expect(op.status).toBe('charged')
    expect(op.chargedCredits).toBe(6)
  })

  it('bounds the provider run by the credits it just reserved, markup divided back out', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 1_000_000 })
    const adapter = spyAdapter()
    // Apify sourcing economics: 25 results at the measured $0.003 each.
    const quoted = creditsFromUsd(0.003)
    const run = makeRun(em, {
      adapterPlan: [
        {
          adapter_id: 'fixture-source',
          capability: { signal_kind: 'hiring_activity', entity_unit: 'companies', geography: 'US' },
          estimatedUnits: 25,
          quotedCreditsPerUnit: quoted,
          estimatedCredits: creditsForUnits(25, quoted, 2),
        },
      ],
      query: 'companies hiring revenue operations leads',
      maxCandidates: 25,
      maxCredits: 1_000_000,
    })

    await executeResearchRun(deps(em, ledger, run, [adapter]))

    // the ledger escrowed 37,500 credits ($0.15 with our 2x markup) ...
    const reserved = ledger.listOperations()[0].estimatedCredits
    expect(reserved).toBe(37_500)
    // ... and the provider was authorized exactly the raw $0.075 it costs
    const plan = adapter.search.mock.calls[0][0]
    expect(plan.max_charge_usd).toBe(0.075)
    expect(plan.max_charge_usd).toBe(providerSpendCapUsd(reserved, 2))
    expect(plan.max_charge_usd).toBeCloseTo(25 * 0.003, 10)
  })

  it('never sends a provider cap under the $0.01 minimum for a tiny reservation', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapter = spyAdapter()
    const run = makeRun(em, {
      // 2 units x 1 quoted x 2 markup = 4 credits = $0.000008 of provider spend
      adapterPlan: [plannedBatch('fixture-source', 2)],
      query: 'companies hiring revenue operations leads',
      maxCandidates: 10,
      maxCredits: 100,
    })

    await executeResearchRun(deps(em, ledger, run, [adapter]))

    expect(adapter.search.mock.calls[0][0].max_charge_usd).toBe(PROVIDER_MIN_CHARGE_USD)
  })

  it('fails closed on insufficient credits BEFORE any adapter call', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 3 })
    const adapter = spyAdapter()
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 5)],
      query: 'companies hiring revenue operations leads',
      maxCandidates: 5,
      maxCredits: 10,
    })

    const result = await executeResearchRun(deps(em, ledger, run, [adapter]))

    expect(adapter.search).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.failureReason).toContain('insufficient_credits')
    expect(result.batches[0].outcome).toBe('blocked_insufficient_credits')
    expect(run.status).toBe('failed')
    expect(em.table(GtmCandidate)).toHaveLength(0)
    expect(em.table(GtmProviderOperation)).toHaveLength(0)
    expect(ledger.listOperations()).toHaveLength(0)
  })

  it('fails honestly when a frozen plan names an adapter that is no longer enabled', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('disabled-provider', 5)],
      query: 'companies hiring revenue operations leads',
      maxCandidates: 5,
      maxCredits: 10,
    })

    const result = await executeResearchRun(deps(em, ledger, run, []))

    expect(result.status).toBe('failed')
    expect(result.failureReason).toBe('unknown adapter disabled-provider')
    expect(result.batches[0]).toMatchObject({
      outcome: 'error',
      failureReason: 'unknown adapter disabled-provider',
    })
    expect(ledger.listOperations()).toHaveLength(0)
    expect(em.table(GtmProviderOperation)).toHaveLength(0)
  })

  it('parks an ambiguous outcome without retry and flags the run for reconciliation', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapter = spyAdapter()
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 5)],
      query: 'fixture-ambiguous-acceptance hiring',
      maxCandidates: 5,
      maxCredits: 10,
    })

    const result = await executeResearchRun(deps(em, ledger, run, [adapter]))

    // NO retry: exactly one provider call for the batch
    expect(adapter.search).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('completed')
    expect(result.reconciliationRequired).toBe(true)
    expect(result.reconciledCredits).toBe(0)
    expect((run.providerPlan as Record<string, any>).execution.reconciliation_required).toBe(true)

    const shadow = em.table(GtmProviderOperation)[0]
    expect(shadow.localStatusMirror).toBe('reconciliation_required')
    expect((shadow.receipt as Record<string, unknown>).ambiguous_at).toBeDefined()
    expect(shadow.settledAt).toBeUndefined()

    // charge stays at reserve semantics: nothing charged, reservation escrowed
    const op = ledger.getOperation(shadow.noliCoreOperationId)!
    expect(op.status).toBe('reconciliation_required')
    expect(op.chargedCredits).toBe(0)
    expect(ledger.availableCredits()).toBe(90)
  })

  it('does not double charge a delayed completion: the SAME operation settles once', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapter = spyAdapter()
    const query = 'fixture-delayed hiring'
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 5)],
      query,
      maxCandidates: 5,
      maxCredits: 10,
    })

    const result = await executeResearchRun(deps(em, ledger, run, [adapter]))
    expect(result.reconciliationRequired).toBe(true)
    expect(ledger.listOperations()).toHaveLength(1)
    const operationId = em.table(GtmProviderOperation)[0].noliCoreOperationId

    // Delayed completion later resolves the SAME provider operation (fixture
    // models this as call_sequence 2 with the same input, same operation_ref).
    const resolved = await adapter.search({
      signal_kind: 'hiring_activity',
      entity_unit: 'companies',
      geography: 'US',
      query,
      max_candidates: 5,
      call_sequence: 2,
    })
    expect(resolved.status).toBe('ok')
    const charged = creditsForUnits(resolved.cost_units!, 1, 2)
    expect(await ledger.settle(operationId, 'charged', charged, resolved.receipt)).toBe('charged')

    // A replayed settlement (webhook replay) is exactly-once: unchanged state
    expect(await ledger.settle(operationId, 'charged', charged, resolved.receipt)).toBe('charged')
    const op = ledger.getOperation(operationId)!
    expect(op.chargedCredits).toBe(charged)
    expect(ledger.listOperations()).toHaveLength(1)
    expect(ledger.availableCredits()).toBe(100 - charged)
  })

  it('stops adaptive sourcing when the accepted target is met', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapterA = spyAdapter('fixture-source')
    const adapterB = spyAdapter('fixture-source-b')
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 3), plannedBatch('fixture-source-b', 3)],
      query: 'companies hiring revenue operations leads',
      maxCandidates: 3,
      maxCredits: 100,
    })

    const result = await executeResearchRun(deps(em, ledger, run, [adapterA, adapterB]))

    expect(result.candidatesInserted).toBe(3)
    expect(adapterA.search).toHaveBeenCalledTimes(1)
    expect(adapterB.search).not.toHaveBeenCalled()
    expect(result.batches[1].outcome).toBe('skipped_target_accepted')
    expect(result.funnel).toEqual(expect.objectContaining({
      targetAccepted: 3,
      accepted: 3,
      targetMet: true,
      stopReason: 'target_accepted',
    }))
    expect(ledger.listOperations()).toHaveLength(1)
  })

  it('continues to the next source when raw rows do not satisfy the play', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapterA = spyAdapter('fixture-source')
    const adapterB = spyAdapter('fixture-source-b')
    const evidence = [{
      claim: 'Matched a provider search',
      source_url: 'https://source.example/result',
      observed_at: '2026-08-01T12:00:00.000Z',
      confidence: 0.9,
    }]
    adapterA.search.mockResolvedValue({
      status: 'ok', cost_units: 1, receipt: { provider_request_id: 'bad-1' },
      data: [{
        entity_kind: 'company',
        identity: { name: 'Poor Fit Agency', domain: 'poor-fit.example', industry: 'Advertising' },
        evidence,
      }],
    })
    adapterB.search.mockResolvedValue({
      status: 'ok', cost_units: 1, receipt: { provider_request_id: 'good-1' },
      data: [{
        entity_kind: 'company',
        identity: { name: 'Strong Fit Software', domain: 'strong-fit.example', industry: 'Software' },
        evidence,
      }],
    })
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 2), plannedBatch('fixture-source-b', 2)],
      query: 'software companies',
      maxCandidates: 4,
      maxCredits: 100,
    })
    run.limits = { targetAccepted: 1, maxRawCandidates: 4, maxCandidates: 4, maxCredits: 100 }

    const result = await executeResearchRun({
      ...deps(em, ledger, run, [adapterA, adapterB]),
      play: { ...play, providerQuery: { industries: ['Software'] } },
      now: () => new Date('2026-08-02T12:00:00.000Z'),
    })

    expect(adapterA.search).toHaveBeenCalledTimes(1)
    expect(adapterB.search).toHaveBeenCalledTimes(1)
    expect(result.funnel).toEqual(expect.objectContaining({
      rawCandidatesFound: 2,
      accepted: 1,
      rejected: 1,
      targetMet: true,
      stopReason: 'target_accepted',
    }))
  })

  it('enforces maxCredits mid-run: stops before a reserve that would exceed the cap', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapterA = spyAdapter('fixture-source')
    const adapterB = spyAdapter('fixture-source-b')
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 2), plannedBatch('fixture-source-b', 2)],
      query: 'companies hiring revenue operations leads',
      maxCandidates: 10,
      // each batch reserves 4; the second reserve would exceed 7
      maxCredits: 7,
    })

    const result = await executeResearchRun(deps(em, ledger, run, [adapterA, adapterB]))

    expect(adapterA.search).toHaveBeenCalledTimes(1)
    expect(adapterB.search).not.toHaveBeenCalled()
    expect(result.batches[1].outcome).toBe('skipped_max_credits')
    expect(ledger.listOperations()).toHaveLength(1)
    expect(result.status).toBe('completed')
  })

  it('dedupes candidates under duplicate input via the unique constraint, race-safely', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapter = spyAdapter()
    const run = makeRun(em, {
      // the same adapter planned twice produces two batches with identical
      // provider inputs, so the second batch returns the same identities
      adapterPlan: [plannedBatch('fixture-source', 3), plannedBatch('fixture-source', 3)],
      query: 'companies hiring revenue operations leads',
      maxCandidates: 10,
      maxCredits: 24,
    })

    const result = await executeResearchRun(deps(em, ledger, run, [adapter]))

    expect(adapter.search).toHaveBeenCalledTimes(2)
    expect(result.candidatesInserted).toBe(3)
    expect(result.duplicatesSkipped).toBe(3)
    expect(em.table(GtmCandidate)).toHaveLength(3)
    expect(result.batches[0].idempotencyKey).toBe(`${run.id}:fixture-source:1`)
    expect(result.batches[1].idempotencyKey).toBe(`${run.id}:fixture-source:2`)
    expect(result.batches[1].candidatesInserted).toBe(0)
    expect(result.batches[1].duplicatesSkipped).toBe(3)
  })

  it('settles refunded on a definitive no_result for a pay_on_found adapter', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapter = spyAdapter()
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 5)],
      query: 'fixture-no-result hiring',
      maxCandidates: 5,
      maxCredits: 10,
    })

    const result = await executeResearchRun(deps(em, ledger, run, [adapter]))

    expect(result.status).toBe('completed')
    expect(result.candidatesInserted).toBe(0)
    expect(result.reconciledCredits).toBe(0)
    const op = ledger.listOperations()[0]
    expect(op.status).toBe('refunded')
    expect(op.chargedCredits).toBe(0)
    // refunded reservation frees the pool again
    expect(ledger.availableCredits()).toBe(100)
  })

  it('refunds and records the failure on a definitive provider error, then continues', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapter = spyAdapter()
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 5)],
      query: 'fixture-5xx hiring',
      maxCandidates: 5,
      maxCredits: 10,
    })

    const result = await executeResearchRun(deps(em, ledger, run, [adapter]))

    expect(result.status).toBe('completed')
    expect(result.batches[0].outcome).toBe('error')
    expect(result.batches[0].failureReason).toContain('provider_5xx')
    expect(ledger.listOperations()[0].status).toBe('refunded')
    expect(em.table(GtmCandidate)).toHaveLength(0)
  })
})

describe('candidateDedupeKey', () => {
  it('normalizes case and whitespace over (entity_kind|name|domain-or-city)', () => {
    const a = candidateDedupeKey({
      entity_kind: 'company',
      identity: { name: '  Example  Dynamics LLC ', domain: 'Example-Dynamics.example' },
    })
    const b = candidateDedupeKey({
      entity_kind: 'company',
      identity: { name: 'example dynamics llc', domain: 'example-dynamics.example' },
    })
    expect(a).toBe(b)
  })

  it('distinguishes entity kinds and identity material', () => {
    const company = candidateDedupeKey({
      entity_kind: 'company',
      identity: { name: 'Example Dynamics LLC', domain: 'example-dynamics.example' },
    })
    const person = candidateDedupeKey({
      entity_kind: 'person',
      identity: { name: 'Example Dynamics LLC', domain: 'example-dynamics.example' },
    })
    const otherDomain = candidateDedupeKey({
      entity_kind: 'company',
      identity: { name: 'Example Dynamics LLC', domain: 'other.example' },
    })
    expect(person).not.toBe(company)
    expect(otherDomain).not.toBe(company)
  })
})
