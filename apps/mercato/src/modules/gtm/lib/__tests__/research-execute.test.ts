import { FakeEm } from './support/fake-em'
import { FixtureLedger } from '../credits/ledger'
import { PROVIDER_MIN_CHARGE_USD, creditsForUnits, creditsFromUsd, providerSpendCapUsd } from '../credits/markup'
import { fixtureSourceAdapter, fixtureSourceDescriptor } from '../adapters/fixture'
import type { SourceAdapter, SourceSearchPlan } from '../adapters/types'
import {
  RETAINED_OUTPUT_RECEIPT_KEY,
  candidateDedupeKey,
  candidateIdentityHashes,
  executeResearchRun,
  type ExecuteResearchRunDeps,
} from '../research/execute'
import { descriptorHash } from '../research/plan'
import { replayParkedProviderOutput, replayPendingSettlements } from '../reconciliation/operator'
import {
  OPPORTUNITY_DESTINATION_VALIDATION_MAX_BODY_BYTES,
  OPPORTUNITY_DESTINATION_VALIDATION_MAX_REDIRECTS,
  OPPORTUNITY_DESTINATION_VALIDATION_TIMEOUT_MS,
  OPPORTUNITY_DESTINATION_VALIDATION_VERSION,
} from '../research/opportunity-destination-contract'
import type { FitResult, FitScorer } from '../research/qualify'
import {
  GtmAuditEvent,
  GtmCandidate,
  GtmCandidateMatch,
  GtmEvidence,
  GtmProviderOperation,
  GtmResearchRun,
  GtmSuppression,
} from '../../data/entities'

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const WORKSPACE = '33333333-3333-4333-8333-333333333333'
const PLAY_ID = '44444444-4444-4444-8444-444444444444'
const USER = '55555555-5555-4555-8555-555555555555'
const NOLI_ORG = '66666666-6666-4666-8666-666666666666'

const play = {
  id: PLAY_ID,
  signal: 'hiring_activity',
  entityUnit: 'companies',
  geography: 'US',
  // H3: a row with zero evaluated criteria can no longer reach accept on
  // field presence alone, so the fixture companies are accepted through an
  // evidence-backed keyword criterion each of their claims satisfies.
  providerQuery: { company_keywords: ['revenue operations', 'seed round', 'office lease'] },
}
const ctx = { organizationId: ORG, tenantId: TENANT, userId: USER }

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
    capability: {
      signal_kind: 'hiring_activity',
      entity_unit: 'companies',
      geography: 'US',
    },
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
    limits: {
      maxCandidates: options.maxCandidates,
      maxCredits: options.maxCredits,
    },
    estimatedCredits: String(options.adapterPlan.reduce((sum, batch) => sum + batch.estimatedCredits, 0)),
  })
}

