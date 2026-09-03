import crypto from 'crypto'
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core'
import {
  GtmAuditEvent,
  GtmProviderOperation,
  GtmProviderReconciliationAction,
  GtmResearchRun,
} from '../../data/entities'
import type { CampaignEm, GtmCtx } from '../campaign/build'
import type { GtmCreditLedger, GtmLedgerStatus, GtmSettleOutcome } from '../credits/ledger'
import {
  RETAINED_OUTPUT_RECEIPT_KEY,
  materializeProviderRows,
  readRetainedProviderOutput,
  type ResearchEm,
} from '../research/execute'
import { ruleBasedFitScorer, type FitScorer } from '../research/qualify'
import { resolveParkedContactPoints } from '../enrich/waterfall'

/*
 * Human reconciliation for provider-credit operations.
 *
 * This module never contacts a provider. Its protected internal route must
 * supply both the canonical Noli Core ledger seam and an explicit, evidenced
 * operator decision. The CRM row remains a status/evidence shadow only; the
 * ledger result is authoritative.
 */

export const OPERATOR_RECONCILIATION_SCHEMA = 'gtm.operator_reconciliation.v2'
export const OPERATOR_RECONCILIATION_RECEIPT_KEY = 'operator_reconciliation'

const AUDIT_ACTION = 'gtm.provider_operation.reconciled'
const AUDIT_OBJECT_TYPE = 'gtm_provider_operation'
const MAX_EVIDENCE_BYTES = 64 * 1024
const MAX_JSON_DEPTH = 12

const SETTLED_STATUSES: ReadonlySet<GtmLedgerStatus> = new Set([
  'charged',
  'partially_charged',
  'refunded',
  'released',
])

const LEDGER_STATUSES: ReadonlySet<string> = new Set([
  'estimated',
  'reserved',
  'provider_started',
  'charged',
  'partially_charged',
  'refunded',
  'reconciliation_required',
  'released',
])

const FORBIDDEN_EVIDENCE_KEYS: ReadonlySet<string> = new Set([
  'apikey',
  'authorization',
  'clientsecret',
  'cookie',
  'password',
  'privatekey',
  'refreshtoken',
  'setcookie',
  'accesstoken',
])

export type GtmProviderOperationPhase =
  | 'reserved'
  | 'started'
  | 'ambiguous'
  | 'settled'
  | 'unknown'

export type GtmOperatorReconciliationDecision =
  | { outcome: 'release'; chargedCredits?: never }
  | { outcome: 'refunded'; chargedCredits?: 0 }
  | { outcome: 'charged' | 'partially_charged'; chargedCredits: number }

export type GtmOperatorReconciliationEvidence = {
  // Human-readable evidence system, for example "provider_dashboard" or
  // "provider_support". It is not a credential or adapter invocation.
  source: string
  // Stable external reference such as an invoice, request, or support case.
  reference: string
  observedAt: string
  summary: string
  // A bounded JSON snapshot of the facts the operator relied on. Secret-like
  // keys are rejected so raw credentials cannot become durable audit data.
  details: Record<string, unknown>
}

type NormalizedDecision = {
  outcome: 'release' | GtmSettleOutcome
  chargedCredits: number
}

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

type NormalizedEvidence = {
  source: string
  reference: string
  observedAt: string
  summary: string
  details: { [key: string]: JsonValue }
}

type StoredOperatorReconciliation = {
  schema_version: typeof OPERATOR_RECONCILIATION_SCHEMA
  action_id: string
  organization_id: string
  tenant_id: string
  crm_operation_id: string
  noli_core_operation_id: string
  provider: string
  kind: string
  idempotency_key: string
  audit_event_id: string
  decision: NormalizedDecision['outcome']
  charged_credits: number
  previous_status: GtmLedgerStatus
  canonical_status: GtmLedgerStatus
  canonical_organization_id: string
  canonical_user_id: string
  actor_user_id: string
  decided_at: string
  evidence: NormalizedEvidence
  evidence_hash: string
  decision_hash: string
}

export type GtmCanonicalDecisionBinding = {
  schemaVersion: typeof OPERATOR_RECONCILIATION_SCHEMA
  idempotencyKey: string
  auditEventId: string
  evidenceHash: string
  decisionHash: string
  decidedAt: string
}

export type GtmCanonicalOperatorReconciliationRequest = {
  organizationId: string
  actorUserId: string
  billingUserId: string
  operationId: string
  previousStatus: GtmLedgerStatus
  outcome: NormalizedDecision['outcome']
  chargedCredits: number
  receipt: Record<string, unknown>
  binding: GtmCanonicalDecisionBinding
}

export type GtmCanonicalOperatorReconciliationResult = {
  operationId: string
  status: GtmLedgerStatus
  chargedCredits: number
  // Null means the canonical terminal state has no operator binding and must
  // never be attributed to the current decision merely because status matches.
  binding: GtmCanonicalDecisionBinding | null
}

/**
 * Required canonical seam for operator reconciliation. Its implementation
 * must atomically settle/release or replay the operation and return the
 * binding actually stored with that canonical decision. The existing
 * status-only GtmCreditLedger RPC is intentionally insufficient for this job.
 */
export interface GtmCanonicalOperatorReconciler {
  reconcile(
    request: GtmCanonicalOperatorReconciliationRequest,
  ): Promise<GtmCanonicalOperatorReconciliationResult>
}

export type GtmProviderOperationInventoryItem = {
  id: string
  noliCoreOperationId: string
  kind: string
  provider: string
  localStatus: string | null
  phase: GtmProviderOperationPhase
  operatorRecordState: 'absent' | 'recorded' | 'invalid'
  reconciliationActions: Array<{
    id: string
    status: string
    decision: string
    expectedStatus: string
    resultingStatus: string | null
  }>
}

export type GtmOperatorReconciliationResult = {
  operation: GtmProviderOperation
  action: GtmProviderReconciliationAction
  audit: GtmAuditEvent
  canonicalStatus: GtmLedgerStatus
  phase: 'settled'
  idempotent: boolean
}

export type GtmResearchRunSummaryRepairResult = {
  requestedRunIds: string[]
  repairedRunIds: string[]
  unchangedRunIds: string[]
}

export type GtmProviderReconciliationErrorCode =
  | 'operation_not_found'
  | 'invalid_idempotency_key'
  | 'invalid_evidence'
  | 'invalid_decision'
  | 'illegal_state'
  | 'already_reconciled'
  | 'incomplete_reconciliation_record'
  | 'canonical_status_conflict'

export class GtmProviderReconciliationError extends Error {
  constructor(
    public code: GtmProviderReconciliationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'GtmProviderReconciliationError'
  }
}

class CanonicalDecisionConflictError extends GtmProviderReconciliationError {
  constructor(public canonicalStatus: GtmLedgerStatus | null) {
    super(
      'canonical_status_conflict',
      'canonical operation does not exactly match the evidenced operator decision',
    )
  }
}

export function classifyProviderOperationStatus(
  status: string | null | undefined,
): GtmProviderOperationPhase {
  if (status === 'estimated' || status === 'reserved') return 'reserved'
  if (status === 'provider_started') return 'started'
  if (status === 'reconciliation_required') return 'ambiguous'
  if (status && SETTLED_STATUSES.has(status as GtmLedgerStatus)) return 'settled'
  return 'unknown'
}

/**
 * Read-only, tenant-scoped inventory for the protected operator surface.
 * Authorization and input validation are enforced by the internal route.
 */
