import {
  FixtureLedger,
  GtmCreditLedgerError,
  deterministicOperationId,
  type GtmReserveInput,
} from '../credits/ledger'
import {
  CREDITS_PER_USD,
  PROVIDER_MIN_CHARGE_USD,
  creditsForUnits,
  creditsFromUsd,
  MIN_CREDIT_MARKUP,
  defaultMarkupMultiplier,
  providerSpendCapUsd,
  usdFromCredits,
} from '../credits/markup'
import { APIFY_MIN_CHARGE_USD } from '../adapters/apify/client'

const ORG = 'org-11111111'
const USER = 'user-22222222'

function reserveInput(overrides?: Partial<GtmReserveInput>): GtmReserveInput {
  return {
    orgId: ORG,
    userId: USER,
    kind: 'source_search',
    provider: 'fixture-source',
    estimatedCredits: 10,
    idempotencyKey: 'run-1:fixture-source:1',
    unitCostSnapshot: { unit: 'candidate', quoted_credits_per_unit: 1, markup_multiplier: 2 },
    fingerprint: { research_run_id: 'run-1' },
    ...overrides,
  }
}

describe('creditsForUnits markup', () => {
  const originalMarkup = process.env.GTM_CREDIT_MARKUP

  afterEach(() => {
    if (originalMarkup === undefined) delete process.env.GTM_CREDIT_MARKUP
    else process.env.GTM_CREDIT_MARKUP = originalMarkup
  })

  it('applies the default 2x markup with integer ceil', () => {
    delete process.env.GTM_CREDIT_MARKUP
    expect(creditsForUnits(25, 1)).toBe(50)
    expect(creditsForUnits(3, 1.1)).toBe(7) // 3 * 1.1 * 2 = 6.6 -> 7
  })

  it('never returns zero credits for a nonzero unit count', () => {
    expect(creditsForUnits(1, 0.01, 2)).toBe(1)
    expect(creditsForUnits(0, 5, 2)).toBe(0)
  })

  it('reads the markup from GTM_CREDIT_MARKUP with a 2 fallback', () => {
    process.env.GTM_CREDIT_MARKUP = '3'
    expect(defaultMarkupMultiplier()).toBe(3)
    expect(creditsForUnits(2, 1)).toBe(6)
    process.env.GTM_CREDIT_MARKUP = 'not-a-number'
    expect(defaultMarkupMultiplier()).toBe(2)
    delete process.env.GTM_CREDIT_MARKUP
    expect(defaultMarkupMultiplier()).toBe(2)
  })

  // Review 2026-09-02 (L5): a sub-1 markup priced quotes under provider cost
  // and let providerSpendCapUsd authorize more than the reservation.
  it('refuses a markup below 1x and falls back to the default', () => {
    for (const value of ['0.5', '0.99', '0', '-2']) {
      process.env.GTM_CREDIT_MARKUP = value
      expect(defaultMarkupMultiplier()).toBe(2)
    }
    process.env.GTM_CREDIT_MARKUP = '1'
    expect(defaultMarkupMultiplier()).toBe(1)
    expect(MIN_CREDIT_MARKUP).toBe(1)
  })

  it('rejects invalid inputs instead of silently pricing them', () => {
    expect(() => creditsForUnits(-1, 1, 2)).toThrow(TypeError)
    expect(() => creditsForUnits(1, -1, 2)).toThrow(TypeError)
    expect(() => creditsForUnits(1, 1, 0)).toThrow(TypeError)
  })
})

// ---------------------------------------------------------------------------
// Reservation -> provider spend cap (the metering-safety link)
// ---------------------------------------------------------------------------

describe('usdFromCredits', () => {
  it('is the exact inverse of creditsFromUsd on the same basis', () => {
    expect(CREDITS_PER_USD).toBe(250_000)
    expect(usdFromCredits(250_000)).toBe(1)
    expect(usdFromCredits(2_500)).toBe(0.01)
    expect(usdFromCredits(0)).toBe(0)
    for (const usd of [0.003, 0.004, 0.01, 0.075, 0.25, 1.5]) {
      expect(usdFromCredits(creditsFromUsd(usd))).toBeCloseTo(usd, 10)
    }
  })

  it('rejects invalid inputs instead of silently producing a cap', () => {
    expect(() => usdFromCredits(-1)).toThrow(TypeError)
    expect(() => usdFromCredits(Number.NaN)).toThrow(TypeError)
  })
})