function deps(em: FakeEm, ledger: FixtureLedger, run: GtmResearchRun, adapters: SpyAdapter[]): ExecuteResearchRunDeps {
  return {
    em,
    ledger,
    adapters: Object.fromEntries(adapters.map((adapter) => [adapter.descriptor.adapter_id, adapter])),
    run,
    play,
    noliOrgId: NOLI_ORG,
    noliUserId: USER,
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
    expect(result.candidateMatchesCreated).toBe(3)
    expect(result.candidatesReused).toBe(0)
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
    expect(em.table(GtmCandidateMatch)).toHaveLength(3)
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
    expect(op.orgId).toBe(NOLI_ORG)
    expect(op.userId).toBe(USER)
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
          capability: {
            signal_kind: 'hiring_activity',
            entity_unit: 'companies',
            geography: 'US',
          },
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

  it('persists the provider receipt before settlement and never retries when settlement fails', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapter = spyAdapter()
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 5)],
      query: 'companies hiring revenue operations leads',
      maxCandidates: 5,
      maxCredits: 10,
    })
    jest.spyOn(ledger, 'settle').mockRejectedValueOnce(new Error('canonical ledger unavailable'))

    const result = await executeResearchRun(deps(em, ledger, run, [adapter]))

    expect(adapter.search).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      status: 'completed',
      reconciliationRequired: true,
      reconciledCredits: 0,
      candidatesInserted: 0,
      funnel: { stopReason: 'unresolved_provider_outcome' },
    })
    expect(result.batches[0]).toMatchObject({
      outcome: 'ambiguous',
      ledgerStatus: 'provider_started',
      chargedCredits: 6,
      failureReason: 'canonical ledger outcome unresolved after provider response',
    })
    const shadow = em.table(GtmProviderOperation)[0]
    expect(shadow.localStatusMirror).toBe('provider_started')
    expect(shadow.settledAt).toBeUndefined()
    expect(shadow.receipt).toEqual(
      expect.objectContaining({
        provider_request_id: expect.any(String),
        gtm_observation: expect.objectContaining({
          adapter_status: 'ok',
          intended_ledger_action: 'charged',
          intended_charged_credits: 6,
          settlement_pending: true,
          canonical_status: 'provider_started',
          settlement_error: expect.stringContaining('canonical ledger unavailable'),
        }),
      }),
    )
    expect(ledger.listOperations()[0].status).toBe('provider_started')

    // A replay sees the same parked operation and cannot contact the provider.
    await executeResearchRun(deps(em, ledger, run, [adapter]))
    expect(adapter.search).toHaveBeenCalledTimes(1)
    expect(ledger.listOperations()).toHaveLength(1)
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
    expect(result.funnel).toEqual(
      expect.objectContaining({
        targetAccepted: 3,
        accepted: 3,
        targetMet: true,
        stopReason: 'target_accepted',
      }),
    )
    expect(ledger.listOperations()).toHaveLength(1)
  })

  it('continues to the next source when raw rows do not satisfy the play', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapterA = spyAdapter('fixture-source')
    const adapterB = spyAdapter('fixture-source-b')
    const evidence = [
      {
        claim: 'Matched a provider search',
        source_url: 'https://source.example/result',
        observed_at: '2026-08-01T12:00:00.000Z',
        confidence: 0.9,
      },
    ]
    adapterA.search.mockResolvedValue({
      status: 'ok',
      cost_units: 1,
      receipt: { provider_request_id: 'bad-1' },
      data: [
        {
          entity_kind: 'company',
          identity: {
            name: 'Poor Fit Agency',
            domain: 'poor-fit.example',
            industry: 'Advertising',
          },
          evidence,
        },
      ],
    })
    adapterB.search.mockResolvedValue({
      status: 'ok',
      cost_units: 1,
      receipt: { provider_request_id: 'good-1' },
      data: [
        {
          entity_kind: 'company',
          identity: {
            name: 'Strong Fit Software',
            domain: 'strong-fit.example',
            industry: 'Software',
          },
          evidence,
        },
      ],
    })
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 2), plannedBatch('fixture-source-b', 2)],
      query: 'software companies',
      maxCandidates: 4,
      maxCredits: 100,
    })
    run.limits = {
      targetAccepted: 1,
      maxRawCandidates: 4,
      maxCandidates: 4,
      maxCredits: 100,
    }

    const result = await executeResearchRun({
      ...deps(em, ledger, run, [adapterA, adapterB]),
      play: { ...play, providerQuery: { industries: ['Software'] } },
      now: () => new Date('2026-08-02T12:00:00.000Z'),
    })

    expect(adapterA.search).toHaveBeenCalledTimes(1)
    expect(adapterB.search).toHaveBeenCalledTimes(1)
    expect(result.funnel).toEqual(
      expect.objectContaining({
        rawCandidatesFound: 2,
        accepted: 1,
        rejected: 1,
        targetMet: true,
        stopReason: 'target_accepted',
      }),
    )
  })

  it('continues the same source with the frozen offset when a full page misses the accepted target', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapter = spyAdapter('fixture-source')
    const evidence = [
      {
        claim: 'Matched a provider search',
        source_url: 'https://source.example/result',
        observed_at: '2026-08-01T12:00:00.000Z',
        confidence: 0.9,
      },
    ]
    adapter.search
      .mockResolvedValueOnce({
        status: 'ok',
        cost_units: 1,
        receipt: { provider_request_id: 'page-1', returned_people: 1 },
        data: [
          {
            entity_kind: 'company',
            identity: {
              name: 'Poor Fit Agency',
              domain: 'poor-fit.example',
              industry: 'Advertising',
            },
            evidence,
          },
        ],
      })
      .mockResolvedValueOnce({
        status: 'ok',
        cost_units: 1,
        receipt: { provider_request_id: 'page-2', returned_people: 1 },
        data: [
          {
            entity_kind: 'company',
            identity: {
              name: 'Strong Fit Software',
              domain: 'strong-fit.example',
              industry: 'Software',
            },
            evidence,
          },
        ],
      })
    const first = {
      ...plannedBatch('fixture-source', 1),
      maxCandidates: 1,
      providerUnits: 1,
      continuationPage: 1,
      continuationOffset: 0,
    }
    const second = {
      ...plannedBatch('fixture-source', 1),
      maxCandidates: 1,
      providerUnits: 1,
      continuationPage: 2,
      continuationOffset: 1,
    }
    const run = makeRun(em, {
      adapterPlan: [first, second],
      query: 'software companies',
      maxCandidates: 2,
      maxCredits: 100,
    })
    run.limits = {
      targetAccepted: 1,
      maxRawCandidates: 2,
      maxCandidates: 2,
      maxCredits: 100,
    }

    const result = await executeResearchRun({
      ...deps(em, ledger, run, [adapter]),
      play: { ...play, providerQuery: { industries: ['Software'] } },
      now: () => new Date('2026-08-02T12:00:00.000Z'),
    })

    expect(adapter.search).toHaveBeenCalledTimes(2)
    expect(adapter.search.mock.calls.map((call) => call[0].offset)).toEqual([0, 1])
    expect(result.funnel).toEqual(expect.objectContaining({ accepted: 1, targetMet: true }))
    expect(result.batches.map((batch) => batch.outcome)).toEqual(['ok', 'ok'])
  })

  it.each([
    ['no_result', 'skipped_source_exhausted'],
    ['ambiguous', 'skipped_source_unresolved'],
  ])('does not dispatch a continuation after a %s first page', async (status, skippedOutcome) => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapter = spyAdapter('fixture-source')
    adapter.search.mockResolvedValueOnce({
      status,
      cost_units: status === 'ambiguous' ? null : 0,
      receipt: { provider_request_id: 'page-1', returned_people: 0 },
      data: null,
      ...(status === 'ambiguous' ? { error: 'provider outcome unknown' } : {}),
    })
    const run = makeRun(em, {
      adapterPlan: [
        {
          ...plannedBatch('fixture-source', 1),
          maxCandidates: 1,
          providerUnits: 1,
          continuationPage: 1,
          continuationOffset: 0,
        },
        {
          ...plannedBatch('fixture-source', 1),
          maxCandidates: 1,
          providerUnits: 1,
          continuationPage: 2,
          continuationOffset: 1,
        },
      ],
      query: 'companies',
      maxCandidates: 2,
      maxCredits: 100,
    })

    const result = await executeResearchRun(deps(em, ledger, run, [adapter]))

    expect(adapter.search).toHaveBeenCalledTimes(1)
    expect(result.batches[1].outcome).toBe(skippedOutcome)
    expect(ledger.listOperations()).toHaveLength(1)
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
    expect(result.candidateMatchesCreated).toBe(3)
    expect(result.duplicatesSkipped).toBe(3)
    expect(em.table(GtmCandidate)).toHaveLength(3)
    expect(em.table(GtmCandidateMatch)).toHaveLength(3)
    expect(result.batches[0].idempotencyKey).toBe(`${run.id}:fixture-source:1`)
    expect(result.batches[1].idempotencyKey).toBe(`${run.id}:fixture-source:2`)
    expect(result.batches[1].candidatesInserted).toBe(0)
    expect(result.batches[1].duplicatesSkipped).toBe(3)
  })

  it('reuses workspace identities but records an independent qualification for a later run', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 200 })
    const adapter = spyAdapter()
    const first = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 3)],
      query: 'companies hiring revenue operations leads',
      maxCandidates: 3,
      maxCredits: 12,
    })
    const second = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 3)],
      query: 'the same companies for a later frozen play evaluation',
      maxCandidates: 3,
      maxCredits: 12,
    })

    const firstResult = await executeResearchRun(deps(em, ledger, first, [adapter]))
    const secondResult = await executeResearchRun(deps(em, ledger, second, [adapter]))

    expect(firstResult.candidatesInserted).toBe(3)
    expect(secondResult.candidatesInserted).toBe(0)
    expect(secondResult.candidatesReused).toBe(3)
    expect(secondResult.candidateMatchesCreated).toBe(3)
    expect(secondResult.duplicatesSkipped).toBe(0)
    expect(secondResult.funnel.accepted).toBe(3)
    expect(secondResult.funnel.acceptanceRate).toBe(1)
    expect(em.table(GtmCandidate)).toHaveLength(3)
    expect(em.table(GtmCandidateMatch)).toHaveLength(6)
    expect(em.table(GtmCandidateMatch).filter((row) => row.researchRunId === second.id)).toHaveLength(3)
    expect(em.table(GtmEvidence).filter((row) => row.researchRunId === second.id)).toHaveLength(3)
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

  it('refunds and fails honestly when every contacted provider returns a definitive error', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapter = spyAdapter()
    // The fixture's provider_5xx trigger now models the real client (a 5xx
    // after dispatch is ambiguous), so a definitive pre-dispatch error is
    // mocked here to keep this refund path covered.
    adapter.search.mockResolvedValue({
      status: 'error',
      data: null,
      cost_units: 0,
      receipt: { provider_request_id: 'fixture-5xx', http_status: 400 },
      error: 'provider_5xx: request rejected before dispatch',
    })
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 5)],
      query: 'fixture-5xx hiring',
      maxCandidates: 5,
      maxCredits: 10,
    })

    const result = await executeResearchRun(deps(em, ledger, run, [adapter]))

    expect(result.status).toBe('failed')
    expect(result.funnel.stopReason).toBe('failed')
    expect(result.failureReason).toContain('provider_5xx')
    expect(result.batches[0].outcome).toBe('error')
    expect(result.batches[0].failureReason).toContain('provider_5xx')
    expect(ledger.listOperations()[0].status).toBe('refunded')
    expect(em.table(GtmCandidate)).toHaveLength(0)
  })

  it('charges an explicit final provider cost even when the provider outcome is a definitive error', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapter = spyAdapter()
    adapter.search.mockResolvedValue({
      status: 'error',
      data: null,
      cost_units: 2,
      receipt: { provider_status: 'application_error', task_cost_units: 2 },
      error: 'provider_application_error: request was processed but failed',
    })
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 5)],
      query: 'a definitive provider error with final billed cost',
      maxCandidates: 5,
      maxCredits: 10,
    })

    const result = await executeResearchRun(deps(em, ledger, run, [adapter]))

    expect(result.status).toBe('failed')
    expect(result.reconciledCredits).toBe(4)
    expect(result.batches[0]).toMatchObject({
      outcome: 'error',
      ledgerStatus: 'charged',
      chargedCredits: 4,
    })
    expect(ledger.listOperations()[0]).toMatchObject({
      status: 'charged',
      chargedCredits: 4,
    })
  })
})

