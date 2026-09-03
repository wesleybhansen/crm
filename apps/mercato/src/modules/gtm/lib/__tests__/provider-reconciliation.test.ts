import {
  GtmAuditEvent,
  GtmProviderOperation,
  GtmProviderReconciliationAction,
  GtmResearchRun,
} from '../../data/entities'
import { FixtureLedger, type GtmLedgerStatus } from '../credits/ledger'
import {
  classifyProviderOperationStatus,
  listProviderOperationsForReconciliation,
  reconcileProviderOperation as reconcileProviderOperationBase,
  repairResolvedResearchRunSummaries,
  replayPendingSettlements,
  type GtmCanonicalOperatorReconciler,
  type GtmCanonicalOperatorReconciliationRequest,
  type GtmCanonicalOperatorReconciliationResult,
  type GtmOperatorReconciliationEvidence,
  type ReconcileProviderOperationInput,
} from '../reconciliation/operator'
import { FakeEm } from './support/fake-em'

const ORG = '10000000-0000-4000-8000-000000000001'
const TENANT = '20000000-0000-4000-8000-000000000001'
const USER = '30000000-0000-4000-8000-000000000001'
const NOLI_ORG = '40000000-0000-4000-8000-000000000001'
const NOLI_USER = '50000000-0000-4000-8000-000000000001'
const DECIDED_AT = new Date('2026-08-17T19:30:00.000Z')

const ctx = {
  organizationId: ORG,
  tenantId: TENANT,
  userId: USER,
  requestId: 'http-request-1',
}

function reconcileProviderOperation(
  input: Omit<ReconcileProviderOperationInput, 'canonicalIdentity'>,
) {
  return reconcileProviderOperationBase({
    ...input,
    canonicalIdentity: { organizationId: NOLI_ORG, userId: NOLI_USER },
  })
}

function evidence(
  overrides: Partial<GtmOperatorReconciliationEvidence> = {},
): GtmOperatorReconciliationEvidence {
  return {
    source: 'provider_dashboard',
    reference: 'invoice-2026-08-17-line-4',
    observedAt: '2026-08-17T19:20:00.000Z',
    summary: 'Provider invoice shows the final billable result for this operation.',
    details: { currency: 'USD', invoice_line: 4, amount: '0.42' },
    ...overrides,
  }
}

// Models the stronger canonical contract the operator service requires. The
// binding map stands in for a Noli Core decision-evidence column/audit row;
// terminal operations settled outside this seam deliberately have no binding.
class FixtureCanonicalReconciler implements GtmCanonicalOperatorReconciler {
  private bindings = new Map<
    string,
    GtmCanonicalOperatorReconciliationResult['binding']
  >()
  private failAfterCanonical = false

  constructor(private ledger: FixtureLedger) {}

  failAfterCanonicalOnce(): void {
    this.failAfterCanonical = true
  }

  async reconcile(
    request: GtmCanonicalOperatorReconciliationRequest,
  ): Promise<GtmCanonicalOperatorReconciliationResult> {
    const before = this.ledger.getOperation(request.operationId)
    if (!before) throw new Error('unknown fixture operation')
    if (
      before.status === 'charged' ||
      before.status === 'partially_charged' ||
      before.status === 'refunded' ||
      before.status === 'released'
    ) {
      return {
        operationId: request.operationId,
        status: before.status,
        chargedCredits: before.chargedCredits,
        binding: this.bindings.get(request.operationId) ?? null,
      }
    }

    const status =
      request.outcome === 'release'
        ? await this.ledger.release(request.operationId)
        : await this.ledger.settle(
            request.operationId,
            request.outcome,
            request.chargedCredits,
            request.receipt,
          )
    const after = this.ledger.getOperation(request.operationId)
    if (!after) throw new Error('fixture operation disappeared')
    this.bindings.set(request.operationId, request.binding)
    if (this.failAfterCanonical) {
      this.failAfterCanonical = false
      throw new Error('simulated CRM handoff failure after canonical success')
    }
    return {
      operationId: request.operationId,
      status,
      chargedCredits: after.chargedCredits,
      binding: request.binding,
    }
  }
}