export async function listProviderOperationsForReconciliation(
  em: CampaignEm,
  ctx: GtmCtx,
): Promise<GtmProviderOperationInventoryItem[]> {
  const operations = await em.find(GtmProviderOperation, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  const actions = await em.find(GtmProviderReconciliationAction, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })

  return operations.map((operation) => ({
    id: operation.id,
    noliCoreOperationId: operation.noliCoreOperationId,
    kind: operation.kind,
    provider: operation.provider,
    localStatus: operation.localStatusMirror ?? null,
    phase: classifyProviderOperationStatus(operation.localStatusMirror),
    operatorRecordState: inspectOperatorRecordState(operation.receipt),
    reconciliationActions: actions
      .filter((action) => action.providerOperationId === operation.id)
      .map((action) => ({
        id: action.id,
        status: action.status,
        decision: action.decision,
        expectedStatus: action.expectedStatus,
        resultingStatus: action.resultingStatus ?? null,
      })),
  }))
}

export type ReconcileProviderOperationInput = {
  em: CampaignEm
  canonicalReconciler: GtmCanonicalOperatorReconciler
  ctx: GtmCtx
  // Server-resolved Noli Core identity. This is distinct from the CRM scope
  // in ctx and is decision-hash-bound before the canonical RPC.
  canonicalIdentity: {
    organizationId: string
    userId: string
  }
  // CRM shadow id, not a caller-supplied canonical operation id. Resolving it
  // through both org and tenant prevents cross-tenant canonical-ledger calls.
  operationId: string
  idempotencyKey: string
  decision: GtmOperatorReconciliationDecision
  evidence: GtmOperatorReconciliationEvidence
  now?: () => Date
}

/**
 * Applies one explicit operator decision to the same canonical operation that
 * is referenced by the CRM shadow. Missing provider receipts never choose an
 * outcome: release/refund/charge is always supplied explicitly and requires a
 * non-empty evidence snapshot.
 */
export async function reconcileProviderOperation(
  input: ReconcileProviderOperationInput,
): Promise<GtmOperatorReconciliationResult> {
  const canonicalIdentity = normalizeCanonicalIdentity(input.canonicalIdentity)
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey)
  const decision = normalizeDecision(input.decision)
  const evidence = normalizeEvidence(input.evidence)
  const evidenceHash = hashEvidence(evidence)

  const operation = await findScopedOperation(input.em, input.ctx, input.operationId)
  assertChargeableOutputRetained(operation, decision)
  const replay = await resolveExistingRecord(
    input.em,
    input.ctx,
    operation,
    idempotencyKey,
    decision,
    evidenceHash,
    canonicalIdentity,
  )
  if (replay) {
    const stored = readStoredOperatorReconciliation(operation.receipt)
    if (!stored) throw incompleteRecord()
    await reconcileCanonicalDecision(input.canonicalReconciler, operation.receipt, stored)
    await refreshResearchRunReconciliationSummary(input.em, input.ctx, operation)
    return replay
  }

  const previousStatus = requireActionableStatus(operation.localStatusMirror)
  assertDecisionAllowed(previousStatus, decision)
  // One deterministic audit primary key per canonical operation turns the
  // existing audit PK into a final concurrent-write fence without requiring
  // a new entity or migration. Exact retries derive the same id.
  const auditId = deterministicAuditEventId(input.ctx, operation.noliCoreOperationId)
  const existingAction = await findScopedActionByKey(
    input.em,
    input.ctx,
    idempotencyKey,
  )
  if (existingAction && existingAction.status !== 'pending') {
    throw new GtmProviderReconciliationError(
      'already_reconciled',
      'operator idempotency key already has a terminal reconciliation action',
    )
  }
  // A pending action is the durable recovery anchor after an uncertain
  // cross-app result. Reuse its original timestamp and id on every retry.
  const decidedAt = normalizeDecisionTime(
    existingAction?.createdAt ?? input.now?.() ?? new Date(),
  )
  const actionId =
    existingAction?.id ?? deterministicActionId(input.ctx, idempotencyKey)

  const storedWithoutDecisionHash: Omit<StoredOperatorReconciliation, 'decision_hash'> = {
    schema_version: OPERATOR_RECONCILIATION_SCHEMA,
    action_id: actionId,
    organization_id: input.ctx.organizationId,
    tenant_id: input.ctx.tenantId,
    crm_operation_id: operation.id,
    noli_core_operation_id: operation.noliCoreOperationId,
    provider: operation.provider,
    kind: operation.kind,
    idempotency_key: idempotencyKey,
    audit_event_id: auditId,
    decision: decision.outcome,
    charged_credits: decision.chargedCredits,
    previous_status: previousStatus,
    canonical_status: expectedCanonicalStatus(decision),
    canonical_organization_id: canonicalIdentity.organizationId,
    canonical_user_id: canonicalIdentity.userId,
    actor_user_id: input.ctx.userId,
    decided_at: decidedAt.toISOString(),
    evidence,
    evidence_hash: evidenceHash,
  }
  const stored: StoredOperatorReconciliation = {
    ...storedWithoutDecisionHash,
    decision_hash: hashDecisionRecord(storedWithoutDecisionHash),
  }

  const action =
    existingAction ??
    (await createPendingAction(input.em, input.ctx, operation, stored, decidedAt))
  assertActionMatches(action, operation, stored, 'pending')

  // This is one atomic Noli Core reconciliation only. There is intentionally
  // no provider adapter or provider callback anywhere in this module.
  let canonicalStatus: GtmLedgerStatus
  try {
    canonicalStatus = await reconcileCanonicalDecision(
      input.canonicalReconciler,
      operation.receipt,
      stored,
    )
  } catch (error) {
    if (error instanceof CanonicalDecisionConflictError) {
      await rejectPendingAction(
        input.em,
        input.ctx,
        action.id,
        decidedAt,
        error.canonicalStatus,
      )
    }
    throw error
  }

  const result: GtmOperatorReconciliationResult = await input.em.transactional(async (tem) => {
    const current = await findScopedOperation(tem, input.ctx, input.operationId)
    const currentAction = await findScopedAction(tem, input.ctx, action.id)
    const concurrentReplay = await resolveExistingRecord(
      tem,
      input.ctx,
      current,
      idempotencyKey,
      decision,
      evidenceHash,
      canonicalIdentity,
    )
    if (concurrentReplay) return concurrentReplay
    assertActionMatches(currentAction, current, stored, 'pending')

    // Fail closed if a provider completion or another local writer changed the
    // shadow while the canonical call was in flight.
    const currentStatus = requireActionableStatus(current.localStatusMirror)
    assertDecisionAllowed(currentStatus, decision)
    if (
      currentStatus !== previousStatus ||
      current.noliCoreOperationId !== operation.noliCoreOperationId
    ) {
      throw new GtmProviderReconciliationError(
        'illegal_state',
        'provider operation changed while reconciliation was in progress',
      )
    }

    current.localStatusMirror = canonicalStatus
    current.settledAt = new Date(decidedAt.getTime())
    current.receipt = buildCanonicalReceipt(current.receipt, stored)
    tem.persist(current)
    // Contact points parked as provider_ambiguous by a verification operation
    // resolve with the canonical decision (enrich M12). Best effort: a failure
    // here must not undo the reconciliation itself.
    try {
      await resolveParkedContactPoints(
        tem as unknown as Parameters<typeof resolveParkedContactPoints>[0],
        { organizationId: input.ctx.organizationId, tenantId: input.ctx.tenantId },
        { providerOperationShadowId: current.id, canonicalStatus },
      )
    } catch (error) {
      console.error('[gtm.reconciliation] parked contact points not resolved', error)
    }

    currentAction.resultingStatus = canonicalStatus
    currentAction.status = 'completed'
    currentAction.failureReason = null
    currentAction.completedAt = new Date(decidedAt.getTime())
    tem.persist(currentAction)

    const audit = tem.create(GtmAuditEvent, {
      id: auditId,
      organizationId: input.ctx.organizationId,
      tenantId: input.ctx.tenantId,
      actor: 'user_id',
      actorUserId: input.ctx.userId,
      action: AUDIT_ACTION,
      objectType: AUDIT_OBJECT_TYPE,
      objectId: current.id,
      requestId: idempotencyKey,
      metadata: {
        schema_version: OPERATOR_RECONCILIATION_SCHEMA,
        reconciliation_action_id: currentAction.id,
        decision_hash: stored.decision_hash,
        idempotency_key: idempotencyKey,
        audit_event_id: auditId,
        request_id: input.ctx.requestId ?? null,
        crm_operation_id: current.id,
        noli_core_operation_id: current.noliCoreOperationId,
        provider: current.provider,
        kind: current.kind,
        previous_status: previousStatus,
        canonical_status: canonicalStatus,
        canonical_organization_id: stored.canonical_organization_id,
        canonical_user_id: stored.canonical_user_id,
        decision: decision.outcome,
        charged_credits: decision.chargedCredits,
        evidence_hash: evidenceHash,
        evidence_source: evidence.source,
        evidence_reference_hash: hashText(evidence.reference),
        evidence_observed_at: evidence.observedAt,
        decided_at: stored.decided_at,
      },
    })
    tem.persist(audit)
    await tem.flush()

    return {
      operation: current,
      action: currentAction,
      audit,
      canonicalStatus,
      phase: 'settled',
      idempotent: false,
    }
  })
  await refreshResearchRunReconciliationSummary(input.em, input.ctx, result.operation)
  return result
}