describe('money and output safety (adversarial review fixes)', () => {
  const opportunityPlan = (adapterId: string, units: number) => ({
    ...plannedBatch(adapterId, units),
    capability: {
      signal_kind: 'demand_surface',
      entity_unit: 'opportunities',
      entity_kind: 'opportunity' as const,
      geography: 'Austin, Texas',
    },
  })
  const opportunityRow = (name: string, url: string) => ({
    entity_kind: 'opportunity' as const,
    identity: {
      name,
      opportunity_kind: 'thread' as const,
      platform: 'Reddit',
      audience_description: `${name}: I am buying my first home in Austin and need advice.`,
      access_type: 'public' as const,
      source_published_at: '2026-08-28T10:00:00.000Z',
      urls: [url],
      participation_rules_status: 'unverified' as const,
      recommended_action: 'Read the public thread and contribute one useful response manually.',
      message_angle: 'Answer the buyer question before mentioning professional help.',
    },
    evidence: [{
      claim: name,
      source_url: url,
      observed_at: '2026-08-29T12:00:00.000Z',
      confidence: 0.85,
      detail: { published_at: '2026-08-28T10:00:00.000Z' },
    }],
  })
  const fixedScorer = (verdict: FitResult['verdict']): FitScorer => ({
    score: () => ({
      fitScore: verdict === 'accepted' ? 90 : verdict === 'review' ? 60 : 10,
      verdict,
      reason: verdict === 'accepted' ? 'meets_fit_rules' : verdict === 'review' ? 'insufficient_decisive_fit_data' : 'below_fit_threshold',
      version: 'fit-v7',
      breakdown: { identity: 0, account: 0, persona: 0, geography: 0, evidence: 0 },
      unknowns: [],
      contradictions: [],
    }),
  })

  it('retains provider rows before settlement and replays them once the operation settles (C2 + M5)', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapter = spyAdapter()
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 5)],
      query: 'companies hiring revenue operations leads',
      maxCandidates: 5,
      maxCredits: 10,
    })
    run.inputSnapshot = {
      play: { entity_unit: 'companies', geography: 'US', provider_query: play.providerQuery },
    }
    jest.spyOn(ledger, 'settle').mockRejectedValueOnce(new Error('canonical ledger unavailable'))

    const result = await executeResearchRun(deps(em, ledger, run, [adapter]))
    expect(result.candidatesInserted).toBe(0)
    const shadow = em.table(GtmProviderOperation)[0]
    const receipt = shadow.receipt as Record<string, any>
    expect(receipt.gtm_observation.output_retained).toBe(true)
    expect(receipt[RETAINED_OUTPUT_RECEIPT_KEY]).toMatchObject({
      adapter_id: 'fixture-source',
      entity_kind: 'company',
      row_count: 3,
      retained_count: 3,
      truncated: false,
      materialized_at: null,
    })
    expect(receipt[RETAINED_OUTPUT_RECEIPT_KEY].rows).toHaveLength(3)

    // Output cannot be replayed while the operation is still unsettled.
    await expect(replayParkedProviderOutput({ em, ctx, operationId: shadow.id }))
      .rejects.toMatchObject({ code: 'illegal_state' })

    // The pending settlement replays the SAME decision on the SAME id.
    const replayed = await replayPendingSettlements(em, ledger, ctx)
    expect(replayed.settled).toEqual([
      expect.objectContaining({ operationId: shadow.id, status: 'charged' }),
    ])
    expect(ledger.getOperation(shadow.noliCoreOperationId)).toMatchObject({ status: 'charged', chargedCredits: 6 })
    expect(shadow.localStatusMirror).toBe('charged')
    expect((shadow.receipt as Record<string, any>).gtm_observation.settlement_pending).toBe(false)
    expect(shadow.settledAt).toBeInstanceOf(Date)
    expect(await replayPendingSettlements(em, ledger, ctx)).toMatchObject({ scanned: 0, settled: [] })

    // Now the retained rows become the customer's candidates.
    const output = await replayParkedProviderOutput({ em, ctx, operationId: shadow.id })
    expect(output).toMatchObject({ idempotent: false, rowsReplayed: 3, candidatesInserted: 3, candidateMatchesCreated: 3 })
    expect(em.table(GtmCandidate)).toHaveLength(3)
    expect(em.table(GtmCandidateMatch).every((row) => row.providerOperationId === shadow.id)).toBe(true)
    expect(em.table(GtmEvidence)).toHaveLength(3)
    expect((shadow.receipt as Record<string, any>)[RETAINED_OUTPUT_RECEIPT_KEY]).toMatchObject({
      rows: [],
      materialized_at: expect.any(String),
    })
    expect(em.table(GtmAuditEvent).some((row) => row.action === 'gtm.provider_operation.output_replayed')).toBe(true)
    expect((run.providerPlan as Record<string, any>).execution.candidates_inserted).toBe(3)

    // Idempotent: a second replay materializes nothing.
    expect(await replayParkedProviderOutput({ em, ctx, operationId: shadow.id }))
      .toMatchObject({ idempotent: true, rowsReplayed: 0, candidatesInserted: 0 })
    expect(em.table(GtmCandidate)).toHaveLength(3)
  })

  it('drops the retained payload from the receipt once rows are materialized in the same run', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 5)],
      query: 'companies hiring revenue operations leads',
      maxCandidates: 5,
      maxCredits: 10,
    })
    await executeResearchRun(deps(em, ledger, run, [spyAdapter()]))
    const receipt = em.table(GtmProviderOperation)[0].receipt as Record<string, any>
    expect(receipt[RETAINED_OUTPUT_RECEIPT_KEY]).toMatchObject({ rows: [], row_count: 3, materialized_at: expect.any(String) })
  })

  it('parks a completed call whose final cost is unknown as ambiguous instead of charging zero (T8)', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapter = spyAdapter()
    adapter.search.mockResolvedValue({
      status: 'ok',
      cost_units: null,
      receipt: { provider_request_id: 'no-cost-1' },
      data: [{
        entity_kind: 'company',
        identity: { name: 'Costless Co', domain: 'costless.example' },
        evidence: [{ claim: 'seed round', source_url: 'https://source.example/r', observed_at: '2026-08-01T12:00:00.000Z', confidence: 0.9 }],
      }],
    })
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 5)],
      query: 'companies',
      maxCandidates: 5,
      maxCredits: 10,
    })

    const result = await executeResearchRun(deps(em, ledger, run, [adapter]))

    expect(result.reconciliationRequired).toBe(true)
    expect(result.reconciledCredits).toBe(0)
    expect(result.candidatesInserted).toBe(0)
    expect(result.batches[0]).toMatchObject({
      outcome: 'ambiguous',
      ledgerStatus: 'reconciliation_required',
      failureReason: 'provider reported no final cost for a completed call',
    })
    expect(ledger.listOperations()[0].status).toBe('reconciliation_required')
    const receipt = em.table(GtmProviderOperation)[0].receipt as Record<string, any>
    expect(receipt.gtm_observation.intended_ledger_action).toBe('mark_ambiguous')
    // The paid row is retained for replay after the operator decides.
    expect(receipt[RETAINED_OUTPUT_RECEIPT_KEY].rows).toHaveLength(1)
  })

  it('fails a batch whose live descriptor no longer matches the frozen quote BEFORE reserving (M2)', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapter = spyAdapter()
    const run = makeRun(em, {
      adapterPlan: [{
        ...plannedBatch('fixture-source', 5),
        descriptorHash: descriptorHash(adapter.descriptor),
        priceVersion: 'stale-price-version',
        termsVersion: adapter.descriptor.constraints.license.terms_version,
      }],
      query: 'companies hiring revenue operations leads',
      maxCandidates: 5,
      maxCredits: 10,
    })

    const result = await executeResearchRun(deps(em, ledger, run, [adapter]))

    expect(adapter.search).not.toHaveBeenCalled()
    expect(ledger.listOperations()).toHaveLength(0)
    expect(result.status).toBe('failed')
    expect(result.batches[0]).toMatchObject({ outcome: 'error', failureReason: 'descriptor changed after quote confirmation' })

    // An exact match still executes.
    const current = makeRun(em, {
      adapterPlan: [{
        ...plannedBatch('fixture-source', 5),
        descriptorHash: descriptorHash(adapter.descriptor),
        priceVersion: adapter.descriptor.cost_model.price_version,
        termsVersion: adapter.descriptor.constraints.license.terms_version,
      }],
      query: 'companies hiring revenue operations leads',
      maxCandidates: 5,
      maxCredits: 10,
    })
    expect((await executeResearchRun(deps(em, ledger, current, [adapter]))).status).toBe('completed')
  })

  it('releases the canonical reservation when the shadow row cannot be written (M4)', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapter = spyAdapter()
    const release = jest.spyOn(ledger, 'release')
    // The first flush after reserve is the shadow insert.
    jest.spyOn(em, 'flush').mockRejectedValueOnce(new Error('database unavailable'))
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 5)],
      query: 'companies hiring revenue operations leads',
      maxCandidates: 5,
      maxCredits: 10,
    })

    await expect(executeResearchRun(deps(em, ledger, run, [adapter]))).rejects.toThrow('database unavailable')

    expect(adapter.search).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
    expect(ledger.listOperations()[0].status).toBe('released')
    expect(ledger.availableCredits()).toBe(100)
  })

  it('skips a person suppressed under any of its identity hashes, not only the primary key (C3)', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const adapter = spyAdapter()
    const fingerprint = 'b'.repeat(64)
    const person = {
      entity_kind: 'person' as const,
      identity: {
        name: 'Jane Doe',
        title: 'Realtor',
        urls: ['https://www.linkedin.com/in/jane-doe'],
        linkedin_engagement_fingerprint: fingerprint,
      },
      evidence: [{ claim: 'Commented on a public post', source_url: 'https://www.linkedin.com/posts/x', observed_at: '2026-08-01T12:00:00.000Z', confidence: 0.9 }],
    }
    adapter.search.mockResolvedValue({ status: 'ok', cost_units: 1, receipt: { provider_request_id: 'p-1' }, data: [person] })
    // Legacy suppression written under the fingerprint key (the old primary).
    const legacyHash = candidateDedupeKey({ entity_kind: 'person', identity: { name: 'Jane Doe', linkedin_engagement_fingerprint: fingerprint } })
    em.persist(em.create(GtmSuppression, {
      organizationId: '00000000-0000-0000-0000-000000000000',
      tenantId: '00000000-0000-0000-0000-000000000000',
      scope: 'global',
      channel: 'public_profile',
      addressHash: legacyHash,
      reason: 'removal_request',
    }))
    await em.flush()
    const run = makeRun(em, {
      adapterPlan: [{ ...plannedBatch('fixture-source', 1), capability: { signal_kind: 'hiring_activity', entity_unit: 'people', entity_kind: 'person' as const, geography: 'US' } }],
      query: 'people',
      maxCandidates: 1,
      maxCredits: 10,
    })

    const result = await executeResearchRun({ ...deps(em, ledger, run, [adapter]), play: { ...play, entityUnit: 'people' } })

    expect(legacyHash).not.toBe(candidateDedupeKey(person))
    expect(result.suppressedSkipped).toBe(1)
    expect(em.table(GtmCandidate)).toHaveLength(0)
  })

  it('keeps a human root verdict when a later run re-sources the same opportunity (H5)', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 200 })
    const adapter = spyAdapter()
    const url = 'https://www.reddit.com/r/Austin/comments/1abc23/first_home/'
    adapter.search.mockResolvedValue({ status: 'ok', cost_units: 1, receipt: { provider_request_id: 'op-1' }, data: [opportunityRow('First home in Austin', url)] })
    const opportunityPlay = { ...play, entityUnit: 'opportunities', geography: 'Austin, Texas', providerQuery: null }
    const first = makeRun(em, { adapterPlan: [opportunityPlan('fixture-source', 1)], query: 'austin buyers', maxCandidates: 1, maxCredits: 10 })
    await executeResearchRun({ ...deps(em, ledger, first, [adapter]), play: opportunityPlay, scorer: fixedScorer('accepted'), destinationValidationEnabled: false })
    const row = em.table(GtmCandidate)[0]
    expect(row.fitStatus).toBe('accepted')

    // Human rejects the root row.
    row.fitStatus = 'rejected'
    row.rejectReason = 'manual_review_rejected'
    em.persist(em.create(GtmAuditEvent, {
      organizationId: ORG,
      tenantId: TENANT,
      actor: 'user_id',
      actorUserId: USER,
      action: 'gtm.candidate.review_override',
      objectType: 'gtm_candidate',
      objectId: row.id,
      metadata: { verdict: 'rejected', research_run_id: first.id },
    }))
    await em.flush()

    const second = makeRun(em, { adapterPlan: [opportunityPlan('fixture-source', 1)], query: 'austin buyers again', maxCandidates: 1, maxCredits: 10 })
    const result = await executeResearchRun({ ...deps(em, ledger, second, [adapter]), play: opportunityPlay, scorer: fixedScorer('accepted'), destinationValidationEnabled: false })

    expect(result.candidatesReused).toBe(1)
    expect(row.fitStatus).toBe('rejected')
    expect(row.rejectReason).toBe('manual_review_rejected')
    // The new run still records its own independent qualification.
    expect(em.table(GtmCandidateMatch).find((match) => match.researchRunId === second.id)?.fitStatus).toBe('accepted')
  })

  it('validates each distinct destination once and counts review rows toward an opportunity target (M4 + C1b)', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 200 })
    const adapterA = spyAdapter('fixture-source')
    const adapterB = spyAdapter('fixture-source-b')
    const thread = 'https://www.reddit.com/r/Austin/comments/1abc23/first_home/'
    adapterA.search.mockResolvedValue({
      status: 'ok',
      cost_units: 3,
      receipt: { provider_request_id: 'op-1' },
      data: [
        opportunityRow('First home in Austin', thread),
        opportunityRow('First home in Austin (sorted)', `${thread}?sort=top`),
        opportunityRow('Neighborhood meetings', 'https://windsorpark.example/meetings'),
      ],
    })
    const validator = jest.fn(async (candidate) => ({ candidate, outcome: 'unknown' as const }))
    const run = makeRun(em, {
      adapterPlan: [opportunityPlan('fixture-source', 3), opportunityPlan('fixture-source-b', 3)],
      query: 'austin buyers',
      maxCandidates: 6,
      maxCredits: 100,
    })
    run.limits = { targetAccepted: 2, maxRawCandidates: 6, maxCredits: 100 }
    ;(run.providerPlan as Record<string, unknown>).destinationValidation = {
      version: OPPORTUNITY_DESTINATION_VALIDATION_VERSION,
      enabled: true,
      maxAttempts: 5,
      maxRedirects: OPPORTUNITY_DESTINATION_VALIDATION_MAX_REDIRECTS,
      timeoutMs: OPPORTUNITY_DESTINATION_VALIDATION_TIMEOUT_MS,
      maxBodyBytes: OPPORTUNITY_DESTINATION_VALIDATION_MAX_BODY_BYTES,
      socialNetworkPolicy: 'provider_evidence_only',
    }

    const result = await executeResearchRun({
      ...deps(em, ledger, run, [adapterA, adapterB]),
      play: { ...play, entityUnit: 'opportunities', geography: 'Austin, Texas', providerQuery: null },
      scorer: fixedScorer('review'),
      destinationValidator: validator,
    })

    // Two distinct destinations, one validation each; the ?sort=top variant
    // is a duplicate and never consumes the cap.
    expect(validator).toHaveBeenCalledTimes(2)
    expect(result.destinationValidation.attempted).toBe(2)
    expect(result.batches[0].duplicatesSkipped).toBe(1)
    expect(result.funnel).toEqual(expect.objectContaining({ accepted: 0, review: 2, targetMet: true, stopReason: 'target_accepted' }))
    expect(result.batches[1].outcome).toBe('skipped_target_accepted')
    expect(adapterB.search).not.toHaveBeenCalled()
  })

  it('keeps the strict accepted target for person and company plays (C1b scope)', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 200 })
    const adapterA = spyAdapter('fixture-source')
    const adapterB = spyAdapter('fixture-source-b')
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 3), plannedBatch('fixture-source-b', 3)],
      query: 'companies hiring revenue operations leads',
      maxCandidates: 6,
      maxCredits: 100,
    })
    run.limits = { targetAccepted: 3, maxRawCandidates: 6, maxCredits: 100 }
    const result = await executeResearchRun({ ...deps(em, ledger, run, [adapterA, adapterB]), scorer: fixedScorer('review') })
    // Both fixtures return the same three companies; the second batch is
    // still contacted because review rows do not satisfy a company target.
    expect(result.funnel.review).toBe(3)
    expect(result.funnel.targetMet).toBe(false)
    expect(adapterB.search).toHaveBeenCalledTimes(1)
  })

  it('caps a legacy maxCandidates-only target at the plan default (L3)', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const run = makeRun(em, {
      adapterPlan: [plannedBatch('fixture-source', 3)],
      query: 'companies hiring revenue operations leads',
      maxCandidates: 100,
      maxCredits: 100,
    })
    const result = await executeResearchRun(deps(em, ledger, run, [spyAdapter()]))
    expect(result.funnel.targetAccepted).toBe(25)
  })
})

