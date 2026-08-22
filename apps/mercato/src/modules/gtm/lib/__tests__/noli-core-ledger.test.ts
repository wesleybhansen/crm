import { FixtureLedger, GtmCreditLedgerError } from '../credits/ledger'
import {
  NoliCoreLedgerTransportError,
  NoliCoreLedgerConfigurationError,
  NoliCoreOperatorReconciler,
  NoliCoreRpcLedger,
  getLedger,
  mapRpcErrorToLedgerError,
  type NoliCoreRpcClient,
} from '../credits/noli-core-ledger'

const ORG = '11111111-1111-4111-8111-111111111111'
const USER = '55555555-5555-4555-8555-555555555555'
const OP = '99999999-9999-4999-8999-999999999999'

type RpcResponse = { data: unknown; error: { message?: string } | null }

function client(rpc: jest.Mock): NoliCoreRpcClient & { rpc: jest.Mock } {
  return { rpc }
}

function ok(data: unknown): RpcResponse {
  return { data, error: null }
}

function sqlError(message: string): RpcResponse {
  return { data: null, error: { message } }
}

const reserveInput = {
  orgId: ORG,
  userId: USER,
  kind: 'contact_enrich',
  provider: 'fixture-enrich',
  estimatedCredits: 4,
  idempotencyKey: 'enrich:cand-1:fixture-enrich',
  unitCostSnapshot: { unit: 'contact_point', quoted_credits_per_unit: 2 },
  fingerprint: { candidate_id: 'cand-1' },
}

describe('NoliCoreOperatorReconciler', () => {
  it('calls the binding-aware canonical reconciliation RPC and validates the exact echo', async () => {
    const binding = {
      schemaVersion: 'gtm.operator_reconciliation.v2' as const,
      idempotencyKey: 'operator-1',
      auditEventId: 'aaaaaaaa-1111-4111-8111-111111111111',
      evidenceHash: 'a'.repeat(64),
      decisionHash: 'b'.repeat(64),
      decidedAt: '2026-08-18T05:30:00.000Z',
    }
    const rpc = jest.fn().mockResolvedValue(
      ok({ operation_id: OP, status: 'charged', charged_credits: 4, binding }),
    )
    const reconciler = new NoliCoreOperatorReconciler(client(rpc))
    await expect(
      reconciler.reconcile({
        organizationId: ORG,
        actorUserId: USER,
        billingUserId: USER,
        operationId: OP,
        previousStatus: 'reconciliation_required',
        outcome: 'charged',
        chargedCredits: 4,
        receipt: { operator_reconciliation: { decision_hash: binding.decisionHash } },
        binding,
      }),
    ).resolves.toEqual({ operationId: OP, status: 'charged', chargedCredits: 4, binding })
    expect(rpc).toHaveBeenCalledWith('provider_op_reconcile', {
      p_org: ORG,
      p_actor: USER,
      p_billing_user: USER,
      p_operation_id: OP,
      p_previous_status: 'reconciliation_required',
      p_outcome: 'charged',
      p_charged_credits: 4,
      p_receipt: { operator_reconciliation: { decision_hash: binding.decisionHash } },
      p_binding: binding,
    })
  })

  it('preserves null binding so the service can reject a same-status foreign decision', async () => {
    const rpc = jest.fn().mockResolvedValue(
      ok({ operation_id: OP, status: 'charged', charged_credits: 4, binding: null }),
    )
    const reconciler = new NoliCoreOperatorReconciler(client(rpc))
    const result = await reconciler.reconcile({
      organizationId: ORG,
      actorUserId: USER,
      billingUserId: USER,
      operationId: OP,
      previousStatus: 'reconciliation_required',
      outcome: 'charged',
      chargedCredits: 4,
      receipt: {},
      binding: {
        schemaVersion: 'gtm.operator_reconciliation.v2',
        idempotencyKey: 'operator-2',
        auditEventId: 'aaaaaaaa-1111-4111-8111-111111111112',
        evidenceHash: 'c'.repeat(64),
        decisionHash: 'd'.repeat(64),
        decidedAt: '2026-08-18T05:31:00.000Z',
      },
    })
    expect(result.binding).toBeNull()
  })

  it('rejects a canonical echo that omits the decision timestamp', async () => {
    const rpc = jest.fn().mockResolvedValue(
      ok({
        operation_id: OP,
        status: 'charged',
        charged_credits: 4,
        binding: {
          schemaVersion: 'gtm.operator_reconciliation.v2',
          idempotencyKey: 'operator-3',
          auditEventId: 'aaaaaaaa-1111-4111-8111-111111111113',
          evidenceHash: 'e'.repeat(64),
          decisionHash: 'f'.repeat(64),
        },
      }),
    )
    const reconciler = new NoliCoreOperatorReconciler(client(rpc))
    await expect(
      reconciler.reconcile({
        organizationId: ORG,
        actorUserId: USER,
        billingUserId: USER,
        operationId: OP,
        previousStatus: 'reconciliation_required',
        outcome: 'charged',
        chargedCredits: 4,
        receipt: {},
        binding: {
          schemaVersion: 'gtm.operator_reconciliation.v2',
          idempotencyKey: 'operator-3',
          auditEventId: 'aaaaaaaa-1111-4111-8111-111111111113',
          evidenceHash: 'e'.repeat(64),
          decisionHash: 'f'.repeat(64),
          decidedAt: '2026-08-18T05:32:00.000Z',
        },
      }),
    ).rejects.toBeInstanceOf(NoliCoreLedgerTransportError)
  })
})