describe('providerSpendCapUsd', () => {
  it('turns a 25-result sourcing reservation into exactly the raw provider cost', () => {
    // 25 results x $0.003 = 750 credits each, pre-markup.
    const quoted = creditsFromUsd(0.003)
    expect(quoted).toBe(750)
    const reserved = creditsForUnits(25, quoted, 2)
    // the customer is reserved 37,500 credits ($0.15 at 2x markup)
    expect(reserved).toBe(37_500)
    // but the PROVIDER is only ever authorized the raw $0.075
    expect(providerSpendCapUsd(reserved, 2)).toBe(0.075)
    expect(providerSpendCapUsd(reserved, 2)).toBeCloseTo(25 * 0.003, 10)
  })

  it('divides the markup back out rather than authorizing the marked-up figure', () => {
    const reserved = creditsForUnits(25, 750, 2)
    // the naive (wrong) conversion would authorize double the real cost
    expect(usdFromCredits(reserved)).toBe(0.15)
    expect(providerSpendCapUsd(reserved, 2)).toBe(0.075)
    // and it tracks whatever markup the caller actually reserved at
    expect(providerSpendCapUsd(creditsForUnits(25, 750, 3), 3)).toBe(0.075)
    expect(providerSpendCapUsd(creditsForUnits(25, 750, 1), 1)).toBe(0.075)
  })

  it('floors tiny reservations at the provider minimum, which a sub-minimum cap would 400 on', () => {
    // the fixture enrich reserve (1 unit x 2 quoted x 2 markup = 4 credits) is
    // $0.000008 of provider spend: far under the $0.01 Apify floor
    expect(usdFromCredits(4 / 2)).toBeCloseTo(0.000008, 10)
    expect(providerSpendCapUsd(4, 2)).toBe(PROVIDER_MIN_CHARGE_USD)
    expect(providerSpendCapUsd(0, 2)).toBe(PROVIDER_MIN_CHARGE_USD)
    expect(providerSpendCapUsd(1, 2)).toBe(PROVIDER_MIN_CHARGE_USD)
    // one Apify profile-with-email reserve (2,500 quoted x 2) sits exactly on
    // the raw $0.01 cost, which is also the floor
    expect(providerSpendCapUsd(creditsForUnits(1, 2_500, 2), 2)).toBe(0.01)
  })

  it('keeps the floor in parity with the Apify client minimum', () => {
    // markup.ts stays pure and owns its own copy of the floor; this assertion
    // is what stops the two drifting apart.
    expect(PROVIDER_MIN_CHARGE_USD).toBe(APIFY_MIN_CHARGE_USD)
  })

  it('rejects invalid inputs instead of silently producing a cap', () => {
    expect(() => providerSpendCapUsd(-1, 2)).toThrow(TypeError)
    expect(() => providerSpendCapUsd(100, 0)).toThrow(TypeError)
    expect(() => providerSpendCapUsd(100, Number.NaN)).toThrow(TypeError)
  })

  // Review 2026-09-02 (L3): documents the bounded gap between a sub-cent
  // reservation and the $0.01 floor actually sent to the provider.
  it('documents that the $0.01 floor can exceed a sub-cent reservation by under one cent', () => {
    // 3 comments x 500 credits x 2 markup = 3,000 credits = $0.006 raw
    const reserved = creditsForUnits(3, 500, 2)
    expect(usdFromCredits(reserved / 2)).toBeCloseTo(0.006, 10)
    const cap = providerSpendCapUsd(reserved, 2)
    expect(cap).toBe(PROVIDER_MIN_CHARGE_USD)
    expect(cap - usdFromCredits(reserved / 2)).toBeLessThan(PROVIDER_MIN_CHARGE_USD)
    // once the raw reservation covers the floor, the cap tracks it exactly
    expect(providerSpendCapUsd(creditsForUnits(5, 500, 2), 2)).toBe(0.01)
    expect(providerSpendCapUsd(creditsForUnits(6, 500, 2), 2)).toBe(0.012)
  })

  it('defaults the markup to the configured platform multiplier', () => {
    const saved = process.env.GTM_CREDIT_MARKUP
    process.env.GTM_CREDIT_MARKUP = '2'
    try {
      expect(defaultMarkupMultiplier()).toBe(2)
      expect(providerSpendCapUsd(37_500)).toBe(0.075)
    } finally {
      if (saved === undefined) delete process.env.GTM_CREDIT_MARKUP
      else process.env.GTM_CREDIT_MARKUP = saved
    }
  })
})