describe('candidateDedupeKey', () => {
  it('normalizes case and whitespace over (entity_kind|name|domain-or-city)', () => {
    const a = candidateDedupeKey({
      entity_kind: 'company',
      identity: {
        name: '  Example  Dynamics LLC ',
        domain: 'Example-Dynamics.example',
      },
    })
    const b = candidateDedupeKey({
      entity_kind: 'company',
      identity: {
        name: 'example dynamics llc',
        domain: 'example-dynamics.example',
      },
    })
    expect(a).toBe(b)
  })

  it('distinguishes entity kinds and identity material', () => {
    const company = candidateDedupeKey({
      entity_kind: 'company',
      identity: {
        name: 'Example Dynamics LLC',
        domain: 'example-dynamics.example',
      },
    })
    const person = candidateDedupeKey({
      entity_kind: 'person',
      identity: {
        name: 'Example Dynamics LLC',
        domain: 'example-dynamics.example',
      },
    })
    const otherDomain = candidateDedupeKey({
      entity_kind: 'company',
      identity: { name: 'Example Dynamics LLC', domain: 'other.example' },
    })
    expect(person).not.toBe(company)
    expect(otherDomain).not.toBe(company)
  })

  it('uses a canonical LinkedIn profile URL for person identity', () => {
    const first = candidateDedupeKey({
      entity_kind: 'person',
      identity: {
        name: 'Alex Example',
        city: 'San Diego',
        urls: ['https://www.linkedin.com/in/Alex-Example/'],
      },
    })
    const renamed = candidateDedupeKey({
      entity_kind: 'person',
      identity: {
        name: 'Alexandra Example',
        city: 'Los Angeles',
        urls: ['https://linkedin.com/in/alex-example'],
      },
    })
    const providerAlias = candidateDedupeKey({
      entity_kind: 'person',
      identity: {
        name: 'A. Example',
        linkedin_url: 'https://www.linkedin.com/in/alex-example?trk=public_profile',
      },
    })
    expect(first).toBe(renamed)
    expect(first).toBe(providerAlias)
  })

  it('prefers the canonical profile URL over the engagement fingerprint and exposes every identity hash (C3)', () => {
    // This test used to assert the opposite: keyed by sha256(name|title),
    // two different "Dana Reyes | Broker/Owner" people merged into one row
    // and a profile-URL removal could not find either. The URL is the
    // primary key whenever present; the fingerprint is a secondary hash.
    const fingerprint = 'a'.repeat(64)
    const commenter = {
      entity_kind: 'person' as const,
      identity: {
        name: 'Dana Reyes',
        title: 'Broker/Owner, Results Realtors',
        urls: ['https://www.linkedin.com/in/dana-reyes'],
        linkedin_engagement_fingerprint: fingerprint,
      },
    }
    const reactor = {
      entity_kind: 'person' as const,
      identity: {
        name: 'Dana Reyes',
        title: 'Broker/Owner, Results Realtors',
        urls: ['https://www.linkedin.com/in/ACoAAExample'],
        linkedin_engagement_fingerprint: fingerprint,
      },
    }
    const fingerprintOnly = {
      entity_kind: 'person' as const,
      identity: { name: 'Dana Reyes', title: 'Broker/Owner, Results Realtors', linkedin_engagement_fingerprint: fingerprint },
    }
    expect(candidateDedupeKey(commenter)).not.toBe(candidateDedupeKey(reactor))
    expect(candidateDedupeKey(commenter)).toBe(candidateDedupeKey({
      entity_kind: 'person',
      identity: { name: 'D. Reyes', urls: ['https://linkedin.com/in/Dana-Reyes/'] },
    }))
    expect(candidateDedupeKey(fingerprintOnly)).toBe(candidateDedupeKey({
      entity_kind: 'person',
      identity: { name: 'Dana Reyes', linkedin_engagement_fingerprint: fingerprint },
    }))
    // Every hash a suppression or removal could have been written under.
    const hashes = candidateIdentityHashes(commenter)
    expect(hashes.has(candidateDedupeKey(commenter))).toBe(true)
    expect(hashes.has(candidateDedupeKey(fingerprintOnly))).toBe(true)
  })

  it('uses the canonical public destination for opportunity identity', () => {
    const first = candidateDedupeKey({
      entity_kind: 'opportunity',
      identity: {
        name: 'First-time homebuyer questions',
        opportunity_kind: 'community',
        urls: ['https://Community.Example/south-bay/questions/?utm_source=fixture#latest'],
      },
    })
    const renamed = candidateDedupeKey({
      entity_kind: 'opportunity',
      identity: {
        name: 'South Bay buyer community',
        opportunity_kind: 'forum',
        urls: ['https://community.example/south-bay/questions'],
      },
    })
    expect(first).toBe(renamed)
  })
})
