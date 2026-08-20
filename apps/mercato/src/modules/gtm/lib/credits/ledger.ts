import crypto from 'crypto'

/*
 * Credit-ledger seam (GTM-SPEC-01 section 4.5 RPC shapes, SPEC-066 section
 * 11.2 invocation rule).
 *
 * noli-core is the SOLE canonical pooled-credit ledger. This interface mirrors
 * the frozen RPC contract exactly:
 *
 *   provider_op_reserve        -> reserve()
 *   provider_op_start          -> start()
 *   provider_op_settle         -> settle()
 *   provider_op_mark_ambiguous -> markAmbiguous()
 *   provider_op_release        -> release()
 *
 * Lifecycle (frozen): estimated -> reserved -> provider_started ->
 * charged | partially_charged | refunded | reconciliation_required, plus
 * released for reservations abandoned before provider contact.
 *
 * The CRM never owns or mutates balances, never infers a charge locally, and
 * never creates a replacement operation after an ambiguous result. Everything
 * in this tranche runs against the in-memory FixtureLedger below.
 *
 * TRANCHE 4 STUB - NoliCoreRpcLedger: the REAL implementation of
 * GtmCreditLedger calls the noli-core SECURITY DEFINER RPCs
 * (provider_op_reserve / provider_op_start / provider_op_settle /
 * provider_op_mark_ambiguous / provider_op_release) through the existing
 * noli-core service-role client. It is deliberately NOT written in Tranche 3;
 * when Tranche 4 lands it will live alongside this file (for example
 * lib/credits/noli-core-ledger.ts) and be swapped in behind the same
 * interface. Do not add any noli-core network call in this file.
 */

export type GtmLedgerStatus =
  | 'estimated'
  | 'reserved'
  | 'provider_started'
  | 'charged'
  | 'partially_charged'
  | 'refunded'
  | 'reconciliation_required'
  | 'released'

export type GtmSettleOutcome = 'charged' | 'partially_charged' | 'refunded'

const SETTLED_STATUSES: ReadonlySet<GtmLedgerStatus> = new Set([
  'charged',
  'partially_charged',
  'refunded',
])

export type GtmReserveInput = {
  orgId: string
  userId: string
  // adapter capability id, e.g. 'source_search'
  kind: string
  // adapter id, e.g. 'fixture-source'
  provider: string
  estimatedCredits: number
  // caller-supplied, org-scoped; the exactly-once anchor
  idempotencyKey: string
  unitCostSnapshot?: Record<string, unknown> | null
  fingerprint?: Record<string, unknown> | null
}

export type GtmReserveResult = {
  operationId: string
  status: GtmLedgerStatus
}

export type GtmStartResult = {
  status: GtmLedgerStatus
  // True only for the caller that atomically owns provider contact.
  startedNow: boolean
}

export type GtmLedgerErrorCode =
  | 'insufficient_credits'
  | 'illegal_transition'
  | 'unknown_operation'
  | 'invalid_reserve'
  | 'invalid_settle'

export class GtmCreditLedgerError extends Error {
  code: GtmLedgerErrorCode

  constructor(code: GtmLedgerErrorCode, message: string) {
    super(message)
    this.name = 'GtmCreditLedgerError'
    this.code = code
  }
}

export interface GtmCreditLedger {
  reserve(input: GtmReserveInput): Promise<GtmReserveResult>
  start(operationId: string): Promise<GtmStartResult>
  settle(
    operationId: string,
    outcome: GtmSettleOutcome,
    chargedCredits: number,
    receipt: Record<string, unknown> | null,
  ): Promise<GtmLedgerStatus>
  markAmbiguous(operationId: string, detail: Record<string, unknown> | null): Promise<GtmLedgerStatus>
  release(operationId: string): Promise<GtmLedgerStatus>
}

// ---------------------------------------------------------------------------
// FixtureLedger: deterministic in-memory implementation for tests and the
// fixtures-first execution path of this tranche.
// ---------------------------------------------------------------------------