async function seedOperation(
  em: FakeEm,
  ledger: FixtureLedger,
  status: GtmLedgerStatus,
  overrides: Partial<GtmProviderOperation> = {},
): Promise<GtmProviderOperation> {
  const reserved = await ledger.reserve({
    orgId: ORG,
    userId: USER,
    kind: 'source_search',
    provider: 'fixture-source',
    estimatedCredits: 10,
    idempotencyKey: `provider-op-${em.table(GtmProviderOperation).length + 1}`,
  })
  if (status !== 'reserved' && status !== 'estimated') await ledger.start(reserved.operationId)
  if (status === 'reconciliation_required') {
    await ledger.markAmbiguous(reserved.operationId, { reason: 'provider_timeout' })
  } else if (status === 'charged') {
    await ledger.settle(reserved.operationId, 'charged', 5, { provider_request_id: 'provider-1' })
  } else if (status === 'partially_charged') {
    await ledger.settle(reserved.operationId, 'partially_charged', 3, { provider_request_id: 'provider-1' })
  } else if (status === 'refunded') {
    await ledger.settle(reserved.operationId, 'refunded', 0, { provider_request_id: 'provider-1' })
  } else if (status === 'released') {
    // seedOperation starts only non-reserved statuses, but release is legal
    // only before start. Use a fresh reservation's canonical state directly.
    throw new Error('released fixtures are not supported by seedOperation')
  }

  const operation = em.create(GtmProviderOperation, {
    organizationId: ORG,
    tenantId: TENANT,
    noliCoreOperationId: reserved.operationId,
    kind: 'source_search',
    provider: 'fixture-source',
    localStatusMirror: status,
    receipt: status === 'reconciliation_required' ? null : { provider_request_id: 'provider-1' },
    requestedAt: new Date('2026-08-17T19:00:00.000Z'),
    ...overrides,
  })
  em.persist(operation)
  await em.flush()
  return operation
}

describe('parked output and pending settlement replay (C2 + M5)', () => {
  test('refuses a charged decision when the provider returned output that was never retained', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger()
    const canonicalReconciler = new FixtureCanonicalReconciler(ledger)
    const operation = await seedOperation(em, ledger, 'provider_started', {
      receipt: {
        provider_request_id: 'provider-1',
        gtm_observation: { adapter_status: 'ok', output_count: 25, settlement_pending: true },
      },
    })

    await expect(reconcileProviderOperation({
      em,
      canonicalReconciler,
      ctx,
      operationId: operation.id,
      idempotencyKey: 'charge-without-payload',
      decision: { outcome: 'charged', chargedCredits: 5 },
      evidence: evidence(),
    })).rejects.toMatchObject({ code: 'invalid_decision' })
    expect(ledger.getOperation(operation.noliCoreOperationId)?.status).toBe('provider_started')

    // Refunding is still allowed: the customer is not billed for rows they
    // cannot receive.
    const refunded = await reconcileProviderOperation({
      em,
      canonicalReconciler,
      ctx,
      operationId: operation.id,
      idempotencyKey: 'refund-without-payload',
      decision: { outcome: 'refunded' },
      evidence: evidence(),
    })
    expect(refunded.canonicalStatus).toBe('refunded')
  })

  test('replays a pending settlement with the same operation id and clears the flag', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger()
    const pending = await seedOperation(em, ledger, 'provider_started', {
      researchRunId: null,
      receipt: {
        provider_request_id: 'provider-1',
        gtm_observation: {
          adapter_status: 'ok',
          intended_ledger_action: 'charged',
          intended_charged_credits: 4,
          output_count: 0,
          settlement_pending: true,
          canonical_status: 'provider_started',
        },
      },
    })
    const ambiguousPending = await seedOperation(em, ledger, 'provider_started', {
      researchRunId: null,
      receipt: {
        gtm_observation: {
          adapter_status: 'ambiguous',
          intended_ledger_action: 'mark_ambiguous',
          intended_charged_credits: 0,
          provider_error: 'timeout',
          settlement_pending: true,
        },
      },
    })
    const undecided = await seedOperation(em, ledger, 'provider_started', {
      researchRunId: null,
      receipt: { gtm_observation: { settlement_pending: true } },
    })
    const foreign = await seedOperation(em, ledger, 'provider_started', {
      researchRunId: null,
      tenantId: 'foreign-tenant',
      receipt: { gtm_observation: { intended_ledger_action: 'charged', intended_charged_credits: 4, settlement_pending: true } },
    })
    const settle = jest.spyOn(ledger, 'settle')

    const result = await replayPendingSettlements(em, ledger, ctx)

    expect(result.scanned).toBe(3)
    expect(result.settled).toEqual([
      expect.objectContaining({ operationId: pending.id, status: 'charged' }),
      expect.objectContaining({ operationId: ambiguousPending.id, status: 'reconciliation_required' }),
    ])
    expect(result.skipped).toEqual([expect.objectContaining({ operationId: undecided.id })])
    expect(settle).toHaveBeenCalledWith(pending.noliCoreOperationId, 'charged', 4, { provider_request_id: 'provider-1' })
    expect(ledger.getOperation(pending.noliCoreOperationId)).toMatchObject({ status: 'charged', chargedCredits: 4 })
    expect(pending.localStatusMirror).toBe('charged')
    expect(pending.settledAt).toBeInstanceOf(Date)
    expect((pending.receipt as Record<string, any>).gtm_observation).toMatchObject({
      settlement_pending: false,
      canonical_status: 'charged',
      settlement_error: null,
    })
    expect(ledger.getOperation(foreign.noliCoreOperationId)?.status).toBe('provider_started')

    // Idempotent: nothing is pending any more.
    expect(await replayPendingSettlements(em, ledger, ctx)).toMatchObject({ scanned: 1, settled: [] })
  })

  test('leaves a pending settlement parked when the canonical ledger fails again', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger()
    const pending = await seedOperation(em, ledger, 'provider_started', {
      researchRunId: null,
      receipt: { gtm_observation: { intended_ledger_action: 'charged', intended_charged_credits: 4, settlement_pending: true } },
    })
    jest.spyOn(ledger, 'settle').mockRejectedValueOnce(new Error('still unreachable'))

    const result = await replayPendingSettlements(em, ledger, ctx)

    expect(result.failed).toEqual([expect.objectContaining({ operationId: pending.id, error: expect.stringContaining('still unreachable') })])
    expect(pending.localStatusMirror).toBe('provider_started')
    expect((pending.receipt as Record<string, any>).gtm_observation.settlement_pending).toBe(true)
  })
})

