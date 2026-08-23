import type { VerifyRequest } from '../adapters/types'
import {
  APIFY_EMAIL_VERIFY_ACTOR_ID,
  APIFY_EMAIL_VERIFY_ADAPTER_ID,
  APIFY_EMAIL_VERIFY_BILLED_UNITS,
  APIFY_EMAIL_VERIFY_BUILD,
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

function outcome(
  items: unknown[],
  overrides: Partial<ApifyRunOutcome> = {},
): ApifyRunOutcome {
  return {
    kind: items.length > 0 ? 'ok' : 'no_result',
    status: items.length > 0 ? 'ok' : 'no_result',
    items,
    actorId: APIFY_EMAIL_VERIFY_ACTOR_ID,
    runId: null,
    itemCount: items.length,
    httpStatus: 201,
    retryAfterSeconds: null,
    bodySnippet: null,
    requestUrl: 'https://api.apify.test/redacted',
    attemptedAt: CLOCK.toISOString(),
    error: null,
    ...overrides,
  }
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

  it('quotes the Apify minimum run cap while settling the frozen start and result events', () => {
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
    expect(APIFY_EMAIL_VERIFY_BILLED_UNITS).toBeCloseTo(0.4, 10)
  })

  it('pins the actor build, one-address input, and provider-side cap without exposing the token', async () => {
    const calls: { url: string; init: ApifyFetchInit }[] = []
    const fetchImpl: ApifyFetchLike = async (url, init) => {
      calls.push({ url, init })
      return {
        status: 201,
        headers: { get: () => null },
        text: async () => JSON.stringify([item()]),
      }
    }
    const adapter = createApifyEmailVerifierAdapter({ env: APPROVED_ENV, fetchImpl, now })
    const result = await adapter.verify(REQUEST)

    expect(result.data?.verification_state).toBe('verified')
    expect(result.cost_units).toBeCloseTo(APIFY_EMAIL_VERIFY_BILLED_UNITS, 10)
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call.url).toContain(`build=${APIFY_EMAIL_VERIFY_BUILD}`)
    expect(call.url).toContain('maxItems=1')
    expect(call.url).toContain('maxTotalChargeUsd=0.01')
    expect(call.url).not.toContain(TOKEN)
    expect(call.init.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(call.init.body)).toEqual({
      emails: [EMAIL],
      verificationLevel: 'smtp',
      detectCatchAll: true,
      checkDeliverability: true,
    })
    expect(JSON.stringify(result.receipt)).not.toContain(EMAIL)
    expect(JSON.stringify(result.receipt)).not.toContain(TOKEN)
  })

  it.each([
    ['smtp verified', item(), 'verified', APIFY_EMAIL_VERIFY_BILLED_UNITS],
    ['catch all', item({ isVerified: false, isCatchAll: true, confidenceScore: 60 }), 'catch_all', APIFY_EMAIL_VERIFY_BILLED_UNITS],
    ['role mailbox', item({ isRoleAccount: true, confidenceScore: 85 }), 'risky', APIFY_EMAIL_VERIFY_BILLED_UNITS],
    ['free mailbox', item({ isFreeProvider: true, confidenceScore: 85 }), 'risky', APIFY_EMAIL_VERIFY_BILLED_UNITS],
    ['disposable', item({ isVerified: false, isDisposable: true, confidenceScore: 5, verificationMethod: 'format' }), 'risky', APIFY_EMAIL_VERIFY_START_ONLY_UNITS],
    ['invalid syntax', item({ isValidFormat: false, hasMxRecords: false, isVerified: false, confidenceScore: 0, verificationMethod: 'format' }), 'not_found', APIFY_EMAIL_VERIFY_START_ONLY_UNITS],
    ['no mail server', item({ hasMxRecords: false, isVerified: false, confidenceScore: 0, verificationMethod: 'mx' }), 'not_found', APIFY_EMAIL_VERIFY_START_ONLY_UNITS],
    ['mx only', item({ isVerified: false, confidenceScore: 45, verificationMethod: 'mx' }), 'unknown', APIFY_EMAIL_VERIFY_START_ONLY_UNITS],
  ])('maps %s without overstating mailbox proof', async (_label, row, expectedState, expectedUnits) => {
    const { adapter } = adapterWith([row])
    const result = await adapter.verify(REQUEST)
    expect(result.status).toBe('ok')
    expect(result.data?.verification_state).toBe(expectedState)
    expect(result.cost_units).toBeCloseTo(expectedUnits, 10)
  })

  it('returns a definite unknown with only the start event when the actor returns no row', async () => {
    const { adapter } = adapterWith([])
    const result = await adapter.verify(REQUEST)
    expect(result).toEqual(expect.objectContaining({
      status: 'ok',
      cost_units: APIFY_EMAIL_VERIFY_START_ONLY_UNITS,
      data: expect.objectContaining({ verification_state: 'unknown' }),
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
    for (const providerOutcome of [
      outcome([], { kind: 'timeout', status: 'ambiguous', error: 'timeout' }),
      outcome([], { kind: 'transport_unknown', status: 'ambiguous', error: 'reset' }),
      outcome([], { kind: 'server_error', status: 'error', httpStatus: 503, error: 'provider_5xx' }),
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