export type FixtureLedgerOperation = {
  operationId: string
  orgId: string
  userId: string
  kind: string
  provider: string
  status: GtmLedgerStatus
  estimatedCredits: number
  reservedCredits: number
  chargedCredits: number
  idempotencyKey: string
  unitCostSnapshot: Record<string, unknown> | null
  fingerprint: Record<string, unknown> | null
  receipt: Record<string, unknown> | null
  ambiguousDetail: Record<string, unknown> | null
}

// Deterministic canonical operation id: sha256(orgId + ':' + idempotencyKey)
// folded into uuid formatting. The same (org, key) always yields the same id,
// on any ledger instance, which is exactly the idempotent-reserve anchor the
// real RPC provides via its unique (organization_id, idempotency_key) index.
export function deterministicOperationId(orgId: string, idempotencyKey: string): string {
  const hash = crypto.createHash('sha256').update(`${orgId}:${idempotencyKey}`).digest('hex')
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-')
}

export class FixtureLedger implements GtmCreditLedger {
  private poolBalance: number
  private opsById = new Map<string, FixtureLedgerOperation>()

  constructor(options?: { poolBalance?: number }) {
    this.poolBalance = options?.poolBalance ?? 10_000
  }

  setPoolBalance(balance: number): void {
    this.poolBalance = balance
  }

  // Pool headroom = balance minus durable charges minus outstanding
  // reservations (reserved + provider_started + reconciliation_required, which
  // still escrow their reservation until an operator/delayed settle lands).
  availableCredits(): number {
    let held = 0
    for (const op of this.opsById.values()) {
      if (
        op.status === 'reserved' ||
        op.status === 'provider_started' ||
        op.status === 'reconciliation_required'
      ) {
        held += op.reservedCredits
      } else if (SETTLED_STATUSES.has(op.status)) {
        held += op.chargedCredits
      }
    }
    return this.poolBalance - held
  }

  getOperation(operationId: string): FixtureLedgerOperation | null {
    const op = this.opsById.get(operationId)
    return op ? { ...op } : null
  }

  listOperations(): FixtureLedgerOperation[] {
    return [...this.opsById.values()].map((op) => ({ ...op }))
  }

  async reserve(input: GtmReserveInput): Promise<GtmReserveResult> {
    if (!input.orgId || !input.idempotencyKey) {
      throw new GtmCreditLedgerError('invalid_reserve', 'orgId and idempotencyKey are required')
    }
    if (!Number.isInteger(input.estimatedCredits) || input.estimatedCredits < 1) {
      // Unbounded or zero-value operations are rejected (GTM-SPEC-01 4.1).
      throw new GtmCreditLedgerError(
        'invalid_reserve',
        `estimatedCredits must be a positive integer, got ${input.estimatedCredits}`,
      )
    }

    const operationId = deterministicOperationId(input.orgId, input.idempotencyKey)

    // Idempotent on (org, key): the same key returns the existing operation in
    // its CURRENT state, reserving nothing new.
    const existing = this.opsById.get(operationId)
    if (existing) {
      return { operationId: existing.operationId, status: existing.status }
    }

    // FAIL CLOSED before any provider contact: insufficient headroom throws
    // and the caller must never invoke the adapter.
    if (input.estimatedCredits > this.availableCredits()) {
      throw new GtmCreditLedgerError(
        'insufficient_credits',
        `insufficient_credits: need ${input.estimatedCredits}, available ${this.availableCredits()}`,
      )
    }

    const op: FixtureLedgerOperation = {
      operationId,
      orgId: input.orgId,
      userId: input.userId,
      kind: input.kind,
      provider: input.provider,
      status: 'reserved',
      estimatedCredits: input.estimatedCredits,
      reservedCredits: input.estimatedCredits,
      chargedCredits: 0,
      idempotencyKey: input.idempotencyKey,
      unitCostSnapshot: input.unitCostSnapshot ?? null,
      fingerprint: input.fingerprint ?? null,
      receipt: null,
      ambiguousDetail: null,
    }
    this.opsById.set(operationId, op)
    return { operationId, status: op.status }
  }