describe('operator/provider reconciliation', () => {
  test('classifies and inventories reserved, started, ambiguous, settled, and unknown states tenant-safely', async () => {
    expect(classifyProviderOperationStatus('reserved')).toBe('reserved')
    expect(classifyProviderOperationStatus('provider_started')).toBe('started')
    expect(classifyProviderOperationStatus('reconciliation_required')).toBe('ambiguous')
    expect(classifyProviderOperationStatus('charged')).toBe('settled')
    expect(classifyProviderOperationStatus(null)).toBe('unknown')

    const em = new FakeEm()
    const ledger = new FixtureLedger()
    await seedOperation(em, ledger, 'reserved')
    await seedOperation(em, ledger, 'provider_started')
    await seedOperation(em, ledger, 'reconciliation_required')
    await seedOperation(em, ledger, 'charged')
    await seedOperation(em, ledger, 'reserved', { tenantId: 'foreign-tenant' })
    await seedOperation(em, ledger, 'reserved', { deletedAt: new Date() })

    const inventory = await listProviderOperationsForReconciliation(em, ctx)
    expect(inventory.map((item) => item.phase)).toEqual([
      'reserved',
      'started',
      'ambiguous',
      'settled',
    ])
    expect(inventory.every((item) => item.operatorRecordState === 'absent')).toBe(true)
    expect(inventory.every((item) => item.reconciliationActions.length === 0)).toBe(true)
  })

  test('releases only a pre-provider reservation and writes one linked evidence audit', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger()
    const canonicalReconciler = new FixtureCanonicalReconciler(ledger)
    const canonicalCall = jest.spyOn(canonicalReconciler, 'reconcile')
    const operation = await seedOperation(em, ledger, 'reserved')

    const result = await reconcileProviderOperation({
      em,
      canonicalReconciler,
      ctx,
      operationId: operation.id,
      idempotencyKey: 'operator-release-1',
      decision: { outcome: 'release' },
      evidence: evidence({
        source: 'operator_runbook',
        reference: 'change-ticket-42',
        summary: 'Reservation was abandoned before provider contact.',
        details: { provider_contacted: false, ticket: 'change-ticket-42' },
      }),
      now: () => DECIDED_AT,
    })

    expect(result).toMatchObject({ canonicalStatus: 'released', phase: 'settled', idempotent: false })
    expect(ledger.getOperation(operation.noliCoreOperationId)).toMatchObject({
      status: 'released',
      receipt: null,
    })
    expect(operation.localStatusMirror).toBe('released')
    expect(operation.settledAt).toEqual(DECIDED_AT)
    const record = (operation.receipt as any).operator_reconciliation
    expect(record).toMatchObject({
      schema_version: 'gtm.operator_reconciliation.v2',
      canonical_organization_id: NOLI_ORG,
      canonical_user_id: NOLI_USER,
      idempotency_key: 'operator-release-1',
      decision: 'release',
      charged_credits: 0,
      previous_status: 'reserved',
      canonical_status: 'released',
      actor_user_id: USER,
    })
    expect(canonicalCall).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: NOLI_ORG,
      actorUserId: NOLI_USER,
      billingUserId: NOLI_USER,
    }))
    expect(record.evidence_hash).toMatch(/^[a-f0-9]{64}$/)

    const actions = em.table(GtmProviderReconciliationAction)
    expect(actions).toHaveLength(1)
    expect(result.action).toBe(actions[0])
    expect(actions[0]).toMatchObject({
      organizationId: ORG,
      tenantId: TENANT,
      providerOperationId: operation.id,
      idempotencyKey: 'operator-release-1',
      decision: 'release',
      expectedStatus: 'reserved',
      resultingStatus: 'released',
      chargedCredits: 0,
      evidenceHash: record.evidence_hash,
      actorUserId: USER,
      status: 'completed',
      failureReason: null,
      completedAt: DECIDED_AT,
    })
    expect(actions[0].evidenceRedacted).toMatchObject({
      source: 'operator_runbook',
      reference_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      summary_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      detail_keys: ['provider_contacted', 'ticket'],
    })
    expect(JSON.stringify(actions[0].evidenceRedacted)).not.toContain('change-ticket-42')
    expect(JSON.stringify(actions[0].evidenceRedacted)).not.toContain('abandoned')

    const audits = em.table(GtmAuditEvent)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      id: record.audit_event_id,
      organizationId: ORG,
      tenantId: TENANT,
      actor: 'user_id',
      actorUserId: USER,
      action: 'gtm.provider_operation.reconciled',
      objectType: 'gtm_provider_operation',
      objectId: operation.id,
      requestId: 'operator-release-1',
    })
    expect(audits[0].metadata).toMatchObject({
      evidence_hash: record.evidence_hash,
      evidence_reference_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      request_id: 'http-request-1',
      canonical_status: 'released',
    })
    expect(audits[0].metadata).not.toHaveProperty('evidence_reference')
    expect(audits[0].metadata).not.toHaveProperty('evidence_summary')
  })

  test('settles started and ambiguous operations explicitly on the same canonical operation', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger()
    const canonicalReconciler = new FixtureCanonicalReconciler(ledger)
    const started = await seedOperation(em, ledger, 'provider_started')
    const ambiguous = await seedOperation(em, ledger, 'reconciliation_required')

    const charged = await reconcileProviderOperation({
      em,
      canonicalReconciler,
      ctx,
      operationId: started.id,
      idempotencyKey: 'operator-charge-1',
      decision: { outcome: 'charged', chargedCredits: 7 },
      evidence: evidence(),
    })
    const partiallyCharged = await reconcileProviderOperation({
      em,
      canonicalReconciler,
      ctx,
      operationId: ambiguous.id,
      idempotencyKey: 'operator-partial-1',
      decision: { outcome: 'partially_charged', chargedCredits: 4 },
      evidence: evidence({ reference: 'invoice-2026-08-17-line-5' }),
    })

    expect(charged.canonicalStatus).toBe('charged')
    expect(partiallyCharged.canonicalStatus).toBe('partially_charged')
    expect(ledger.getOperation(started.noliCoreOperationId)).toMatchObject({
      operationId: started.noliCoreOperationId,
      status: 'charged',
      chargedCredits: 7,
    })
    expect(ledger.getOperation(ambiguous.noliCoreOperationId)).toMatchObject({
      operationId: ambiguous.noliCoreOperationId,
      status: 'partially_charged',
      chargedCredits: 4,
    })
    expect((ledger.getOperation(started.noliCoreOperationId)?.receipt as any)).toMatchObject({
      provider_request_id: 'provider-1',
      operator_reconciliation: {
        decision: 'charged',
        evidence_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
    expect(em.table(GtmProviderOperation)).toHaveLength(2)
    expect(em.table(GtmAuditEvent)).toHaveLength(2)
  })

  test('repairs the parent research-run money and hold summary after the last ambiguity settles', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger()
    const canonicalReconciler = new FixtureCanonicalReconciler(ledger)
    const run = em.create(GtmResearchRun, {
      organizationId: ORG,
      tenantId: TENANT,
      workspaceId: '60000000-0000-4000-8000-000000000001',
      playId: '70000000-0000-4000-8000-000000000001',
      status: 'completed',
      reconciledCredits: '5',
      providerPlan: {
        execution: {
          status: 'completed',
          reconciliation_required: true,
          reconciled_credits: 5,
          funnel: {
            target_met: false,
            raw_candidates_found: 2,
            max_raw_candidates: 10,
            stop_reason: 'unresolved_provider_outcome',
          },
          batches: [],
        },
      },
    })
    em.persist(run)
    await em.flush()
    const settled = await seedOperation(em, ledger, 'charged', {
      researchRunId: run.id,
      receipt: { gtm_observation: { intended_charged_credits: 5 } },
    })
    const ambiguous = await seedOperation(em, ledger, 'reconciliation_required', {
      researchRunId: run.id,
    })
    const execution = (run.providerPlan as any).execution
    execution.batches = [
      {
        operation_id: settled.noliCoreOperationId,
        ledger_status: 'charged',
        charged_credits: 5,
        outcome: 'ok',
      },
      {
        operation_id: ambiguous.noliCoreOperationId,
        ledger_status: 'reconciliation_required',
        charged_credits: 0,
        outcome: 'ambiguous',
      },
    ]

    await reconcileProviderOperation({
      em,
      canonicalReconciler,
      ctx,
      operationId: ambiguous.id,
      idempotencyKey: 'operator-run-rollup-1',
      decision: { outcome: 'partially_charged', chargedCredits: 3 },
      evidence: evidence({ reference: 'invoice-run-rollup-line' }),
      now: () => DECIDED_AT,
    })

    expect(run.reconciledCredits).toBe('8')
    expect(run.providerPlan).toMatchObject({
      execution: {
        reconciliation_required: false,
        reconciled_credits: 8,
        funnel: { stop_reason: 'sources_exhausted' },
        batches: [
          expect.objectContaining({
            operation_id: settled.noliCoreOperationId,
            ledger_status: 'charged',
            charged_credits: 5,
            reconciliation_resolved: true,
          }),
          expect.objectContaining({
            operation_id: ambiguous.noliCoreOperationId,
            ledger_status: 'partially_charged',
            charged_credits: 3,
            reconciliation_resolved: true,
          }),
        ],
      },
    })
  })

  test('repairs explicitly named stale summaries only when every child is terminal and evidenced', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger()
    const run = em.create(GtmResearchRun, {
      organizationId: ORG,
      tenantId: TENANT,
      workspaceId: '60000000-0000-4000-8000-000000000001',
      playId: '70000000-0000-4000-8000-000000000001',
      status: 'completed',
      reconciledCredits: '0',
      providerPlan: {
        execution: {
          reconciliation_required: true,
          reconciled_credits: 0,
          batches: [],
        },
      },
    })
    em.persist(run)
    await em.flush()
    const charged = await seedOperation(em, ledger, 'charged', {
      researchRunId: run.id,
      receipt: { gtm_observation: { intended_charged_credits: 7 } },
    })
    const refunded = await seedOperation(em, ledger, 'refunded', {
      researchRunId: run.id,
    })
    ;((run.providerPlan as any).execution.batches as unknown[]).push(
      { operation_id: charged.noliCoreOperationId, ledger_status: 'charged' },
      { operation_id: refunded.noliCoreOperationId, ledger_status: 'refunded' },
    )

    const result = await repairResolvedResearchRunSummaries(em, ctx, [run.id, run.id])

    expect(result).toEqual({
      requestedRunIds: [run.id],
      repairedRunIds: [run.id],
      unchangedRunIds: [],
    })
    expect(run.reconciledCredits).toBe('7')
    expect(run.providerPlan).toMatchObject({
      execution: {
        reconciliation_required: false,
        reconciled_credits: 7,
        batches: [
          expect.objectContaining({
            operation_id: charged.noliCoreOperationId,
            charged_credits: 7,
            reconciliation_resolved: true,
          }),
          expect.objectContaining({
            operation_id: refunded.noliCoreOperationId,
            charged_credits: 0,
            reconciliation_resolved: true,
          }),
        ],
      },
    })

    await expect(repairResolvedResearchRunSummaries(em, ctx, [run.id])).resolves.toEqual({
      requestedRunIds: [run.id],
      repairedRunIds: [],
      unchangedRunIds: [run.id],
    })
  })

  test('leaves unresolved, unevidenced, and cross-scope research-run summaries unchanged', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger()
    const run = em.create(GtmResearchRun, {
      organizationId: ORG,
      tenantId: TENANT,
      workspaceId: '60000000-0000-4000-8000-000000000001',
      playId: '70000000-0000-4000-8000-000000000001',
      status: 'completed',
      reconciledCredits: '0',
      providerPlan: { execution: { reconciliation_required: true, reconciled_credits: 0 } },
    })
    em.persist(run)
    await em.flush()
    await seedOperation(em, ledger, 'provider_started', { researchRunId: run.id })
    const unevidencedRun = em.create(GtmResearchRun, {
      organizationId: ORG,
      tenantId: TENANT,
      workspaceId: '60000000-0000-4000-8000-000000000001',
      playId: '70000000-0000-4000-8000-000000000001',
      status: 'completed',
      reconciledCredits: '0',
      providerPlan: { execution: { reconciliation_required: true, reconciled_credits: 0 } },
    })
    em.persist(unevidencedRun)
    await em.flush()
    await seedOperation(em, ledger, 'charged', { researchRunId: unevidencedRun.id })

    const result = await repairResolvedResearchRunSummaries(em, ctx, [
      run.id,
      unevidencedRun.id,
      '80000000-0000-4000-8000-000000000001',
    ])

    expect(result).toEqual({
      requestedRunIds: [
        run.id,
        unevidencedRun.id,
        '80000000-0000-4000-8000-000000000001',
      ],
      repairedRunIds: [],
      unchangedRunIds: [
        run.id,
        unevidencedRun.id,
        '80000000-0000-4000-8000-000000000001',
      ],
    })
    expect((run.providerPlan as any).execution.reconciliation_required).toBe(true)
    expect((unevidencedRun.providerPlan as any).execution.reconciliation_required).toBe(true)
    expect(run.reconciledCredits).toBe('0')
    expect(unevidencedRun.reconciledCredits).toBe('0')
  })

  test('never infers a refund from a missing receipt or missing evidence', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger()
    const canonicalReconciler = new FixtureCanonicalReconciler(ledger)
    const operation = await seedOperation(em, ledger, 'reconciliation_required', { receipt: null })

    await expect(
      reconcileProviderOperation({
        em,
        canonicalReconciler,
        ctx,
        operationId: operation.id,
        idempotencyKey: 'operator-refund-1',
        decision: { outcome: 'refunded' },
        evidence: { ...evidence(), details: {} },
      }),
    ).rejects.toMatchObject({ code: 'invalid_evidence' })
    expect(ledger.getOperation(operation.noliCoreOperationId)?.status).toBe('reconciliation_required')
    expect(operation.localStatusMirror).toBe('reconciliation_required')
    expect(em.table(GtmAuditEvent)).toHaveLength(0)

    const result = await reconcileProviderOperation({
      em,
      canonicalReconciler,
      ctx,
      operationId: operation.id,
      idempotencyKey: 'operator-refund-1',
      decision: { outcome: 'refunded' },
      evidence: evidence({
        source: 'provider_support',
        reference: 'support-case-88',
        summary: 'Provider support explicitly confirmed that no charge was recorded.',
        details: { support_case: 'support-case-88', provider_disposition: 'not_billed' },
      }),
    })
    expect(result.canonicalStatus).toBe('refunded')
    expect(ledger.getOperation(operation.noliCoreOperationId)?.chargedCredits).toBe(0)
  })

  test('exact replay is idempotent while conflicting decisions cannot overwrite immutable evidence', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger()
    const canonicalReconciler = new FixtureCanonicalReconciler(ledger)
    const canonicalCalls = jest.spyOn(canonicalReconciler, 'reconcile')
    const operation = await seedOperation(em, ledger, 'reconciliation_required')
    const suppliedEvidence = evidence({
      details: { invoice: { line: 9, units: 3 }, currency: 'USD' },
    })

    const first = await reconcileProviderOperation({
      em,
      canonicalReconciler,
      ctx,
      operationId: operation.id,
      idempotencyKey: 'operator-charge-replay',
      decision: { outcome: 'charged', chargedCredits: 3 },
      evidence: suppliedEvidence,
    })
    ;(suppliedEvidence.details.invoice as { units: number }).units = 999
    // PostgreSQL bigint columns can hydrate as bigint or string even though
    // the entity presents the field as a number. Exact replay must compare
    // the integer value rather than rejecting the durable action record.
    ;(em.table(GtmProviderReconciliationAction)[0] as unknown as { chargedCredits: bigint })
      .chargedCredits = 3n

    const replay = await reconcileProviderOperation({
      em,
      canonicalReconciler,
      ctx,
      operationId: operation.id,
      idempotencyKey: 'operator-charge-replay',
      decision: { outcome: 'charged', chargedCredits: 3 },
      evidence: evidence({ details: { invoice: { line: 9, units: 3 }, currency: 'USD' } }),
    })
    expect(first.idempotent).toBe(false)
    expect(replay.idempotent).toBe(true)
    expect(replay.audit.id).toBe(first.audit.id)
    expect(replay.action.id).toBe(first.action.id)
    expect(canonicalCalls).toHaveBeenCalledTimes(2)
    expect(em.table(GtmAuditEvent)).toHaveLength(1)
    expect(em.table(GtmProviderReconciliationAction)).toHaveLength(1)
    expect((operation.receipt as any).operator_reconciliation.evidence.details).toEqual({
      currency: 'USD',
      invoice: { line: 9, units: 3 },
    })

    ;(em.table(GtmProviderReconciliationAction)[0] as unknown as { chargedCredits: string })
      .chargedCredits = '3'
    const stringHydrationReplay = await reconcileProviderOperation({
      em,
      canonicalReconciler,
      ctx,
      operationId: operation.id,
      idempotencyKey: 'operator-charge-replay',
      decision: { outcome: 'charged', chargedCredits: 3 },
      evidence: evidence({ details: { invoice: { line: 9, units: 3 }, currency: 'USD' } }),
    })
    expect(stringHydrationReplay.idempotent).toBe(true)
    expect(canonicalCalls).toHaveBeenCalledTimes(3)

    await expect(
      reconcileProviderOperation({
        em,
        canonicalReconciler,
        ctx,
        operationId: operation.id,
        idempotencyKey: 'operator-charge-replay',
        decision: { outcome: 'refunded' },
        evidence: evidence({ reference: 'support-case-conflict' }),
      }),
    ).rejects.toMatchObject({ code: 'already_reconciled' })
    expect(canonicalCalls).toHaveBeenCalledTimes(3)
    expect(em.table(GtmAuditEvent)).toHaveLength(1)
    expect(ledger.getOperation(operation.noliCoreOperationId)).toMatchObject({
      status: 'charged',
      chargedCredits: 3,
    })
  })

  test('a pending action repairs CRM after canonical success without changing decision chronology', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger()
    const canonicalReconciler = new FixtureCanonicalReconciler(ledger)
    const operation = await seedOperation(em, ledger, 'reconciliation_required')
    canonicalReconciler.failAfterCanonicalOnce()
    const request = {
      em,
      canonicalReconciler,
      ctx,
      operationId: operation.id,
      idempotencyKey: 'recover-after-canonical-success',
      decision: { outcome: 'charged' as const, chargedCredits: 3 },
      evidence: evidence({ reference: 'invoice-recovery-case' }),
    }

    await expect(
      reconcileProviderOperation({ ...request, now: () => DECIDED_AT }),
    ).rejects.toThrow('simulated CRM handoff failure')
    const pending = em.table(GtmProviderReconciliationAction)[0]
    expect(pending).toMatchObject({ status: 'pending', resultingStatus: null })
    expect(operation.localStatusMirror).toBe('reconciliation_required')
    expect(ledger.getOperation(operation.noliCoreOperationId)).toMatchObject({
      status: 'charged',
      chargedCredits: 3,
    })

    const recovered = await reconcileProviderOperation({
      ...request,
      now: () => new Date('2026-08-18T01:00:00.000Z'),
    })
    expect(recovered.idempotent).toBe(false)
    expect(recovered.action.id).toBe(pending.id)
    expect(recovered.action).toMatchObject({
      status: 'completed',
      resultingStatus: 'charged',
      completedAt: DECIDED_AT,
    })
    expect((operation.receipt as any).operator_reconciliation.decided_at).toBe(
      DECIDED_AT.toISOString(),
    )
    expect(em.table(GtmProviderReconciliationAction)).toHaveLength(1)
    expect(em.table(GtmAuditEvent)).toHaveLength(1)
  })

  test('wrong-tenant access is opaque and never reaches the canonical ledger', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger()
    const canonicalReconciler = new FixtureCanonicalReconciler(ledger)
    const operation = await seedOperation(em, ledger, 'reserved')
    const reconcile = jest.spyOn(canonicalReconciler, 'reconcile')

    await expect(
      reconcileProviderOperation({
        em,
        canonicalReconciler,
        ctx: { ...ctx, tenantId: 'foreign-tenant' },
        operationId: operation.id,
        idempotencyKey: 'cross-tenant-attempt',
        decision: { outcome: 'release' },
        evidence: evidence(),
      }),
    ).rejects.toMatchObject({ code: 'operation_not_found' })
    await expect(
      reconcileProviderOperation({
        em,
        canonicalReconciler,
        ctx: { ...ctx, organizationId: 'foreign-organization' },
        operationId: operation.id,
        idempotencyKey: 'cross-organization-attempt',
        decision: { outcome: 'release' },
        evidence: evidence(),
      }),
    ).rejects.toMatchObject({ code: 'operation_not_found' })
    expect(reconcile).not.toHaveBeenCalled()
    expect(ledger.getOperation(operation.noliCoreOperationId)?.status).toBe('reserved')
    expect(em.table(GtmAuditEvent)).toHaveLength(0)
  })

  test('canonical status conflicts fail closed without relabeling or auditing', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger()
    const canonicalReconciler = new FixtureCanonicalReconciler(ledger)
    const operation = await seedOperation(em, ledger, 'reconciliation_required')
    await ledger.settle(operation.noliCoreOperationId, 'charged', 4, { late_receipt: true })

    await expect(
      reconcileProviderOperation({
        em,
        canonicalReconciler,
        ctx,
        operationId: operation.id,
        idempotencyKey: 'stale-refund-attempt',
        decision: { outcome: 'refunded' },
        evidence: evidence({ reference: 'stale-operator-evidence' }),
      }),
    ).rejects.toMatchObject({ code: 'canonical_status_conflict' })
    expect(operation.localStatusMirror).toBe('reconciliation_required')
    expect(operation.receipt).toBeNull()
    expect(em.table(GtmAuditEvent)).toHaveLength(0)
    expect(em.table(GtmProviderReconciliationAction)[0]).toMatchObject({
      status: 'rejected',
      resultingStatus: 'charged',
      failureReason: 'canonical_decision_conflict',
    })
    expect(ledger.getOperation(operation.noliCoreOperationId)).toMatchObject({
      status: 'charged',
      chargedCredits: 4,
    })
  })

  test('matching canonical status with a different amount or missing decision binding still conflicts', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger()
    const canonicalReconciler = new FixtureCanonicalReconciler(ledger)
    const operation = await seedOperation(em, ledger, 'reconciliation_required')
    // Simulate a delayed settlement that landed outside the operator seam.
    await ledger.settle(operation.noliCoreOperationId, 'charged', 4, { delayed_receipt: true })

    await expect(
      reconcileProviderOperation({
        em,
        canonicalReconciler,
        ctx,
        operationId: operation.id,
        idempotencyKey: 'stale-matching-charge',
        decision: { outcome: 'charged', chargedCredits: 7 },
        evidence: evidence({ reference: 'invoice-claims-seven' }),
      }),
    ).rejects.toMatchObject({ code: 'canonical_status_conflict' })
    expect(operation.localStatusMirror).toBe('reconciliation_required')
    expect(em.table(GtmAuditEvent)).toHaveLength(0)
    expect(ledger.getOperation(operation.noliCoreOperationId)).toMatchObject({
      status: 'charged',
      chargedCredits: 4,
    })
  })

  test('invalid local decision time fails before any canonical mutation', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger()
    const canonicalReconciler = new FixtureCanonicalReconciler(ledger)
    const reconcile = jest.spyOn(canonicalReconciler, 'reconcile')
    const operation = await seedOperation(em, ledger, 'reconciliation_required')

    await expect(
      reconcileProviderOperation({
        em,
        canonicalReconciler,
        ctx,
        operationId: operation.id,
        idempotencyKey: 'invalid-clock',
        decision: { outcome: 'refunded' },
        evidence: evidence(),
        now: () => new Date(Number.NaN),
      }),
    ).rejects.toMatchObject({ code: 'invalid_evidence' })
    expect(reconcile).not.toHaveBeenCalled()
    expect(ledger.getOperation(operation.noliCoreOperationId)?.status).toBe('reconciliation_required')
    expect(em.table(GtmProviderReconciliationAction)).toHaveLength(0)
    expect(em.table(GtmAuditEvent)).toHaveLength(0)
  })

  test('tampered duplicated audit metadata makes an exact replay fail closed', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger()
    const canonicalReconciler = new FixtureCanonicalReconciler(ledger)
    const operation = await seedOperation(em, ledger, 'reconciliation_required')
    const input = {
      em,
      canonicalReconciler,
      ctx,
      operationId: operation.id,
      idempotencyKey: 'tamper-check',
      decision: { outcome: 'charged' as const, chargedCredits: 2 },
      evidence: evidence({ reference: 'invoice-tamper-check' }),
    }
    await reconcileProviderOperation(input)
    const audit = em.table(GtmAuditEvent)[0]
    ;(audit.metadata as Record<string, unknown>).evidence_source = 'tampered_source'

    await expect(reconcileProviderOperation(input)).rejects.toMatchObject({
      code: 'incomplete_reconciliation_record',
    })
    expect(em.table(GtmAuditEvent)).toHaveLength(1)
  })

  test('legacy-settled shadows and illegal release/refund transitions are read-only', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger()
    const canonicalReconciler = new FixtureCanonicalReconciler(ledger)
    const settled = await seedOperation(em, ledger, 'charged')
    const started = await seedOperation(em, ledger, 'provider_started')
    const reserved = await seedOperation(em, ledger, 'reserved')

    await expect(
      reconcileProviderOperation({
        em,
        canonicalReconciler,
        ctx,
        operationId: settled.id,
        idempotencyKey: 'rewrite-settled',
        decision: { outcome: 'charged', chargedCredits: 5 },
        evidence: evidence(),
      }),
    ).rejects.toMatchObject({ code: 'illegal_state' })
    await expect(
      reconcileProviderOperation({
        em,
        canonicalReconciler,
        ctx,
        operationId: started.id,
        idempotencyKey: 'release-after-start',
        decision: { outcome: 'release' },
        evidence: evidence(),
      }),
    ).rejects.toMatchObject({ code: 'illegal_state' })
    await expect(
      reconcileProviderOperation({
        em,
        canonicalReconciler,
        ctx,
        operationId: reserved.id,
        idempotencyKey: 'refund-before-start',
        decision: { outcome: 'refunded' },
        evidence: evidence(),
      }),
    ).rejects.toMatchObject({ code: 'illegal_state' })
    expect(em.table(GtmAuditEvent)).toHaveLength(0)
  })
})
