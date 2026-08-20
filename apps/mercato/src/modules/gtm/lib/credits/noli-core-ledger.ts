import {
  FixtureLedger,
  GtmCreditLedgerError,
  getProcessFixtureLedger,
  type GtmCreditLedger,
  type GtmLedgerErrorCode,
  type GtmLedgerStatus,
  type GtmReserveInput,
  type GtmReserveResult,
  type GtmSettleOutcome,
  type GtmStartResult,
} from './ledger'
import type {
  GtmCanonicalOperatorReconciler,
  GtmCanonicalOperatorReconciliationRequest,
  GtmCanonicalOperatorReconciliationResult,
} from '../reconciliation/operator'

/*
 * NoliCoreRpcLedger (SPEC-066 section 11.2, Tranche 4): the REAL
 * implementation of GtmCreditLedger. noli-core is the SOLE canonical
 * pooled-credit ledger; this class only forwards to the noli-core SECURITY
 * DEFINER RPCs through the CRM's existing noli-core service-role Supabase
 * client and never keeps a balance or infers a charge locally.
 *
 * Frozen RPC contract (written in parallel in noli-core; coded against
 * exactly these signatures):
 *
 *   provider_op_reserve(p_org, p_user, p_app, p_kind, p_provider,
 *     p_estimated_credits, p_idempotency_key, p_unit_cost jsonb,
 *     p_fingerprint jsonb) -> jsonb { operation_id, status, reserved_credits }
 *     raises 'insufficient_credits' | 'invalid_estimate' | 'unbounded_operation'
 *   provider_op_start(p_operation_id) -> { operation_id, status, started_now }
 *   provider_op_settle(p_operation_id, p_outcome, p_charged_credits,
 *     p_receipt jsonb) -> { operation_id, status, charged_credits }
 *   provider_op_mark_ambiguous(p_operation_id, p_detail jsonb)
 *     -> { operation_id, status }
 *   provider_op_release(p_operation_id) -> { operation_id, status }
 *
 * FAIL-CLOSED SEMANTICS (do not weaken):
 *
 * - reserve: ANY error - a typed SQL exception, a transport failure, or an
 *   unparseable response - throws. The caller must never proceed to a
 *   provider adapter without a confirmed reservation; an unknown reserve
 *   outcome is treated as no reservation and the whole operation stops
 *   before any spend.
 *
 * - settle / markAmbiguous: a transport or unknown error throws WITHOUT
 *   inventing any local state. The charge truth lives only in noli-core; on
 *   a failed settle the caller must PARK the operation (shadow row keeps
 *   local_status_mirror = 'provider_started') and retry the settle later
 *   WITH THE SAME operation id. Never create a replacement operation, never
 *   mark the shadow settled, never guess whether the settle landed - the
 *   RPC is exactly-once on the noli-core side, so replaying the same
 *   operation id is always safe.
 *
 * Typed SQL exceptions are mapped onto the same GtmCreditLedgerError codes
 * FixtureLedger throws, so callers behave identically against either
 * implementation.
 */

// Minimal structural slice of the Supabase client used here, so unit tests
// can drive the ledger with a mocked rpc() and no network or import of the
// server-only core-client module.
export type NoliCoreRpcClient = {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>
}

// SQL exception message fragment -> the FixtureLedger error code vocabulary.
const SQL_ERROR_CODE_MAP: ReadonlyArray<[fragment: string, code: GtmLedgerErrorCode]> = [
  ['insufficient_credits', 'insufficient_credits'],
  ['invalid_estimate', 'invalid_reserve'],
  ['unbounded_operation', 'invalid_reserve'],
  ['illegal_transition', 'illegal_transition'],
  ['unknown_operation', 'unknown_operation'],
  ['invalid_settle', 'invalid_settle'],
  ['invalid_outcome', 'invalid_settle'],
]

// Maps a noli-core RPC error onto a typed ledger error when the message
// carries one of the frozen exception tokens; otherwise returns null and the
// caller must treat the failure as a transport/unknown error (fail closed).
export function mapRpcErrorToLedgerError(
  message: string | undefined,
): GtmCreditLedgerError | null {
  const haystack = (message ?? '').toLowerCase()
  for (const [fragment, code] of SQL_ERROR_CODE_MAP) {
    if (haystack.includes(fragment)) {
      return new GtmCreditLedgerError(code, message || fragment)
    }
  }
  return null
}

export class NoliCoreLedgerTransportError extends Error {
  operation: string

  constructor(operation: string, message: string) {
    super(`noli-core ledger ${operation} failed: ${message}`)
    this.name = 'NoliCoreLedgerTransportError'
    this.operation = operation
  }
}

