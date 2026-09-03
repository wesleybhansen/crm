import type { VerifyRequest } from '../adapters/types'
import {
  APIFY_EMAIL_VERIFY_ACTOR_ID,
  APIFY_EMAIL_VERIFY_ADAPTER_ID,
  APIFY_EMAIL_VERIFY_BILLED_UNITS,
  APIFY_EMAIL_VERIFY_BUILD,
  APIFY_EMAIL_VERIFY_EVENT_PRICES_USD,
  APIFY_EMAIL_VERIFY_PROVIDER_CAP_USD,
  APIFY_EMAIL_VERIFY_REQUIRED_PRICE_VERSION,
  APIFY_EMAIL_VERIFY_REQUIRED_TERMS_VERSION,
  APIFY_EMAIL_VERIFY_START_ONLY_UNITS,
  apifyEmailVerifierEnabled,
  createApifyEmailVerifierAdapter,
  type ApifyEmailVerifierRunActorFn,
} from '../adapters/apify/email-verifier'
import type {
  ApifyFetchInit,
  ApifyFetchLike,
  ApifyFetchResponse,
  ApifyRunOutcome,
} from '../adapters/apify/client'
import { APIFY_REQUIRED_PRICE_VERSION } from '../adapters/apify/source'
import { verifyAdapterList } from '../adapters/registry'
import { creditsFromUsd } from '../credits/markup'

const TOKEN = 'apify_test_token_never_log'
const EMAIL = 'alex@example.test'
const CLOCK = new Date('2026-08-23T12:00:00.000Z')
const now = () => CLOCK

const APPROVED_ENV = {
  GTM_APIFY_ENABLED: 'true',
  GTM_APIFY_ACCOUNT_TIER: 'BRONZE',
  GTM_APIFY_TOKEN: TOKEN,
  GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
  GTM_APIFY_TERMS_VERSION: APIFY_EMAIL_VERIFY_REQUIRED_TERMS_VERSION,
  GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
  GTM_APIFY_EMAIL_VERIFY_ENABLED: 'true',
  GTM_APIFY_EMAIL_VERIFY_PRICE_VERSION: APIFY_EMAIL_VERIFY_REQUIRED_PRICE_VERSION,
}

const REQUEST: VerifyRequest = {
  signal_kind: 'email_verification',
  entity_unit: 'contacts',
  geography: 'US',
  channel: 'email',
  value: EMAIL,
  max_charge_usd: APIFY_EMAIL_VERIFY_PROVIDER_CAP_USD,
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: EMAIL,
    isValidFormat: true,
    hasMxRecords: true,
    isVerified: true,
    isCatchAll: false,
    isDisposable: false,
    isFreeProvider: false,
    isRoleAccount: false,
    confidenceScore: 95,
    verificationMethod: 'smtp',
    provider: 'google_workspace',
    deliverabilityGrade: 'A+',
    ...overrides,
  }
}

const RUN_ID = 'apify-run-verify-1'
const DATASET_ID = 'apify-dataset-verify-1'

// A finalized run receipt: settlement is derived from these counts, never
// from the number of rows the actor happened to emit.
function finalizedOutcome(
  items: unknown[],
  chargedEventCounts: Record<string, number> = {
    start: 1,
    'email-verified': items.length > 0 ? 1 : 0,
  },
  overrides: Partial<ApifyRunOutcome> = {},
): ApifyRunOutcome {
  const providerCostUsd = Object.entries(chargedEventCounts).reduce(
    (sum, [event, count]) =>
      sum + count * (APIFY_EMAIL_VERIFY_EVENT_PRICES_USD[event as keyof typeof APIFY_EMAIL_VERIFY_EVENT_PRICES_USD] ?? 0),
    0,
  )
  return {
    kind: items.length > 0 ? 'ok' : 'no_result',
    status: items.length > 0 ? 'ok' : 'no_result',
    items,
    actorId: APIFY_EMAIL_VERIFY_ACTOR_ID,
    runId: RUN_ID,
    itemCount: items.length,
    httpStatus: 201,
    retryAfterSeconds: null,
    bodySnippet: null,
    requestUrl: 'https://api.apify.test/redacted',
    attemptedAt: CLOCK.toISOString(),
    error: null,
    billingFinalized: true,
    chargedEventCounts,
    providerCostUsd: Math.round(providerCostUsd * 1e6) / 1e6,
    pricingModel: 'PAY_PER_EVENT',
    ...overrides,
  }
}