const TERMINAL_PROVIDER_STATUSES = new Set([
  'charged',
  'partially_charged',
  'refunded',
  'released',
])

/*
 * A charged decision on an operation whose receipt says the provider
 * returned rows, while no payload was retained, would bill the customer for
 * output they can never receive (C2). Such an operation must be refunded or
 * released instead. Operations recorded before payload retention existed
 * carry output_count without output_retained and fail this check too; that
 * is deliberate.
 */
function assertChargeableOutputRetained(
  operation: GtmProviderOperation,
  decision: NormalizedDecision,
): void {
  if (decision.outcome !== 'charged' && decision.outcome !== 'partially_charged') return
  const receipt = isPlainRecord(operation.receipt) ? operation.receipt : null
  const observation = isPlainRecord(receipt?.gtm_observation) ? receipt.gtm_observation : null
  const outputCount = exactCredits(observation?.output_count) ?? 0
  if (outputCount === 0) return
  const retained = readRetainedProviderOutput(receipt)
  const materialized = retained?.materialized_at != null
  if (retained && (retained.rows.length > 0 || materialized)) return
  throw new GtmProviderReconciliationError(
    'invalid_decision',
    'provider output was reported but never retained; charging would bill for rows the customer cannot receive',
  )
}

export type ReplayPendingSettlementsResult = {
  scanned: number
  settled: Array<{ operationId: string; noliCoreOperationId: string; status: GtmLedgerStatus }>
  failed: Array<{ operationId: string; noliCoreOperationId: string; error: string }>
  skipped: Array<{ operationId: string; reason: string }>
}

const MAX_SETTLEMENT_REPLAYS = 50

function stripGtmReceiptKeys(receipt: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!isPlainRecord(receipt)) return null
  const { gtm_observation: _observation, [RETAINED_OUTPUT_RECEIPT_KEY]: _retained, ...provider } = receipt
  return provider
}

/**
 * Replays settlements that were decided at execution time but never reached
 * Noli Core (settle threw). The intended action and credits were persisted in
 * the receipt BEFORE the settle attempt, so this re-issues exactly that
 * decision on the SAME operation id; the ledger's exactly-once settle makes a
 * repeat harmless. Bounded, tenant-scoped, and never a provider call. An
 * operation whose receipt lacks a decision is skipped for the operator.
 */
export async function replayPendingSettlements(
  em: CampaignEm,
  ledger: GtmCreditLedger,
  scope: { organizationId: string; tenantId: string },
  options: { now?: () => Date; limit?: number } = {},
): Promise<ReplayPendingSettlementsResult> {
  const now = options.now ?? (() => new Date())
  const limit = Math.max(1, Math.min(MAX_SETTLEMENT_REPLAYS, Math.floor(options.limit ?? MAX_SETTLEMENT_REPLAYS)))
  const candidates = await em.find(
    GtmProviderOperation,
    {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      localStatusMirror: 'provider_started',
      deletedAt: null,
    },
    { orderBy: { requestedAt: 'asc' }, limit: MAX_SETTLEMENT_REPLAYS * 4 },
  )
  const result: ReplayPendingSettlementsResult = { scanned: 0, settled: [], failed: [], skipped: [] }
  for (const operation of candidates) {
    if (result.settled.length + result.failed.length >= limit) break
    const receipt = isPlainRecord(operation.receipt) ? operation.receipt : null
    const observation = isPlainRecord(receipt?.gtm_observation) ? receipt.gtm_observation : null
    if (observation?.settlement_pending !== true) continue
    result.scanned += 1
    const action = observation.intended_ledger_action
    const credits = exactCredits(observation.intended_charged_credits)
    const providerReceipt = stripGtmReceiptKeys(receipt)
    let status: GtmLedgerStatus
    try {
      if (action === 'mark_ambiguous') {
        status = await ledger.markAmbiguous(operation.noliCoreOperationId, {
          error: typeof observation.provider_error === 'string' ? observation.provider_error : 'ambiguous provider outcome',
          receipt: providerReceipt,
        })
      } else if (
        (action === 'charged' || action === 'partially_charged' || action === 'refunded')
        && credits != null
      ) {
        status = await ledger.settle(operation.noliCoreOperationId, action, credits, providerReceipt)
      } else {
        result.skipped.push({ operationId: operation.id, reason: 'receipt carries no replayable intended decision' })
        continue
      }
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : 'unknown canonical ledger error'
      await em.transactional(async (tem) => {
        operation.receipt = {
          ...(receipt ?? {}),
          gtm_observation: {
            ...observation,
            settlement_error: message,
            settlement_replay_attempted_at: now().toISOString(),
          },
        }
        tem.persist(operation)
        await tem.flush()
      })
      result.failed.push({ operationId: operation.id, noliCoreOperationId: operation.noliCoreOperationId, error: message })
      continue
    }
    await em.transactional(async (tem) => {
      operation.localStatusMirror = status
      operation.receipt = {
        ...(receipt ?? {}),
        gtm_observation: {
          ...observation,
          settlement_pending: false,
          canonical_status: status,
          settlement_error: null,
          settlement_replayed_at: now().toISOString(),
        },
      }
      if (SETTLED_STATUSES.has(status)) operation.settledAt = now()
      tem.persist(operation)
      await tem.flush()
    })
    result.settled.push({ operationId: operation.id, noliCoreOperationId: operation.noliCoreOperationId, status })
    if (operation.researchRunId) {
      await repairResearchRunReconciliationSummary(
        em,
        { organizationId: scope.organizationId, tenantId: scope.tenantId, userId: 'system' },
        operation.researchRunId,
        true,
      )
    }
  }
  return result
}

export type ReplayParkedOutputResult = {
  operationId: string
  noliCoreOperationId: string
  researchRunId: string
  idempotent: boolean
  rowsReplayed: number
  candidatesInserted: number
  candidateMatchesCreated: number
  candidatesReused: number
  duplicatesSkipped: number
  suppressedSkipped: number
  accepted: number
  review: number
  rejected: number
}

function frozenRunPlay(run: GtmResearchRun): {
  id?: string
  signal?: string | null
  entityUnit?: string | null
  geography?: string | null
  audience?: string | null
  providerQuery?: Record<string, unknown> | null
  recencyWindow?: string | null
} | null {
  const snapshot = run.inputSnapshot
  const raw = isPlainRecord(snapshot) ? snapshot.play : null
  if (!isPlainRecord(raw)) return null
  return {
    id: typeof raw.id === 'string' ? raw.id : run.playId,
    signal: typeof raw.signal === 'string' ? raw.signal : null,
    entityUnit: typeof raw.entity_unit === 'string' ? raw.entity_unit : null,
    geography: typeof raw.geography === 'string' ? raw.geography : null,
    audience: typeof raw.audience === 'string' ? raw.audience : null,
    providerQuery: isPlainRecord(raw.provider_query) ? raw.provider_query : null,
    recencyWindow: typeof raw.recency_window === 'string' ? raw.recency_window : null,
  }
}