export class NoliCoreLedgerConfigurationError extends Error {
  constructor(message: string) {
    super(`noli-core ledger is not safely configured: ${message}`)
    this.name = 'NoliCoreLedgerConfigurationError'
  }
}

type RpcRow = Record<string, unknown>

function parseRow(operation: string, data: unknown): RpcRow {
  // The RPCs return one jsonb object; PostgREST may deliver it bare or as a
  // single-element array. Anything else is an unparseable response and is
  // treated as a transport failure (fail closed).
  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object') {
    throw new NoliCoreLedgerTransportError(operation, 'unparseable RPC response')
  }
  return row as RpcRow
}

function parseStatus(operation: string, row: RpcRow): GtmLedgerStatus {
  const status = row.status
  if (typeof status !== 'string' || status.length === 0) {
    throw new NoliCoreLedgerTransportError(operation, 'RPC response missing status')
  }
  return status as GtmLedgerStatus
}

export class NoliCoreRpcLedger implements GtmCreditLedger {
  protected clientFactory: () => Promise<NoliCoreRpcClient>

  constructor(client?: NoliCoreRpcClient | (() => Promise<NoliCoreRpcClient>)) {
    if (typeof client === 'function') {
      this.clientFactory = client
    } else if (client) {
      this.clientFactory = async () => client
    } else {
      // Lazy dynamic import: core-client is a server-only module and must not
      // load at construction time (or in tests, which always inject a mock).
      this.clientFactory = async () => {
        const { getNoliCoreClient } = await import('@open-mercato/shared/lib/noli/core-client')
        return getNoliCoreClient() as unknown as NoliCoreRpcClient
      }
    }
  }

  protected async rpc(operation: string, fn: string, args: Record<string, unknown>): Promise<RpcRow> {
    let data: unknown
    let error: { message?: string } | null
    try {
      const client = await this.clientFactory()
      ;({ data, error } = await client.rpc(fn, args))
    } catch (err) {
      // Transport failure (network, DNS, client construction): never a typed
      // ledger outcome - throw and let the caller fail closed / park.
      const message = err instanceof Error ? err.message : String(err)
      throw new NoliCoreLedgerTransportError(operation, message)
    }
    if (error) {
      const typed = mapRpcErrorToLedgerError(error.message)
      if (typed) throw typed
      throw new NoliCoreLedgerTransportError(operation, error.message || 'unknown RPC error')
    }
    return parseRow(operation, data)
  }

  // FAIL CLOSED: any transport or unknown error here throws; the caller must
  // never invoke a provider adapter without a confirmed reservation.
  async reserve(input: GtmReserveInput): Promise<GtmReserveResult> {
    const row = await this.rpc('reserve', 'provider_op_reserve', {
      p_org: input.orgId,
      p_user: input.userId,
      p_app: 'crm',
      p_kind: input.kind,
      p_provider: input.provider,
      p_estimated_credits: input.estimatedCredits,
      p_idempotency_key: input.idempotencyKey,
      p_unit_cost: input.unitCostSnapshot ?? null,
      p_fingerprint: input.fingerprint ?? null,
    })
    const operationId = row.operation_id
    if (typeof operationId !== 'string' || operationId.length === 0) {
      throw new NoliCoreLedgerTransportError('reserve', 'RPC response missing operation_id')
    }
    return { operationId, status: parseStatus('reserve', row) }
  }

  async start(operationId: string): Promise<GtmStartResult> {
    const row = await this.rpc('start', 'provider_op_start', {
      p_operation_id: operationId,
    })
    if (typeof row.started_now !== 'boolean') {
      throw new NoliCoreLedgerTransportError('start', 'RPC response missing started_now')
    }
    return { status: parseStatus('start', row), startedNow: row.started_now }
  }

  // A transport error here does NOT mean the settle failed on the noli-core
  // side - it means the outcome is unknown. Throw without touching any local
  // state; the caller parks the operation and later replays settle with the
  // SAME operation id (exactly-once on the canonical ledger).
  async settle(
    operationId: string,
    outcome: GtmSettleOutcome,
    chargedCredits: number,
    receipt: Record<string, unknown> | null,
  ): Promise<GtmLedgerStatus> {
    const row = await this.rpc('settle', 'provider_op_settle', {
      p_operation_id: operationId,
      p_outcome: outcome,
      p_charged_credits: chargedCredits,
      p_receipt: receipt ?? null,
    })
    return parseStatus('settle', row)
  }