function outcome(
  items: unknown[],
  overrides: Partial<ApifyRunOutcome> = {},
): ApifyRunOutcome {
  return finalizedOutcome(items, undefined, overrides)
}

function runRecord(chargedEventCounts: Record<string, number>, usageTotalUsd: number) {
  return {
    id: RUN_ID,
    status: 'SUCCEEDED',
    defaultDatasetId: DATASET_ID,
    chargedEventCounts,
    usageTotalUsd,
    pricingInfo: {
      pricingModel: 'PAY_PER_EVENT',
      pricingPerEvent: {
        actorChargeEvents: {
          start: { eventPriceUsd: APIFY_EMAIL_VERIFY_EVENT_PRICES_USD.start },
          'email-verified': { eventPriceUsd: APIFY_EMAIL_VERIFY_EVENT_PRICES_USD['email-verified'] },
        },
      },
    },
  }
}

function response(status: number, value: unknown): ApifyFetchResponse {
  return {
    status,
    headers: { get: () => null },
    text: async () => (typeof value === 'string' ? value : JSON.stringify(value)),
  }
}

function sequentialFetch(responses: ApifyFetchResponse[]) {
  const calls: { url: string; init: ApifyFetchInit }[] = []
  const fetchImpl: ApifyFetchLike = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error('unexpected fake request')
    return next
  }
  return { fetchImpl, calls }
}

function adapterWith(items: unknown[]) {
  const runActor = jest.fn(async () => outcome(items)) as jest.MockedFunction<ApifyEmailVerifierRunActorFn>
  return {
    adapter: createApifyEmailVerifierAdapter({ env: APPROVED_ENV, runActor, now }),
    runActor,
  }
}