  async start(operationId: string): Promise<GtmStartResult> {
    const op = this.require(operationId)
    if (op.status === 'reserved') {
      op.status = 'provider_started'
      return { status: op.status, startedNow: true }
    }
    // Idempotent repeat of start is a no-op.
    if (op.status === 'provider_started') return { status: op.status, startedNow: false }
    throw new GtmCreditLedgerError(
      'illegal_transition',
      `start is only legal from reserved, operation is ${op.status}`,
    )
  }

  async settle(
    operationId: string,
    outcome: GtmSettleOutcome,
    chargedCredits: number,
    receipt: Record<string, unknown> | null,
  ): Promise<GtmLedgerStatus> {
    const op = this.require(operationId)

    // Exactly-once: a repeat settle (double settle, webhook replay) returns
    // the settled state unchanged and never mutates the charge.
    if (SETTLED_STATUSES.has(op.status)) return op.status

    const legalFrom =
      op.status === 'provider_started' ||
      // pre-start abort: reserved may settle, but only as a refund
      (op.status === 'reserved' && outcome === 'refunded') ||
      // delayed-completion / operator resolution path settles the SAME parked
      // operation (never a replacement operation)
      op.status === 'reconciliation_required'
    if (!legalFrom) {
      throw new GtmCreditLedgerError(
        'illegal_transition',
        `settle(${outcome}) is not legal from ${op.status}`,
      )
    }

    if (!Number.isInteger(chargedCredits) || chargedCredits < 0) {
      throw new GtmCreditLedgerError(
        'invalid_settle',
        `chargedCredits must be a non-negative integer, got ${chargedCredits}`,
      )
    }
    if (outcome === 'refunded' && chargedCredits !== 0) {
      throw new GtmCreditLedgerError('invalid_settle', 'refunded settle must charge 0 credits')
    }
    if (chargedCredits > op.reservedCredits) {
      throw new GtmCreditLedgerError(
        'invalid_settle',
        `chargedCredits ${chargedCredits} exceeds reservedCredits ${op.reservedCredits}`,
      )
    }

    op.status = outcome
    op.chargedCredits = chargedCredits
    op.receipt = receipt ?? null
    return op.status
  }

  async markAmbiguous(
    operationId: string,
    detail: Record<string, unknown> | null,
  ): Promise<GtmLedgerStatus> {
    const op = this.require(operationId)
    if (op.status === 'provider_started') {
      op.status = 'reconciliation_required'
      op.ambiguousDetail = detail ?? null
      return op.status
    }
    // Idempotent repeat keeps the parked state.
    if (op.status === 'reconciliation_required') return op.status
    throw new GtmCreditLedgerError(
      'illegal_transition',
      `markAmbiguous is only legal from provider_started, operation is ${op.status}`,
    )
  }

  async release(operationId: string): Promise<GtmLedgerStatus> {
    const op = this.require(operationId)
    if (op.status === 'estimated' || op.status === 'reserved') {
      op.status = 'released'
      return op.status
    }
    if (op.status === 'released') return op.status
    throw new GtmCreditLedgerError(
      'illegal_transition',
      `release is only legal from estimated or reserved, operation is ${op.status}`,
    )
  }

  private require(operationId: string): FixtureLedgerOperation {
    const op = this.opsById.get(operationId)
    if (!op) {
      throw new GtmCreditLedgerError('unknown_operation', `unknown operation ${operationId}`)
    }
    return op
  }
}

// Process-wide fixture ledger used by the internal routes until the Tranche 4
// NoliCoreRpcLedger exists. Pool size is configurable for local exercise via
// GTM_FIXTURE_CREDIT_POOL; the value has no production meaning.
let processFixtureLedger: FixtureLedger | null = null

export function getProcessFixtureLedger(): FixtureLedger {
  if (!processFixtureLedger) {
    const raw = Number(process.env.GTM_FIXTURE_CREDIT_POOL ?? '10000')
    const poolBalance = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10_000
    processFixtureLedger = new FixtureLedger({ poolBalance })
  }
  return processFixtureLedger
}