  // Same parking rule as settle: on a transport error the operation stays
  // exactly as it was; retry markAmbiguous later with the SAME operation id.
  async markAmbiguous(
    operationId: string,
    detail: Record<string, unknown> | null,
  ): Promise<GtmLedgerStatus> {
    const row = await this.rpc('markAmbiguous', 'provider_op_mark_ambiguous', {
      p_operation_id: operationId,
      p_detail: detail ?? null,
    })
    return parseStatus('markAmbiguous', row)
  }

  async release(operationId: string): Promise<GtmLedgerStatus> {
    const row = await this.rpc('release', 'provider_op_release', {
      p_operation_id: operationId,
    })
    return parseStatus('release', row)
  }
}

export class NoliCoreOperatorReconciler
  extends NoliCoreRpcLedger
  implements GtmCanonicalOperatorReconciler
{
  async reconcile(
    request: GtmCanonicalOperatorReconciliationRequest,
  ): Promise<GtmCanonicalOperatorReconciliationResult> {
    const row = await this.rpc('operatorReconcile', 'provider_op_reconcile', {
      p_org: request.organizationId,
      p_actor: request.actorUserId,
      p_operation_id: request.operationId,
      p_previous_status: request.previousStatus,
      p_outcome: request.outcome,
      p_charged_credits: request.chargedCredits,
      p_receipt: request.receipt,
      p_binding: request.binding,
    })
    const operationId = row.operation_id
    if (typeof operationId !== 'string' || operationId.length === 0) {
      throw new NoliCoreLedgerTransportError(
        'operatorReconcile',
        'RPC response missing operation_id',
      )
    }
    const chargedCredits = row.charged_credits
    if (!Number.isSafeInteger(chargedCredits) || (chargedCredits as number) < 0) {
      throw new NoliCoreLedgerTransportError(
        'operatorReconcile',
        'RPC response missing charged_credits',
      )
    }
    const rawBinding = row.binding
    let binding: GtmCanonicalOperatorReconciliationResult['binding'] = null
    if (rawBinding != null) {
      if (!rawBinding || typeof rawBinding !== 'object' || Array.isArray(rawBinding)) {
        throw new NoliCoreLedgerTransportError(
          'operatorReconcile',
          'RPC response has invalid binding',
        )
      }
      const value = rawBinding as Record<string, unknown>
      for (const key of [
        'schemaVersion',
        'idempotencyKey',
        'auditEventId',
        'evidenceHash',
        'decisionHash',
        'decidedAt',
      ]) {
        if (typeof value[key] !== 'string' || value[key] === '') {
          throw new NoliCoreLedgerTransportError(
            'operatorReconcile',
            `RPC response has invalid binding.${key}`,
          )
        }
      }
      binding = value as unknown as GtmCanonicalOperatorReconciliationResult['binding']
    }
    return {
      operationId,
      status: parseStatus('operatorReconcile', row),
      chargedCredits: chargedCredits as number,
      binding,
    }
  }
}

/*
 * Ledger selection (Tranche 4 seam): tests always use the process fixture.
 * Local development may opt into it explicitly with GTM_LEDGER=fixture.
 * A production-mode build can use fixture credits only in the explicit
 * ephemeral OM_TEST_MODE harness with fixture adapters enabled. Every normal
 * non-test environment without noli-core credentials fails closed before
 * provider spend.
 */
export function getLedger(): GtmCreditLedger {
  const forced = (process.env.GTM_LEDGER ?? '').trim().toLowerCase()
  if (process.env.NODE_ENV === 'test') return getProcessFixtureLedger()

  if (forced === 'fixture') {
    if (
      process.env.NODE_ENV === 'production'
      && !(
        process.env.OM_TEST_MODE === '1'
        && process.env.GTM_FIXTURE_ADAPTERS_ENABLED === 'true'
      )
    ) {
      throw new NoliCoreLedgerConfigurationError('GTM_LEDGER=fixture is forbidden in production')
    }
    return getProcessFixtureLedger()
  }
  if (forced && forced !== 'noli-core' && forced !== 'rpc') {
    throw new NoliCoreLedgerConfigurationError(`unsupported GTM_LEDGER value: ${forced}`)
  }

  const noliCoreConfigured = Boolean(
    process.env.NOLI_CORE_SUPABASE_URL && process.env.NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY,
  )
  if (!noliCoreConfigured) {
    throw new NoliCoreLedgerConfigurationError(
      'NOLI_CORE_SUPABASE_URL and NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY are required',
    )
  }
  return new NoliCoreRpcLedger()
}

export { FixtureLedger }