/**
 * Reconciliation action `replay_parked_output`: materializes the provider
 * rows retained in the shadow receipt once the operation has been settled as
 * charged or partially charged (either by the settlement replay or by an
 * explicit operator decision). Refunded/released operations delivered no
 * paid output and are refused. Idempotent: a replayed payload is emptied and
 * stamped, and a second call reports idempotent with zero rows.
 */
export async function replayParkedProviderOutput(input: {
  em: CampaignEm
  ctx: GtmCtx
  operationId: string
  scorer?: FitScorer
  now?: () => Date
}): Promise<ReplayParkedOutputResult> {
  const now = input.now ?? (() => new Date())
  const operation = await findScopedOperation(input.em, input.ctx, input.operationId)
  if (operation.localStatusMirror !== 'charged' && operation.localStatusMirror !== 'partially_charged') {
    throw new GtmProviderReconciliationError(
      'illegal_state',
      'parked output can only be replayed after the operation settles as charged or partially charged',
    )
  }
  const retained = readRetainedProviderOutput(operation.receipt)
  if (!retained) {
    throw new GtmProviderReconciliationError('illegal_state', 'provider operation retained no output payload')
  }
  if (!operation.researchRunId) {
    throw new GtmProviderReconciliationError('illegal_state', 'provider operation is not attached to a research run')
  }
  const base = {
    operationId: operation.id,
    noliCoreOperationId: operation.noliCoreOperationId,
    researchRunId: operation.researchRunId,
  }
  if (retained.materialized_at != null || retained.rows.length === 0) {
    return {
      ...base,
      idempotent: true,
      rowsReplayed: 0,
      candidatesInserted: 0,
      candidateMatchesCreated: 0,
      candidatesReused: 0,
      duplicatesSkipped: 0,
      suppressedSkipped: 0,
      accepted: 0,
      review: 0,
      rejected: 0,
    }
  }
  const run = await input.em.findOne(GtmResearchRun, {
    id: operation.researchRunId,
    organizationId: input.ctx.organizationId,
    tenantId: input.ctx.tenantId,
    deletedAt: null,
  })
  if (!run) throw new GtmProviderReconciliationError('operation_not_found', 'research run was not found')
  const play = frozenRunPlay(run)
  if (!play) throw new GtmProviderReconciliationError('illegal_state', 'research run has no frozen play snapshot')

  const materialized = await materializeProviderRows({
    em: input.em as unknown as ResearchEm,
    run,
    play,
    scorer: input.scorer ?? ruleBasedFitScorer,
    now,
    // Same clock rule as requalify: the run claim, never the wall clock.
    qualificationReferenceTime: run.startedAt ?? run.createdAt,
    rows: retained.rows,
    plannedEntityKind: retained.entity_kind,
    adapterId: retained.adapter_id,
    operationId: operation.noliCoreOperationId,
    shadowId: operation.id,
    evidencePolicy: retained.evidence_policy,
    license: retained.license,
    query: retained.query,
    providerRequestId: retained.provider_request_id,
    seenOpportunityConversations: [],
  })

  await input.em.transactional(async (tem) => {
    const receipt = isPlainRecord(operation.receipt) ? operation.receipt : {}
    operation.receipt = {
      ...receipt,
      [RETAINED_OUTPUT_RECEIPT_KEY]: {
        ...retained,
        rows: [],
        materialized_at: now().toISOString(),
        replayed_by: input.ctx.userId,
      },
    }
    tem.persist(operation)
    const providerPlan = isPlainRecord(run.providerPlan) ? run.providerPlan : {}
    const execution = isPlainRecord(providerPlan.execution) ? providerPlan.execution : {}
    const funnel = isPlainRecord(execution.funnel) ? execution.funnel : {}
    const bump = (value: unknown, delta: number) => (exactCredits(value) ?? 0) + delta
    run.providerPlan = {
      ...providerPlan,
      execution: {
        ...execution,
        candidates_inserted: bump(execution.candidates_inserted, materialized.inserted),
        candidate_matches_created: bump(execution.candidate_matches_created, materialized.matchesCreated),
        candidates_reused: bump(execution.candidates_reused, materialized.reused),
        duplicates_skipped: bump(execution.duplicates_skipped, materialized.duplicates),
        suppressed_skipped: bump(execution.suppressed_skipped, materialized.suppressed),
        evidence_inserted: bump(execution.evidence_inserted, materialized.evidenceRows),
        funnel: {
          ...funnel,
          accepted: bump(funnel.accepted, materialized.accepted),
          review: bump(funnel.review, materialized.review),
          rejected: bump(funnel.rejected, materialized.rejected),
          unique_candidates_inserted: bump(funnel.unique_candidates_inserted, materialized.inserted),
          candidate_matches_created: bump(funnel.candidate_matches_created, materialized.matchesCreated),
        },
        replayed_output: [
          ...(Array.isArray(execution.replayed_output) ? execution.replayed_output : []),
          {
            operation_id: operation.noliCoreOperationId,
            replayed_at: now().toISOString(),
            rows: retained.rows.length,
            candidates_inserted: materialized.inserted,
            candidate_matches_created: materialized.matchesCreated,
            accepted: materialized.accepted,
            review: materialized.review,
            rejected: materialized.rejected,
          },
        ],
      },
    }
    tem.persist(run)
    tem.persist(
      tem.create(GtmAuditEvent, {
        organizationId: input.ctx.organizationId,
        tenantId: input.ctx.tenantId,
        actor: 'user_id',
        actorUserId: input.ctx.userId,
        action: 'gtm.provider_operation.output_replayed',
        objectType: AUDIT_OBJECT_TYPE,
        objectId: operation.id,
        requestId: input.ctx.requestId ?? null,
        metadata: {
          noli_core_operation_id: operation.noliCoreOperationId,
          research_run_id: run.id,
          rows: retained.rows.length,
          candidates_inserted: materialized.inserted,
          candidate_matches_created: materialized.matchesCreated,
          duplicates_skipped: materialized.duplicates,
          suppressed_skipped: materialized.suppressed,
          accepted: materialized.accepted,
          review: materialized.review,
          rejected: materialized.rejected,
        },
      }),
    )
    await tem.flush()
  })

  return {
    ...base,
    idempotent: false,
    rowsReplayed: retained.rows.length,
    candidatesInserted: materialized.inserted,
    candidateMatchesCreated: materialized.matchesCreated,
    candidatesReused: materialized.reused,
    duplicatesSkipped: materialized.duplicates,
    suppressedSkipped: materialized.suppressed,
    accepted: materialized.accepted,
    review: materialized.review,
    rejected: materialized.rejected,
  }
}

function exactCredits(value: unknown): number | null {
  if (typeof value === 'bigint') {
    return value >= BigInt(0) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null
  }
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value
  return Number.isSafeInteger(parsed) && Number(parsed) >= 0 ? Number(parsed) : null
}

function operationChargedCredits(operation: GtmProviderOperation): number | null {
  const receipt = isPlainRecord(operation.receipt) ? operation.receipt : null
  const operator = isPlainRecord(receipt?.[OPERATOR_RECONCILIATION_RECEIPT_KEY])
    ? receipt[OPERATOR_RECONCILIATION_RECEIPT_KEY]
    : null
  const operatorCredits = exactCredits(operator?.charged_credits)
  if (operatorCredits != null) return operatorCredits
  const observation = isPlainRecord(receipt?.gtm_observation)
    ? receipt.gtm_observation
    : null
  const observedCredits = exactCredits(observation?.intended_charged_credits)
  if (observedCredits != null) return observedCredits
  if (operation.localStatusMirror === 'refunded' || operation.localStatusMirror === 'released') {
    return 0
  }
  return null
}