describe('FixtureLedger reserve', () => {
  it('creates deterministic operation ids from org + idempotency key', async () => {
    const a = new FixtureLedger()
    const b = new FixtureLedger()
    const first = await a.reserve(reserveInput())
    const second = await b.reserve(reserveInput())
    expect(first.operationId).toBe(second.operationId)
    expect(first.operationId).toBe(deterministicOperationId(ORG, 'run-1:fixture-source:1'))
    expect(first.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('is idempotent: the same key returns the same operation without a second reservation', async () => {
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const first = await ledger.reserve(reserveInput())
    const repeat = await ledger.reserve(reserveInput({ estimatedCredits: 99 }))
    expect(repeat.operationId).toBe(first.operationId)
    expect(ledger.listOperations()).toHaveLength(1)
    expect(ledger.availableCredits()).toBe(90)
  })

  it('returns the CURRENT status on a repeat reserve after progress', async () => {
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const { operationId } = await ledger.reserve(reserveInput())
    await ledger.start(operationId)
    await ledger.settle(operationId, 'charged', 10, { receipt: true })
    const repeat = await ledger.reserve(reserveInput())
    expect(repeat.status).toBe('charged')
  })

  it('handles concurrent duplicate reserves as one operation', async () => {
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const [a, b] = await Promise.all([ledger.reserve(reserveInput()), ledger.reserve(reserveInput())])
    expect(a.operationId).toBe(b.operationId)
    expect(ledger.listOperations()).toHaveLength(1)
    expect(ledger.availableCredits()).toBe(90)
  })

  it('fails closed on insufficient credits', async () => {
    const ledger = new FixtureLedger({ poolBalance: 5 })
    await expect(ledger.reserve(reserveInput({ estimatedCredits: 10 }))).rejects.toMatchObject({
      code: 'insufficient_credits',
    })
    expect(ledger.listOperations()).toHaveLength(0)
  })

  it('counts outstanding reservations against headroom', async () => {
    const ledger = new FixtureLedger({ poolBalance: 15 })
    await ledger.reserve(reserveInput({ estimatedCredits: 10 }))
    await expect(
      ledger.reserve(reserveInput({ idempotencyKey: 'run-1:fixture-source:2', estimatedCredits: 10 })),
    ).rejects.toMatchObject({ code: 'insufficient_credits' })
  })

  it('rejects unbounded or zero-value reservations', async () => {
    const ledger = new FixtureLedger()
    await expect(ledger.reserve(reserveInput({ estimatedCredits: 0 }))).rejects.toMatchObject({
      code: 'invalid_reserve',
    })
    await expect(ledger.reserve(reserveInput({ estimatedCredits: 2.5 }))).rejects.toMatchObject({
      code: 'invalid_reserve',
    })
  })
})

describe('FixtureLedger transitions and settlement', () => {
  it('settles exactly once: a double settle returns the settled state unchanged', async () => {
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const { operationId } = await ledger.reserve(reserveInput())
    await ledger.start(operationId)
    const first = await ledger.settle(operationId, 'charged', 8, { attempt: 1 })
    expect(first).toBe('charged')
    const second = await ledger.settle(operationId, 'refunded', 0, { attempt: 2 })
    expect(second).toBe('charged')
    const op = ledger.getOperation(operationId)!
    expect(op.chargedCredits).toBe(8)
    expect(op.receipt).toEqual({ attempt: 1 })
    // pool reflects the single charge, not the reservation
    expect(ledger.availableCredits()).toBe(92)
  })

  it('start is legal only from reserved (idempotent from provider_started)', async () => {
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const { operationId } = await ledger.reserve(reserveInput())
    expect(await ledger.start(operationId)).toEqual({ status: 'provider_started', startedNow: true })
    expect(await ledger.start(operationId)).toEqual({ status: 'provider_started', startedNow: false })
    await ledger.settle(operationId, 'charged', 5, null)
    await expect(ledger.start(operationId)).rejects.toMatchObject({ code: 'illegal_transition' })
  })

  it('settle from reserved is legal only as a pre-start refund abort', async () => {
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const { operationId } = await ledger.reserve(reserveInput())
    await expect(ledger.settle(operationId, 'charged', 5, null)).rejects.toMatchObject({
      code: 'illegal_transition',
    })
    expect(await ledger.settle(operationId, 'refunded', 0, null)).toBe('refunded')
  })

  it('markAmbiguous is legal only from provider_started and parks the reservation', async () => {
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const { operationId } = await ledger.reserve(reserveInput())
    await expect(ledger.markAmbiguous(operationId, null)).rejects.toMatchObject({
      code: 'illegal_transition',
    })
    await ledger.start(operationId)
    expect(await ledger.markAmbiguous(operationId, { reason: 'timeout' })).toBe(
      'reconciliation_required',
    )
    // idempotent repeat keeps the parked state
    expect(await ledger.markAmbiguous(operationId, null)).toBe('reconciliation_required')
    // the reservation stays escrowed while parked
    expect(ledger.availableCredits()).toBe(90)
  })

  it('enforces chargedCredits <= reservedCredits and refund = 0', async () => {
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const { operationId } = await ledger.reserve(reserveInput())
    await ledger.start(operationId)
    await expect(ledger.settle(operationId, 'charged', 11, null)).rejects.toMatchObject({
      code: 'invalid_settle',
    })
    await expect(ledger.settle(operationId, 'refunded', 3, null)).rejects.toMatchObject({
      code: 'invalid_settle',
    })
  })

  it('release is legal only before provider contact', async () => {
    const ledger = new FixtureLedger({ poolBalance: 100 })
    const { operationId } = await ledger.reserve(reserveInput())
    expect(await ledger.release(operationId)).toBe('released')
    expect(await ledger.release(operationId)).toBe('released')
    const other = await ledger.reserve(reserveInput({ idempotencyKey: 'run-1:fixture-source:2' }))
    await ledger.start(other.operationId)
    await expect(ledger.release(other.operationId)).rejects.toMatchObject({
      code: 'illegal_transition',
    })
  })

  it('throws unknown_operation for unknown ids', async () => {
    const ledger = new FixtureLedger()
    await expect(ledger.start('nope')).rejects.toMatchObject({ code: 'unknown_operation' })
    await expect(ledger.settle('nope', 'charged', 1, null)).rejects.toBeInstanceOf(
      GtmCreditLedgerError,
    )
  })
})