describe('NoliCoreRpcLedger', () => {
  it('maps reserve onto provider_op_reserve with the exact frozen arguments and p_app crm', async () => {
    const rpc = jest
      .fn()
      .mockResolvedValue(ok({ operation_id: OP, status: 'reserved', reserved_credits: 4 }))
    const ledger = new NoliCoreRpcLedger(client(rpc))

    const result = await ledger.reserve(reserveInput)

    expect(result).toEqual({ operationId: OP, status: 'reserved' })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('provider_op_reserve', {
      p_org: ORG,
      p_user: USER,
      p_app: 'crm',
      p_kind: 'contact_enrich',
      p_provider: 'fixture-enrich',
      p_estimated_credits: 4,
      p_idempotency_key: 'enrich:cand-1:fixture-enrich',
      p_unit_cost: { unit: 'contact_point', quoted_credits_per_unit: 2 },
      p_fingerprint: { candidate_id: 'cand-1' },
    })
  })

  it('maps start, settle, markAmbiguous, and release onto their RPCs', async () => {
    const rpc = jest.fn()
    const ledger = new NoliCoreRpcLedger(client(rpc))

    rpc.mockResolvedValueOnce(ok({ operation_id: OP, status: 'provider_started', started_now: true }))
    expect(await ledger.start(OP)).toEqual({ status: 'provider_started', startedNow: true })
    expect(rpc).toHaveBeenLastCalledWith('provider_op_start', { p_operation_id: OP })

    rpc.mockResolvedValueOnce(ok({ operation_id: OP, status: 'charged', charged_credits: 3 }))
    expect(await ledger.settle(OP, 'charged', 3, { provider_request_id: 'req-1' })).toBe('charged')
    expect(rpc).toHaveBeenLastCalledWith('provider_op_settle', {
      p_operation_id: OP,
      p_outcome: 'charged',
      p_charged_credits: 3,
      p_receipt: { provider_request_id: 'req-1' },
    })

    rpc.mockResolvedValueOnce(ok({ operation_id: OP, status: 'reconciliation_required' }))
    expect(await ledger.markAmbiguous(OP, { error: 'timeout' })).toBe('reconciliation_required')
    expect(rpc).toHaveBeenLastCalledWith('provider_op_mark_ambiguous', {
      p_operation_id: OP,
      p_detail: { error: 'timeout' },
    })

    rpc.mockResolvedValueOnce(ok({ operation_id: OP, status: 'released' }))
    expect(await ledger.release(OP)).toBe('released')
    expect(rpc).toHaveBeenLastCalledWith('provider_op_release', { p_operation_id: OP })
  })

  it('requires and preserves the canonical start ownership bit', async () => {
    const rpc = jest.fn()
      .mockResolvedValueOnce(ok({ operation_id: OP, status: 'provider_started', started_now: false }))
      .mockResolvedValueOnce(ok({ operation_id: OP, status: 'provider_started' }))
    const ledger = new NoliCoreRpcLedger(client(rpc))

    await expect(ledger.start(OP)).resolves.toEqual({
      status: 'provider_started',
      startedNow: false,
    })
    await expect(ledger.start(OP)).rejects.toBeInstanceOf(NoliCoreLedgerTransportError)
  })

  it('accepts a single-row array response (PostgREST set-returning shape)', async () => {
    const rpc = jest
      .fn()
      .mockResolvedValue(ok([{ operation_id: OP, status: 'reserved', reserved_credits: 4 }]))
    const ledger = new NoliCoreRpcLedger(client(rpc))
    expect(await ledger.reserve(reserveInput)).toEqual({ operationId: OP, status: 'reserved' })
  })

  it('maps the insufficient_credits SQL exception onto the typed ledger error', async () => {
    const rpc = jest.fn().mockResolvedValue(sqlError('insufficient_credits: need 4, available 1'))
    const ledger = new NoliCoreRpcLedger(client(rpc))

    const err = await ledger.reserve(reserveInput).catch((e) => e)
    expect(err).toBeInstanceOf(GtmCreditLedgerError)
    expect((err as GtmCreditLedgerError).code).toBe('insufficient_credits')
  })

  it('maps invalid_estimate and unbounded_operation onto invalid_reserve', async () => {
    expect(mapRpcErrorToLedgerError('invalid_estimate: must be positive')?.code).toBe(
      'invalid_reserve',
    )
    expect(mapRpcErrorToLedgerError('unbounded_operation: estimate required')?.code).toBe(
      'invalid_reserve',
    )
    expect(mapRpcErrorToLedgerError('illegal_transition: settle from released')?.code).toBe(
      'illegal_transition',
    )
    expect(mapRpcErrorToLedgerError('something else entirely')).toBeNull()
    expect(mapRpcErrorToLedgerError(undefined)).toBeNull()
  })

  it('FAILS CLOSED on a reserve transport error: throws, never returns a reservation', async () => {
    const rpc = jest.fn().mockRejectedValue(new Error('fetch failed: ECONNREFUSED'))
    const ledger = new NoliCoreRpcLedger(client(rpc))

    const err = await ledger.reserve(reserveInput).catch((e) => e)
    expect(err).toBeInstanceOf(NoliCoreLedgerTransportError)
    expect((err as NoliCoreLedgerTransportError).operation).toBe('reserve')
  })

  it('FAILS CLOSED on an unrecognized reserve RPC error message', async () => {
    const rpc = jest.fn().mockResolvedValue(sqlError('connection reset by peer'))
    const ledger = new NoliCoreRpcLedger(client(rpc))
    await expect(ledger.reserve(reserveInput)).rejects.toBeInstanceOf(NoliCoreLedgerTransportError)
  })

  it('FAILS CLOSED on an unparseable reserve response (no operation_id)', async () => {
    const rpc = jest.fn().mockResolvedValue(ok({ status: 'reserved' }))
    const ledger = new NoliCoreRpcLedger(client(rpc))
    await expect(ledger.reserve(reserveInput)).rejects.toBeInstanceOf(NoliCoreLedgerTransportError)
  })

  it('settle transport error throws WITHOUT inventing state; the SAME operation id retries later', async () => {
    const rpc = jest.fn().mockRejectedValueOnce(new Error('gateway timeout'))
    const ledger = new NoliCoreRpcLedger(client(rpc))

    const err = await ledger.settle(OP, 'charged', 3, null).catch((e) => e)
    expect(err).toBeInstanceOf(NoliCoreLedgerTransportError)
    expect((err as NoliCoreLedgerTransportError).operation).toBe('settle')

    // The caller parks and retries the SAME operation id; the ledger client
    // replays the identical RPC (exactly-once lands on the noli-core side).
    rpc.mockResolvedValueOnce(ok({ operation_id: OP, status: 'charged', charged_credits: 3 }))
    expect(await ledger.settle(OP, 'charged', 3, null)).toBe('charged')
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1])
  })

  it('markAmbiguous transport error throws without inventing state', async () => {
    const rpc = jest.fn().mockRejectedValue(new Error('socket hang up'))
    const ledger = new NoliCoreRpcLedger(client(rpc))
    await expect(ledger.markAmbiguous(OP, null)).rejects.toBeInstanceOf(
      NoliCoreLedgerTransportError,
    )
  })
})