function resolvedResearchStopReason(execution: Record<string, unknown>): string {
  if (execution.failure_reason) return 'failed'
  const funnel = isPlainRecord(execution.funnel) ? execution.funnel : null
  if (funnel?.target_met === true) return 'target_accepted'
  const raw = exactCredits(funnel?.raw_candidates_found)
  const ceiling = exactCredits(funnel?.max_raw_candidates)
  if (raw != null && ceiling != null && ceiling > 0 && raw >= ceiling) return 'max_raw_candidates'
  const batches = Array.isArray(execution.batches) ? execution.batches : []
  if (batches.some((batch) => isPlainRecord(batch) && batch.outcome === 'skipped_max_credits')) {
    return 'max_credits'
  }
  return 'sources_exhausted'
}

async function repairResearchRunReconciliationSummary(
  em: CampaignEm,
  ctx: GtmCtx,
  researchRunId: string,
  onlyWhenHeld = false,
): Promise<boolean> {
  return em.transactional(async (tem) => {
    const run = await tem.findOne(
      GtmResearchRun,
      {
        id: researchRunId,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        deletedAt: null,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (!run) return false
    const providerPlan = isPlainRecord(run.providerPlan) ? run.providerPlan : {}
    const execution = isPlainRecord(providerPlan.execution) ? providerPlan.execution : {}
    if (onlyWhenHeld && execution.reconciliation_required !== true) return false
    const operations = await tem.find(GtmProviderOperation, {
      researchRunId: run.id,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    })
    if (
      operations.length === 0
      || operations.some((candidate) => !TERMINAL_PROVIDER_STATUSES.has(candidate.localStatusMirror ?? ''))
    ) return false

    const creditsByOperation = new Map<string, number>()
    let reconciledCredits = 0
    for (const candidate of operations) {
      const credits = operationChargedCredits(candidate)
      if (credits == null) return false
      creditsByOperation.set(candidate.id, credits)
      reconciledCredits += credits
    }
    if (!Number.isSafeInteger(reconciledCredits)) return false

    const funnel = isPlainRecord(execution.funnel) ? execution.funnel : null
    const batches = Array.isArray(execution.batches)
      ? execution.batches.map((batch) => {
          if (!isPlainRecord(batch) || typeof batch.operation_id !== 'string') return batch
          const matched = operations.find(
            (candidate) => candidate.noliCoreOperationId === batch.operation_id,
          )
          if (!matched) return batch
          return {
            ...batch,
            ledger_status: matched.localStatusMirror,
            charged_credits: creditsByOperation.get(matched.id) ?? batch.charged_credits,
            reconciliation_resolved: true,
          }
        })
      : execution.batches
    const nextExecution: Record<string, unknown> = {
      ...execution,
      reconciliation_required: false,
      reconciled_credits: reconciledCredits,
      ...(batches ? { batches } : {}),
      ...(funnel
        ? {
            funnel: {
              ...funnel,
              stop_reason: resolvedResearchStopReason(execution),
            },
          }
        : {}),
    }
    run.reconciledCredits = String(reconciledCredits)
    run.providerPlan = { ...providerPlan, execution: nextExecution }
    tem.persist(run)
    await tem.flush()
    return true
  })
}

async function refreshResearchRunReconciliationSummary(
  em: CampaignEm,
  ctx: GtmCtx,
  operation: GtmProviderOperation,
): Promise<void> {
  if (!operation.researchRunId) return
  await repairResearchRunReconciliationSummary(em, ctx, operation.researchRunId)
}

/**
 * Repairs only explicitly named stale research-run summaries. A run remains
 * unchanged unless it belongs to the exact tenant and organization, still
 * advertises a reconciliation hold, every child provider operation is
 * terminal, and every terminal charge is recoverable from durable evidence.
 */
export async function repairResolvedResearchRunSummaries(
  em: CampaignEm,
  ctx: GtmCtx,
  runIds: string[],
): Promise<GtmResearchRunSummaryRepairResult> {
  const requestedRunIds = [...new Set(runIds)]
  if (requestedRunIds.length === 0 || requestedRunIds.length > 50) {
    throw new GtmProviderReconciliationError(
      'invalid_evidence',
      'research-run summary repair requires between 1 and 50 exact run ids',
    )
  }

  const repairedRunIds: string[] = []
  const unchangedRunIds: string[] = []
  for (const runId of requestedRunIds) {
    const repaired = await repairResearchRunReconciliationSummary(em, ctx, runId, true)
    if (repaired) repairedRunIds.push(runId)
    else unchangedRunIds.push(runId)
  }
  return { requestedRunIds, repairedRunIds, unchangedRunIds }
}

async function findScopedOperation(
  em: CampaignEm,
  ctx: GtmCtx,
  operationId: string,
): Promise<GtmProviderOperation> {
  const operation = await em.findOne(GtmProviderOperation, {
    id: operationId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!operation) {
    throw new GtmProviderReconciliationError(
      'operation_not_found',
      'provider operation was not found',
    )
  }
  return operation
}

async function findScopedActionByKey(
  em: CampaignEm,
  ctx: GtmCtx,
  idempotencyKey: string,
): Promise<GtmProviderReconciliationAction | null> {
  return em.findOne(GtmProviderReconciliationAction, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    idempotencyKey,
    deletedAt: null,
  })
}

async function findScopedAction(
  em: CampaignEm,
  ctx: GtmCtx,
  actionId: string,
): Promise<GtmProviderReconciliationAction> {
  const action = await em.findOne(GtmProviderReconciliationAction, {
    id: actionId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!action) throw incompleteRecord()
  return action
}

function redactedEvidenceForAction(stored: StoredOperatorReconciliation): Record<string, unknown> {
  return {
    schema_version: OPERATOR_RECONCILIATION_SCHEMA,
    decision_hash: stored.decision_hash,
    source: stored.evidence.source,
    reference_hash: hashText(stored.evidence.reference),
    observed_at: stored.evidence.observedAt,
    summary_hash: hashText(stored.evidence.summary),
    detail_keys: Object.keys(stored.evidence.details).sort(),
  }
}

function assertActionMatches(
  action: GtmProviderReconciliationAction,
  operation: GtmProviderOperation,
  stored: StoredOperatorReconciliation,
  expectedLifecycle: 'pending' | 'completed',
): void {
  const evidence = action.evidenceRedacted
  const expectedEvidence = redactedEvidenceForAction(stored)
  const evidenceDetailKeys = isPlainRecord(evidence) ? evidence.detail_keys : null
  const expectedDetailKeys = expectedEvidence.detail_keys
  if (
    action.id !== stored.action_id ||
    action.organizationId !== stored.organization_id ||
    action.tenantId !== stored.tenant_id ||
    action.providerOperationId !== operation.id ||
    action.idempotencyKey !== stored.idempotency_key ||
    action.decision !== stored.decision ||
    action.expectedStatus !== stored.previous_status ||
    exactCredits(action.chargedCredits) !== stored.charged_credits ||
    action.evidenceHash !== stored.evidence_hash ||
    action.actorUserId !== stored.actor_user_id ||
    action.status !== expectedLifecycle ||
    !isPlainRecord(evidence) ||
    evidence.schema_version !== expectedEvidence.schema_version ||
    evidence.decision_hash !== expectedEvidence.decision_hash ||
    evidence.source !== expectedEvidence.source ||
    evidence.reference_hash !== expectedEvidence.reference_hash ||
    evidence.observed_at !== expectedEvidence.observed_at ||
    evidence.summary_hash !== expectedEvidence.summary_hash ||
    !Array.isArray(evidenceDetailKeys) ||
    !Array.isArray(expectedDetailKeys) ||
    evidenceDetailKeys.length !== expectedDetailKeys.length ||
    evidenceDetailKeys.some((key, index) => key !== expectedDetailKeys[index]) ||
    (expectedLifecycle === 'completed' &&
      (action.resultingStatus !== stored.canonical_status ||
        action.failureReason != null ||
        !action.completedAt ||
        action.completedAt.getTime() !== new Date(stored.decided_at).getTime())) ||
    (expectedLifecycle === 'pending' &&
      (action.resultingStatus != null ||
        action.failureReason != null ||
        action.completedAt != null))
  ) {
    throw new GtmProviderReconciliationError(
      'incomplete_reconciliation_record',
      'provider reconciliation action does not match its immutable decision evidence',
    )
  }
}

async function createPendingAction(
  em: CampaignEm,
  ctx: GtmCtx,
  operation: GtmProviderOperation,
  stored: StoredOperatorReconciliation,
  decidedAt: Date,
): Promise<GtmProviderReconciliationAction> {
  try {
    return await em.transactional(async (tem) => {
      const action = tem.create(GtmProviderReconciliationAction, {
        id: stored.action_id,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        providerOperationId: operation.id,
        idempotencyKey: stored.idempotency_key,
        decision: stored.decision,
        expectedStatus: stored.previous_status,
        resultingStatus: null,
        chargedCredits: stored.charged_credits,
        evidenceHash: stored.evidence_hash,
        evidenceRedacted: redactedEvidenceForAction(stored),
        actorUserId: stored.actor_user_id,
        status: 'pending',
        failureReason: null,
        completedAt: null,
        createdAt: new Date(decidedAt.getTime()),
      })
      tem.persist(action)
      await tem.flush()
      return action
    })
  } catch (error) {
    if (!(error instanceof UniqueConstraintViolationException)) throw error
    const winner = await findScopedActionByKey(em, ctx, stored.idempotency_key)
    if (!winner) {
      throw new GtmProviderReconciliationError(
        'already_reconciled',
        'operator idempotency key is already used in this organization',
      )
    }
    assertActionMatches(winner, operation, stored, 'pending')
    return winner
  }
}

async function rejectPendingAction(
  em: CampaignEm,
  ctx: GtmCtx,
  actionId: string,
  completedAt: Date,
  resultingStatus: GtmLedgerStatus | null,
): Promise<void> {
  await em.transactional(async (tem) => {
    const action = await findScopedAction(tem, ctx, actionId)
    if (action.status !== 'pending') return
    action.status = 'rejected'
    action.resultingStatus = resultingStatus
    action.failureReason = 'canonical_decision_conflict'
    action.completedAt = new Date(completedAt.getTime())
    tem.persist(action)
    await tem.flush()
  })
}

async function reconcileCanonicalDecision(
  canonicalReconciler: GtmCanonicalOperatorReconciler,
  existingReceipt: Record<string, unknown> | null | undefined,
  stored: StoredOperatorReconciliation,
): Promise<GtmLedgerStatus> {
  const expectedBinding = bindingFromStoredRecord(stored)
  const canonical = await canonicalReconciler.reconcile({
    organizationId: stored.canonical_organization_id,
    actorUserId: stored.canonical_user_id,
    billingUserId: stored.canonical_user_id,
    operationId: stored.noli_core_operation_id,
    previousStatus: stored.previous_status,
    outcome: stored.decision,
    chargedCredits: stored.charged_credits,
    receipt: buildCanonicalReceipt(existingReceipt, stored),
    binding: expectedBinding,
  })
  if (
    canonical.operationId !== stored.noli_core_operation_id ||
    canonical.status !== stored.canonical_status ||
    canonical.chargedCredits !== stored.charged_credits ||
    !canonicalBindingMatches(canonical.binding, expectedBinding)
  ) {
    throw new CanonicalDecisionConflictError(
      LEDGER_STATUSES.has(canonical.status) ? canonical.status : null,
    )
  }
  return canonical.status
}

async function resolveExistingRecord(
  em: CampaignEm,
  ctx: GtmCtx,
  operation: GtmProviderOperation,
  idempotencyKey: string,
  decision: NormalizedDecision,
  evidenceHash: string,
  canonicalIdentity: { organizationId: string; userId: string },
): Promise<GtmOperatorReconciliationResult | null> {
  const stored = readStoredOperatorReconciliation(operation.receipt)
  if (!stored) return null

  if (
    stored.organization_id !== ctx.organizationId ||
    stored.tenant_id !== ctx.tenantId ||
    stored.crm_operation_id !== operation.id ||
    stored.noli_core_operation_id !== operation.noliCoreOperationId ||
    stored.provider !== operation.provider ||
    stored.kind !== operation.kind ||
    stored.action_id !== deterministicActionId(ctx, stored.idempotency_key) ||
    stored.audit_event_id !==
      deterministicAuditEventId(ctx, operation.noliCoreOperationId) ||
    operation.localStatusMirror !== stored.canonical_status ||
    !operation.settledAt ||
    operation.settledAt.getTime() !== new Date(stored.decided_at).getTime() ||
    operation.noliCoreOperationId.length === 0
  ) {
    throw new GtmProviderReconciliationError(
      'incomplete_reconciliation_record',
      'operator reconciliation record does not match the operation shadow',
    )
  }

  const action = await findScopedAction(em, ctx, stored.action_id)
  assertActionMatches(action, operation, stored, 'completed')

  const audit = await em.findOne(GtmAuditEvent, {
    id: stored.audit_event_id,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    actor: 'user_id',
    actorUserId: stored.actor_user_id,
    action: AUDIT_ACTION,
    objectType: AUDIT_OBJECT_TYPE,
    objectId: operation.id,
    requestId: stored.idempotency_key,
    deletedAt: null,
  })
  if (!audit || !auditMetadataMatches(audit.metadata, operation, stored)) {
    throw new GtmProviderReconciliationError(
      'incomplete_reconciliation_record',
      'operator reconciliation audit evidence is missing or inconsistent',
    )
  }

  const exactReplay =
    stored.idempotency_key === idempotencyKey &&
    stored.actor_user_id === ctx.userId &&
    stored.canonical_organization_id === canonicalIdentity.organizationId &&
    stored.canonical_user_id === canonicalIdentity.userId &&
    stored.decision === decision.outcome &&
    stored.charged_credits === decision.chargedCredits &&
    stored.evidence_hash === evidenceHash

  if (!exactReplay) {
    throw new GtmProviderReconciliationError(
      'already_reconciled',
      'provider operation already has an immutable operator reconciliation decision',
    )
  }

  return {
    operation,
    action,
    audit,
    canonicalStatus: stored.canonical_status,
    phase: 'settled',
    idempotent: true,
  }
}

function auditMetadataMatches(
  metadata: Record<string, unknown> | null | undefined,
  operation: GtmProviderOperation,
  stored: StoredOperatorReconciliation,
): boolean {
  if (!isPlainRecord(metadata)) return false
  return (
    metadata.schema_version === OPERATOR_RECONCILIATION_SCHEMA &&
    metadata.reconciliation_action_id === stored.action_id &&
    metadata.decision_hash === stored.decision_hash &&
    metadata.idempotency_key === stored.idempotency_key &&
    metadata.audit_event_id === stored.audit_event_id &&
    metadata.crm_operation_id === operation.id &&
    metadata.noli_core_operation_id === operation.noliCoreOperationId &&
    metadata.provider === stored.provider &&
    metadata.kind === stored.kind &&
    metadata.previous_status === stored.previous_status &&
    metadata.canonical_status === stored.canonical_status &&
    metadata.canonical_organization_id === stored.canonical_organization_id &&
    metadata.canonical_user_id === stored.canonical_user_id &&
    metadata.decision === stored.decision &&
    metadata.charged_credits === stored.charged_credits &&
    metadata.evidence_hash === stored.evidence_hash &&
    metadata.evidence_source === stored.evidence.source &&
    metadata.evidence_reference_hash === hashText(stored.evidence.reference) &&
    metadata.evidence_observed_at === stored.evidence.observedAt &&
    metadata.decided_at === stored.decided_at
  )
}

function normalizeIdempotencyKey(value: string): string {
  const key = typeof value === 'string' ? value.trim() : ''
  if (!key || key.length > 200) {
    throw new GtmProviderReconciliationError(
      'invalid_idempotency_key',
      'idempotencyKey must be between 1 and 200 characters',
    )
  }
  return key
}

function normalizeCanonicalIdentity(value: {
  organizationId: string
  userId: string
}): { organizationId: string; userId: string } {
  const organizationId = typeof value?.organizationId === 'string'
    ? value.organizationId.trim()
    : ''
  const userId = typeof value?.userId === 'string' ? value.userId.trim() : ''
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!uuid.test(organizationId) || !uuid.test(userId)) {
    throw new GtmProviderReconciliationError(
      'invalid_decision',
      'canonical Noli organization and user identity must be UUIDs',
    )
  }
  return { organizationId, userId }
}

function normalizeDecision(value: GtmOperatorReconciliationDecision): NormalizedDecision {
  if (!isPlainRecord(value)) {
    throw invalidDecision('decision must be an object')
  }
  const outcome = value.outcome
  if (outcome === 'release' || outcome === 'refunded') {
    if (value.chargedCredits != null && value.chargedCredits !== 0) {
      throw invalidDecision(`${outcome} must charge 0 credits`)
    }
    return { outcome, chargedCredits: 0 }
  }
  if (outcome === 'charged' || outcome === 'partially_charged') {
    if (!Number.isInteger(value.chargedCredits) || Number(value.chargedCredits) < 1) {
      throw invalidDecision(`${outcome} requires a positive integer chargedCredits`)
    }
    return { outcome, chargedCredits: Number(value.chargedCredits) }
  }
  throw invalidDecision('unsupported operator reconciliation outcome')
}

function invalidDecision(message: string): GtmProviderReconciliationError {
  return new GtmProviderReconciliationError('invalid_decision', message)
}

function normalizeEvidence(value: GtmOperatorReconciliationEvidence): NormalizedEvidence {
  if (!isPlainRecord(value)) throw invalidEvidence('evidence must be an object')
  const source = requiredEvidenceText(value.source, 'source', 100)
  const reference = requiredEvidenceText(value.reference, 'reference', 500)
  const summary = requiredEvidenceText(value.summary, 'summary', 2_000)
  const observedAtRaw = requiredEvidenceText(value.observedAt, 'observedAt', 100)
  const observedAt = new Date(observedAtRaw)
  if (Number.isNaN(observedAt.getTime())) {
    throw invalidEvidence('observedAt must be a valid date-time')
  }
  if (!isPlainRecord(value.details) || Object.keys(value.details).length === 0) {
    throw invalidEvidence('details must be a non-empty JSON object')
  }
  const seen = new Set<object>()
  const details = normalizeJsonValue(value.details, 'details', 0, seen, true)
  if (!isNormalizedJsonObject(details)) {
    throw invalidEvidence('details must be a JSON object')
  }
  const normalized: NormalizedEvidence = {
    source,
    reference,
    observedAt: observedAt.toISOString(),
    summary,
    details,
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_EVIDENCE_BYTES) {
    throw invalidEvidence(`evidence must not exceed ${MAX_EVIDENCE_BYTES} bytes`)
  }
  return normalized
}

function requiredEvidenceText(value: unknown, field: string, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > maxLength) {
    throw invalidEvidence(`${field} must be between 1 and ${maxLength} characters`)
  }
  return normalized
}

function invalidEvidence(message: string): GtmProviderReconciliationError {
  return new GtmProviderReconciliationError('invalid_evidence', message)
}

function normalizeJsonValue(
  value: unknown,
  path: string,
  depth: number,
  seen: Set<object>,
  rejectSecretKeys: boolean,
): JsonValue {
  if (depth > MAX_JSON_DEPTH) throw invalidEvidence(`${path} exceeds maximum JSON depth`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidEvidence(`${path} contains a non-finite number`)
    return value
  }
  if (typeof value !== 'object') throw invalidEvidence(`${path} contains a non-JSON value`)
  if (seen.has(value)) throw invalidEvidence(`${path} contains a circular reference`)

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        normalizeJsonValue(item, `${path}[${index}]`, depth + 1, seen, rejectSecretKeys),
      )
    }
    if (!isPlainRecord(value)) throw invalidEvidence(`${path} contains a non-plain object`)
    const normalized: { [key: string]: JsonValue } = {}
    for (const key of Object.keys(value).sort()) {
      const compactKey = key.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw invalidEvidence(`${path} contains a forbidden key`)
      }
      if (rejectSecretKeys && FORBIDDEN_EVIDENCE_KEYS.has(compactKey)) {
        throw invalidEvidence(`${path} contains a secret-like key`)
      }
      normalized[key] = normalizeJsonValue(
        value[key],
        `${path}.${key}`,
        depth + 1,
        seen,
        rejectSecretKeys,
      )
    }
    return normalized
  } finally {
    seen.delete(value)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isNormalizedJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hashEvidence(evidence: NormalizedEvidence): string {
  return crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
}

function hashText(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function hashDecisionRecord(
  record: Omit<StoredOperatorReconciliation, 'decision_hash'>,
): string {
  // The pending action durably anchors decided_at before the canonical call,
  // so an exact retry can bind chronology as well as decision/evidence.
  const identity = {
    schema_version: record.schema_version,
    action_id: record.action_id,
    organization_id: record.organization_id,
    tenant_id: record.tenant_id,
    crm_operation_id: record.crm_operation_id,
    noli_core_operation_id: record.noli_core_operation_id,
    provider: record.provider,
    kind: record.kind,
    idempotency_key: record.idempotency_key,
    audit_event_id: record.audit_event_id,
    decision: record.decision,
    charged_credits: record.charged_credits,
    previous_status: record.previous_status,
    canonical_status: record.canonical_status,
    canonical_organization_id: record.canonical_organization_id,
    canonical_user_id: record.canonical_user_id,
    actor_user_id: record.actor_user_id,
    decided_at: record.decided_at,
    evidence_hash: record.evidence_hash,
  }
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

function bindingFromStoredRecord(
  stored: StoredOperatorReconciliation,
): GtmCanonicalDecisionBinding {
  return {
    schemaVersion: OPERATOR_RECONCILIATION_SCHEMA,
    idempotencyKey: stored.idempotency_key,
    auditEventId: stored.audit_event_id,
    evidenceHash: stored.evidence_hash,
    decisionHash: stored.decision_hash,
    decidedAt: stored.decided_at,
  }
}

function canonicalBindingMatches(
  actual: GtmCanonicalDecisionBinding | null,
  expected: GtmCanonicalDecisionBinding,
): boolean {
  return (
    actual !== null &&
    actual.schemaVersion === expected.schemaVersion &&
    actual.idempotencyKey === expected.idempotencyKey &&
    actual.auditEventId === expected.auditEventId &&
    actual.evidenceHash === expected.evidenceHash &&
    actual.decisionHash === expected.decisionHash &&
    actual.decidedAt === expected.decidedAt
  )
}

function deterministicAuditEventId(ctx: GtmCtx, canonicalOperationId: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(
      `${OPERATOR_RECONCILIATION_SCHEMA}:${ctx.organizationId}:${ctx.tenantId}:${canonicalOperationId}`,
    )
    .digest('hex')
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-')
}

function deterministicActionId(ctx: GtmCtx, idempotencyKey: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(
      `${OPERATOR_RECONCILIATION_SCHEMA}:action:${ctx.organizationId}:${idempotencyKey}`,
    )
    .digest('hex')
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-')
}

function normalizeDecisionTime(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new GtmProviderReconciliationError('invalid_evidence', 'decision time is invalid')
  }
  return new Date(value.getTime())
}

function requireActionableStatus(status: string | null | undefined): GtmLedgerStatus {
  if (!status || !LEDGER_STATUSES.has(status)) {
    throw new GtmProviderReconciliationError(
      'illegal_state',
      'provider operation has an unknown local status mirror',
    )
  }
  if (SETTLED_STATUSES.has(status as GtmLedgerStatus)) {
    throw new GtmProviderReconciliationError(
      'illegal_state',
      'settled provider operation has no operator reconciliation record and is read-only',
    )
  }
  return status as GtmLedgerStatus
}

function assertDecisionAllowed(status: GtmLedgerStatus, decision: NormalizedDecision): void {
  const phase = classifyProviderOperationStatus(status)
  if (phase === 'reserved' && decision.outcome === 'release') return
  if (
    (phase === 'started' || phase === 'ambiguous') &&
    decision.outcome !== 'release'
  ) {
    return
  }
  throw new GtmProviderReconciliationError(
    'illegal_state',
    phase === 'reserved'
      ? 'a pre-provider reservation can only be explicitly released'
      : 'a started or ambiguous provider operation must be explicitly settled, not released',
  )
}

function expectedCanonicalStatus(decision: NormalizedDecision): GtmLedgerStatus {
  return decision.outcome === 'release' ? 'released' : decision.outcome
}

function buildCanonicalReceipt(
  existing: Record<string, unknown> | null | undefined,
  reconciliation: Record<string, unknown> | StoredOperatorReconciliation,
): Record<string, unknown> {
  const cloned = cloneExistingReceipt(existing)
  const clonedReconciliation = normalizeJsonValue(
    reconciliation,
    OPERATOR_RECONCILIATION_RECEIPT_KEY,
    0,
    new Set<object>(),
    false,
  )
  if (!isNormalizedJsonObject(clonedReconciliation)) throw incompleteRecord()
  cloned[OPERATOR_RECONCILIATION_RECEIPT_KEY] = clonedReconciliation
  return cloned
}

function cloneExistingReceipt(
  existing: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (existing == null) return {}
  if (!isPlainRecord(existing)) {
    throw new GtmProviderReconciliationError(
      'incomplete_reconciliation_record',
      'existing provider receipt is not a JSON object',
    )
  }
  // JSONB reads are JSON values. Normalizing here produces an independent
  // clone so neither the caller nor the pre-existing receipt object can later
  // mutate the stored evidence through a shared reference.
  const clone = normalizeJsonValue(existing, 'receipt', 0, new Set<object>(), false)
  if (!isNormalizedJsonObject(clone)) {
    throw new GtmProviderReconciliationError(
      'incomplete_reconciliation_record',
      'existing provider receipt is not a JSON object',
    )
  }
  return clone
}

function inspectOperatorRecordState(
  receipt: Record<string, unknown> | null | undefined,
): 'absent' | 'recorded' | 'invalid' {
  if (receipt == null) return 'absent'
  if (!isPlainRecord(receipt)) return 'invalid'
  if (receipt[OPERATOR_RECONCILIATION_RECEIPT_KEY] == null) return 'absent'
  try {
    return readStoredOperatorReconciliation(receipt) ? 'recorded' : 'absent'
  } catch {
    return 'invalid'
  }
}

function readStoredOperatorReconciliation(
  receipt: Record<string, unknown> | null | undefined,
): StoredOperatorReconciliation | null {
  if (receipt == null) return null
  if (!isPlainRecord(receipt)) throw incompleteRecord()
  const raw = receipt[OPERATOR_RECONCILIATION_RECEIPT_KEY]
  if (raw == null) return null
  if (!isPlainRecord(raw)) throw incompleteRecord()

  const decision = raw.decision
  const canonicalStatus = raw.canonical_status
  const previousStatus = raw.previous_status
  if (
    raw.schema_version !== OPERATOR_RECONCILIATION_SCHEMA ||
    typeof raw.action_id !== 'string' ||
    !raw.action_id ||
    typeof raw.organization_id !== 'string' ||
    !raw.organization_id ||
    typeof raw.tenant_id !== 'string' ||
    !raw.tenant_id ||
    typeof raw.crm_operation_id !== 'string' ||
    !raw.crm_operation_id ||
    typeof raw.noli_core_operation_id !== 'string' ||
    !raw.noli_core_operation_id ||
    typeof raw.provider !== 'string' ||
    !raw.provider ||
    typeof raw.kind !== 'string' ||
    !raw.kind ||
    typeof raw.idempotency_key !== 'string' ||
    !raw.idempotency_key ||
    typeof raw.audit_event_id !== 'string' ||
    !raw.audit_event_id ||
    (decision !== 'release' &&
      decision !== 'charged' &&
      decision !== 'partially_charged' &&
      decision !== 'refunded') ||
    !Number.isInteger(raw.charged_credits) ||
    Number(raw.charged_credits) < 0 ||
    typeof previousStatus !== 'string' ||
    !LEDGER_STATUSES.has(previousStatus) ||
    typeof canonicalStatus !== 'string' ||
    !SETTLED_STATUSES.has(canonicalStatus as GtmLedgerStatus) ||
    typeof raw.actor_user_id !== 'string' ||
    !raw.actor_user_id ||
    typeof raw.canonical_organization_id !== 'string' ||
    !raw.canonical_organization_id ||
    typeof raw.canonical_user_id !== 'string' ||
    !raw.canonical_user_id ||
    typeof raw.decided_at !== 'string' ||
    Number.isNaN(new Date(raw.decided_at).getTime()) ||
    typeof raw.evidence_hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.evidence_hash) ||
    typeof raw.decision_hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.decision_hash)
  ) {
    throw incompleteRecord()
  }

  let evidence: NormalizedEvidence
  try {
    evidence = normalizeEvidence(raw.evidence as GtmOperatorReconciliationEvidence)
  } catch {
    throw incompleteRecord()
  }
  if (hashEvidence(evidence) !== raw.evidence_hash) throw incompleteRecord()

  const normalized: StoredOperatorReconciliation = {
    schema_version: OPERATOR_RECONCILIATION_SCHEMA,
    action_id: raw.action_id,
    organization_id: raw.organization_id,
    tenant_id: raw.tenant_id,
    crm_operation_id: raw.crm_operation_id,
    noli_core_operation_id: raw.noli_core_operation_id,
    provider: raw.provider,
    kind: raw.kind,
    idempotency_key: raw.idempotency_key,
    audit_event_id: raw.audit_event_id,
    decision,
    charged_credits: Number(raw.charged_credits),
    previous_status: previousStatus as GtmLedgerStatus,
    canonical_status: canonicalStatus as GtmLedgerStatus,
    canonical_organization_id: raw.canonical_organization_id,
    canonical_user_id: raw.canonical_user_id,
    actor_user_id: raw.actor_user_id,
    decided_at: new Date(raw.decided_at).toISOString(),
    evidence,
    evidence_hash: raw.evidence_hash,
    decision_hash: raw.decision_hash,
  }

  if (
    normalized.canonical_status !== expectedCanonicalStatus({
      outcome: normalized.decision,
      chargedCredits: normalized.charged_credits,
    }) ||
    (normalized.decision === 'release' || normalized.decision === 'refunded'
      ? normalized.charged_credits !== 0
      : normalized.charged_credits < 1)
  ) {
    throw incompleteRecord()
  }
  if (hashDecisionRecord(normalized) !== normalized.decision_hash) {
    throw incompleteRecord()
  }
  try {
    assertDecisionAllowed(normalized.previous_status, {
      outcome: normalized.decision,
      chargedCredits: normalized.charged_credits,
    })
  } catch {
    throw incompleteRecord()
  }
  return normalized
}

function incompleteRecord(): GtmProviderReconciliationError {
  return new GtmProviderReconciliationError(
    'incomplete_reconciliation_record',
    'operator reconciliation record is malformed or its evidence hash does not match',
  )
}