describe('Apify email verification adapter', () => {
  it('stays absent until its capability-specific switch and exact price version are present', () => {
    expect(apifyEmailVerifierEnabled({
      ...APPROVED_ENV,
      GTM_APIFY_EMAIL_VERIFY_ENABLED: 'false',
    })).toBe(false)
    expect(apifyEmailVerifierEnabled({
      ...APPROVED_ENV,
      GTM_APIFY_EMAIL_VERIFY_PRICE_VERSION: 'stale',
    })).toBe(false)
    expect(apifyEmailVerifierEnabled(APPROVED_ENV)).toBe(true)
  })

  it('registers only the selected Apify verifier and never revives Bouncer', () => {
    const saved = { ...process.env }
    try {
      Object.assign(process.env, APPROVED_ENV, {
        GTM_BOUNCER_ENABLED: 'true',
        GTM_BOUNCER_API_KEY: 'ignored',
        GTM_BOUNCER_CUSTOMER_USE_APPROVED: 'true',
        GTM_BOUNCER_TERMS_VERSION: 'ignored',
        GTM_BOUNCER_PRICE_VERSION: 'ignored',
      })
      const ids = verifyAdapterList().map((adapter) => adapter.descriptor.adapter_id)
      expect(ids).toContain(APIFY_EMAIL_VERIFY_ADAPTER_ID)
      expect(ids).not.toContain('bouncer-email-verification')
    } finally {
      process.env = saved
    }
  })

  it('quotes the Apify minimum run cap while settling the observed start and per-row events', () => {
    const descriptor = createApifyEmailVerifierAdapter({
      env: APPROVED_ENV,
      runActor: jest.fn(),
      now,
    }).descriptor
    expect(descriptor.constraints.license).toEqual(expect.objectContaining({
      status: 'approved',
      terms_version: APIFY_EMAIL_VERIFY_REQUIRED_TERMS_VERSION,
    }))
    expect(descriptor.cost_model).toEqual(expect.objectContaining({
      unit: 'verification_run_cap',
      quoted_credits_per_unit: creditsFromUsd(0.01),
      price_version: APIFY_EMAIL_VERIFY_REQUIRED_PRICE_VERSION,
      pay_on_found: false,
    }))
    expect(APIFY_EMAIL_VERIFY_START_ONLY_UNITS).toBeCloseTo(0.1, 10)
    expect(APIFY_EMAIL_VERIFY_BILLED_UNITS).toBeCloseTo(0.37, 10)
  })

  it('drives the finalized-billing client: pins build, input, cap, settles from the run receipt, hides the token', async () => {
    const { fetchImpl, calls } = sequentialFetch([
      response(201, { data: { id: RUN_ID, status: 'SUCCEEDED', defaultDatasetId: DATASET_ID } }),
      response(200, { data: runRecord({ start: 1, 'email-verified': 1 }, 0.0037) }),
      response(200, [item()]),
    ])
    const adapter = createApifyEmailVerifierAdapter({
      env: APPROVED_ENV,
      fetchImpl,
      now,
      finalizationDelayMs: 0,
      sleep: async () => undefined,
    })
    const result = await adapter.verify(REQUEST)

    expect(result.status).toBe('ok')
    expect(result.data?.verification_state).toBe('verified')
    expect(result.cost_units).toBeCloseTo(APIFY_EMAIL_VERIFY_BILLED_UNITS, 10)
    expect(result.receipt).toEqual(expect.objectContaining({
      run_id: RUN_ID,
      billing_finalized: true,
      charged_event_counts: { start: 1, 'email-verified': 1 },
      provider_cost_usd: 0.0037,
      billing_event: 'start+email-verified',
    }))
    expect(calls).toHaveLength(3)
    const start = calls[0]
    expect(start.init.method).toBe('POST')
    expect(start.url).toContain('/acts/automation-lab~email-enrichment/runs?')
    expect(start.url).toContain(`build=${APIFY_EMAIL_VERIFY_BUILD}`)
    expect(start.url).toContain('maxItems=1')
    expect(start.url).toContain('maxTotalChargeUsd=0.01')
    expect(JSON.parse(start.init.body!)).toEqual({
      emails: [EMAIL],
      verificationLevel: 'smtp',
      detectCatchAll: true,
      checkDeliverability: true,
    })
    expect(calls[1].url).toContain(`/actor-runs/${RUN_ID}`)
    expect(calls[2].url).toContain(`/datasets/${DATASET_ID}/items`)
    expect(calls.every((call) => !call.url.includes(TOKEN))).toBe(true)
    expect(calls.every((call) => call.init.headers.authorization === `Bearer ${TOKEN}`)).toBe(true)
    expect(JSON.stringify(result.receipt)).not.toContain(EMAIL)
    expect(JSON.stringify(result.receipt)).not.toContain(TOKEN)
  })

  it('parks a run whose receipt prices drift from the frozen contract instead of settling', async () => {
    const drifted = runRecord({ start: 1, 'email-verified': 1 }, 0.0047)
    drifted.pricingInfo.pricingPerEvent.actorChargeEvents['email-verified'] = { eventPriceUsd: 0.0037 }
    const { fetchImpl } = sequentialFetch([
      response(201, { data: { id: RUN_ID, status: 'SUCCEEDED', defaultDatasetId: DATASET_ID } }),
      response(200, { data: drifted }),
      response(200, { data: drifted }),
      response(200, { data: drifted }),
    ])
    const adapter = createApifyEmailVerifierAdapter({
      env: APPROVED_ENV,
      fetchImpl,
      now,
      finalizationDelayMs: 0,
      sleep: async () => undefined,
    })
    await expect(adapter.verify(REQUEST)).resolves.toEqual(expect.objectContaining({
      status: 'ambiguous',
      cost_units: null,
    }))
  })

  it('parks a post-dispatch 5xx and a 408 on actor start as ambiguous, never as a refund', async () => {
    for (const status of [500, 502, 408]) {
      const { fetchImpl, calls } = sequentialFetch([response(status, 'gateway error')])
      const adapter = createApifyEmailVerifierAdapter({
        env: APPROVED_ENV,
        fetchImpl,
        now,
        finalizationDelayMs: 0,
        sleep: async () => undefined,
      })
      await expect(adapter.verify(REQUEST)).resolves.toEqual(expect.objectContaining({
        status: 'ambiguous',
        cost_units: null,
      }))
      expect(calls).toHaveLength(1)
    }
  })

  it.each([
    ['smtp verified', item(), 'verified', APIFY_EMAIL_VERIFY_BILLED_UNITS],
    ['catch all', item({ isVerified: false, isCatchAll: true, confidenceScore: 60 }), 'catch_all', APIFY_EMAIL_VERIFY_BILLED_UNITS],
    ['role mailbox', item({ isRoleAccount: true, confidenceScore: 85 }), 'risky', APIFY_EMAIL_VERIFY_BILLED_UNITS],
    ['free mailbox', item({ isFreeProvider: true, confidenceScore: 85 }), 'risky', APIFY_EMAIL_VERIFY_BILLED_UNITS],
    ['disposable', item({ isVerified: false, isDisposable: true, confidenceScore: 5, verificationMethod: 'format' }), 'risky', APIFY_EMAIL_VERIFY_BILLED_UNITS],
    ['invalid syntax', item({ isValidFormat: false, hasMxRecords: false, isVerified: false, confidenceScore: 0, verificationMethod: 'format' }), 'not_found', APIFY_EMAIL_VERIFY_BILLED_UNITS],
    ['no mail server', item({ hasMxRecords: false, isVerified: false, confidenceScore: 0, verificationMethod: 'mx' }), 'not_found', APIFY_EMAIL_VERIFY_BILLED_UNITS],
    ['mx only', item({ isVerified: false, confidenceScore: 45, verificationMethod: 'mx' }), 'unknown', APIFY_EMAIL_VERIFY_BILLED_UNITS],
  ])('maps %s without overstating mailbox proof', async (_label, row, expectedState, expectedUnits) => {
    const { adapter } = adapterWith([row])
    const result = await adapter.verify(REQUEST)
    expect(result.status).toBe('ok')
    expect(result.data?.verification_state).toBe(expectedState)
    expect(result.cost_units).toBeCloseTo(expectedUnits, 10)
  })

  it('settles the result event for an emitted row even below the catalog confidence label', async () => {
    const { adapter } = adapterWith([
      item({
        isVerified: false,
        isFreeProvider: true,
        confidenceScore: 5,
        verificationMethod: 'smtp',
      }),
    ])

    const result = await adapter.verify(REQUEST)

    expect(result.data?.verification_state).toBe('risky')
    expect(result.cost_units).toBeCloseTo(APIFY_EMAIL_VERIFY_BILLED_UNITS, 10)
    expect(result.receipt).toEqual(expect.objectContaining({
      confidence_score: 5,
      billing_event: 'start+email-verified',
    }))
  })

  // Review 2026-09-02 (M6/M7): an empty dataset used to be reported as a
  // completed verification ('ok' + verification_state 'unknown') with a
  // guessed start-only charge. It is now a charged no_result, settled from
  // the receipt, so the contact point keeps its retry semantics.
  it('reports an empty dataset as a charged no_result settled from the receipt, not a completed verification', async () => {
    const { adapter } = adapterWith([])
    const result = await adapter.verify(REQUEST)
    expect(result).toEqual(expect.objectContaining({
      status: 'no_result',
      data: null,
      cost_units: expect.closeTo(APIFY_EMAIL_VERIFY_START_ONLY_UNITS, 10),
      receipt: expect.objectContaining({
        provider_status: 'empty_result',
        billing_event: 'start',
        charged_event_counts: { start: 1, 'email-verified': 0 },
      }),
    }))
  })

  it('settles exactly what the receipt charged, even when the row count disagrees with the event label', async () => {
    // A row came back but the provider charged only the start event: bill
    // the start, not an inferred email-verified event.
    const startOnly = jest.fn(async () => finalizedOutcome([item()], { start: 1, 'email-verified': 0 }))
    const cheap = createApifyEmailVerifierAdapter({ env: APPROVED_ENV, runActor: startOnly, now })
    await expect(cheap.verify(REQUEST)).resolves.toEqual(expect.objectContaining({
      status: 'ok',
      cost_units: expect.closeTo(APIFY_EMAIL_VERIFY_START_ONLY_UNITS, 10),
      receipt: expect.objectContaining({ billing_event: 'start' }),
    }))
    // No row but the provider charged the row event: bill what it charged.
    const chargedMiss = jest.fn(async () => finalizedOutcome([], { start: 1, 'email-verified': 1 }))
    const miss = createApifyEmailVerifierAdapter({ env: APPROVED_ENV, runActor: chargedMiss, now })
    await expect(miss.verify(REQUEST)).resolves.toEqual(expect.objectContaining({
      status: 'no_result',
      cost_units: expect.closeTo(APIFY_EMAIL_VERIFY_BILLED_UNITS, 10),
      receipt: expect.objectContaining({ billing_event: 'start+email-verified' }),
    }))
  })

  it('parks unfinalized receipts, unapproved events, and impossible event counts', async () => {
    for (const providerOutcome of [
      finalizedOutcome([item()], undefined, { billingFinalized: false, chargedEventCounts: null, providerCostUsd: null }),
      finalizedOutcome([item()], { start: 1, 'email-verified': 1, 'bulk-discount': 1 }),
      finalizedOutcome([item()], { start: 2, 'email-verified': 1 }),
      finalizedOutcome([item()], { start: 1, 'email-verified': 2 }),
      finalizedOutcome([item()], { start: 0, 'email-verified': 1 }),
    ]) {
      const runActor = jest.fn(async () => providerOutcome)
      const adapter = createApifyEmailVerifierAdapter({ env: APPROVED_ENV, runActor, now })
      await expect(adapter.verify(REQUEST)).resolves.toEqual(expect.objectContaining({
        status: 'ambiguous',
        cost_units: null,
      }))
    }
  })

  it('charges a finalized cost on a terminal provider error and nothing on a rejected start', async () => {
    const finalizedError = createApifyEmailVerifierAdapter({
      env: APPROVED_ENV,
      now,
      runActor: async () => finalizedOutcome([], { start: 1, 'email-verified': 0 }, {
        kind: 'client_error',
        status: 'error',
        error: 'provider_error: actor failed after a charged start',
      }),
    })
    await expect(finalizedError.verify(REQUEST)).resolves.toEqual(expect.objectContaining({
      status: 'error',
      cost_units: expect.closeTo(APIFY_EMAIL_VERIFY_START_ONLY_UNITS, 10),
    }))
    const rejected = createApifyEmailVerifierAdapter({
      env: APPROVED_ENV,
      now,
      runActor: async () => finalizedOutcome([], {}, {
        kind: 'auth_error',
        status: 'error',
        httpStatus: 401,
        billingFinalized: false,
        chargedEventCounts: null,
        providerCostUsd: null,
        error: 'provider_error: Apify rejected actor start (HTTP 401)',
      }),
    })
    await expect(rejected.verify(REQUEST)).resolves.toEqual(expect.objectContaining({
      status: 'error',
      cost_units: 0,
    }))
  })

  it('parks a paid response whose address or schema does not bind to the request', async () => {
    for (const row of [item({ email: 'different@example.test' }), { email: EMAIL }]) {
      const { adapter } = adapterWith([row])
      const result = await adapter.verify(REQUEST)
      expect(result).toEqual(expect.objectContaining({ status: 'ambiguous', cost_units: null }))
    }
  })

  it('parks timeouts, transport uncertainty, and provider 5xx outcomes', async () => {
    // The client now maps a post-dispatch 5xx to ambiguous itself (H1), so
    // the adapter no longer needs a per-kind workaround; the hand-built
    // outcome mirrors what the client produces.
    for (const providerOutcome of [
      outcome([], { kind: 'timeout', status: 'ambiguous', error: 'timeout', billingFinalized: false, providerCostUsd: null, chargedEventCounts: null }),
      outcome([], { kind: 'transport_unknown', status: 'ambiguous', error: 'reset', billingFinalized: false, providerCostUsd: null, chargedEventCounts: null }),
      outcome([], { kind: 'server_error', status: 'ambiguous', httpStatus: 503, error: 'provider_5xx', billingFinalized: false, providerCostUsd: null, chargedEventCounts: null }),
    ]) {
      const runActor = jest.fn(async () => providerOutcome)
      const adapter = createApifyEmailVerifierAdapter({ env: APPROVED_ENV, runActor, now })
      await expect(adapter.verify(REQUEST)).resolves.toEqual(expect.objectContaining({
        status: 'ambiguous',
        cost_units: null,
      }))
    }
  })

  it('refuses an actor override, invalid address, or unsupported capability before a provider call', async () => {
    const runActor = jest.fn(async () => outcome([item()]))
    const overridden = createApifyEmailVerifierAdapter({
      env: { ...APPROVED_ENV, GTM_APIFY_ACTOR_EMAIL_VERIFY: 'someone/else' },
      runActor,
      now,
    })
    expect((await overridden.verify(REQUEST)).status).toBe('error')

    const adapter = createApifyEmailVerifierAdapter({ env: APPROVED_ENV, runActor, now })
    expect((await adapter.verify({ ...REQUEST, value: 'not-an-email' })).status).toBe('error')
    expect((await adapter.verify({ ...REQUEST, geography: 'GB' })).status).toBe('error')
    expect(runActor).not.toHaveBeenCalled()
  })
})