describe('getLedger selection', () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env.NODE_ENV = saved.NODE_ENV
    process.env.GTM_LEDGER = saved.GTM_LEDGER
    process.env.OM_TEST_MODE = saved.OM_TEST_MODE
    process.env.GTM_FIXTURE_ADAPTERS_ENABLED = saved.GTM_FIXTURE_ADAPTERS_ENABLED
    process.env.NOLI_CORE_SUPABASE_URL = saved.NOLI_CORE_SUPABASE_URL
    process.env.NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY = saved.NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY
    for (const key of [
      'GTM_LEDGER',
      'OM_TEST_MODE',
      'GTM_FIXTURE_ADAPTERS_ENABLED',
      'NOLI_CORE_SUPABASE_URL',
      'NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY',
    ]) {
      if (saved[key] === undefined) delete process.env[key]
    }
  })

  it('returns the fixture ledger under NODE_ENV=test', () => {
    expect(getLedger()).toBeInstanceOf(FixtureLedger)
  })

  it('fails closed when noli-core env is unset outside tests', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.NOLI_CORE_SUPABASE_URL
    delete process.env.NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY
    expect(() => getLedger()).toThrow(NoliCoreLedgerConfigurationError)
  })

  it('forbids fixture credits in normal production even when explicitly requested', () => {
    process.env.NODE_ENV = 'production'
    process.env.GTM_LEDGER = 'fixture'
    delete process.env.OM_TEST_MODE
    delete process.env.GTM_FIXTURE_ADAPTERS_ENABLED
    process.env.NOLI_CORE_SUPABASE_URL = 'https://example.supabase.co'
    process.env.NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    expect(() => getLedger()).toThrow(NoliCoreLedgerConfigurationError)
  })

  it('allows fixture credits only inside the explicit production-mode ephemeral harness', () => {
    process.env.NODE_ENV = 'production'
    process.env.GTM_LEDGER = 'fixture'
    process.env.OM_TEST_MODE = '1'
    process.env.GTM_FIXTURE_ADAPTERS_ENABLED = 'true'
    delete process.env.NOLI_CORE_SUPABASE_URL
    delete process.env.NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY

    expect(getLedger()).toBeInstanceOf(FixtureLedger)
  })

  it('allows an explicit fixture ledger in local development', () => {
    process.env.NODE_ENV = 'development'
    process.env.GTM_LEDGER = 'fixture'
    delete process.env.NOLI_CORE_SUPABASE_URL
    delete process.env.NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY
    expect(getLedger()).toBeInstanceOf(FixtureLedger)
  })

  it('returns the RPC ledger only in a fully configured non-test environment', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.GTM_LEDGER
    process.env.NOLI_CORE_SUPABASE_URL = 'https://example.supabase.co'
    process.env.NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    expect(getLedger()).toBeInstanceOf(NoliCoreRpcLedger)
  })
})
