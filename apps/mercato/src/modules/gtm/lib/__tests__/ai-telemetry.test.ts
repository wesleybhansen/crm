import { GtmAiTelemetry } from '../../data/entities'
import {
  CANONICAL_METERING_FAILED,
  GtmAiMeteringError,
  createGtmTelemetryMeter,
  recordGtmAiTelemetry,
  settleGtmAiTelemetry,
} from '../ai/telemetry'
import { FakeEm } from './support/fake-em'

const ORG = '00000000-0000-4000-8000-000000000001'
const TENANT = '00000000-0000-4000-8000-000000000002'
const USER = '00000000-0000-4000-8000-000000000003'

describe('GTM AI telemetry', () => {
  const priorVersion = process.env.GTM_AI_RATE_CARD_VERSION
  const priorInput = process.env.GTM_AI_INPUT_USD_PER_MILLION_TOKENS
  const priorOutput = process.env.GTM_AI_OUTPUT_USD_PER_MILLION_TOKENS

  afterEach(() => {
    if (priorVersion == null) delete process.env.GTM_AI_RATE_CARD_VERSION
    else process.env.GTM_AI_RATE_CARD_VERSION = priorVersion
    if (priorInput == null) delete process.env.GTM_AI_INPUT_USD_PER_MILLION_TOKENS
    else process.env.GTM_AI_INPUT_USD_PER_MILLION_TOKENS = priorInput
    if (priorOutput == null) delete process.env.GTM_AI_OUTPUT_USD_PER_MILLION_TOKENS
    else process.env.GTM_AI_OUTPUT_USD_PER_MILLION_TOKENS = priorOutput
  })

  it('stores one bounded content-free receipt per model invocation and forwards unique canonical keys', async () => {
    process.env.GTM_AI_RATE_CARD_VERSION = 'fixture-v1'
    process.env.GTM_AI_INPUT_USD_PER_MILLION_TOKENS = '1.25'
    process.env.GTM_AI_OUTPUT_USD_PER_MILLION_TOKENS = '5'
    const em = new FakeEm()
    const canonicalMeter = jest.fn(async () => {})
    const meter = createGtmTelemetryMeter({
      em,
      ctx: { organizationId: ORG, tenantId: TENANT, userId: USER, requestId: 'request-1' },
      operationKey: 'gtm:test:operation-1',
      surface: 'reply_draft',
      canonicalMeter,
    })
    const usage = {
      model: 'model-1',
      tokensIn: 100,
      tokensOut: 20,
      tokenUsageKnown: true,
      feature: 'gtm-reply-draft',
      status: 'succeeded' as const,
      latencyMs: 240,
      componentEstimates: {
        system: 20,
        history: 30,
        evidence: 50,
        unexpected_raw_prompt: 99,
      },
    }
    await meter(usage)
    await meter(usage)

    expect(canonicalMeter).toHaveBeenCalledTimes(2)
    expect(canonicalMeter.mock.calls.map((call) => call[1])).toEqual([
      'gtm:test:operation-1:call:1',
      'gtm:test:operation-1:call:2',
    ])
    expect(em.table(GtmAiTelemetry)).toHaveLength(2)
    expect(em.table(GtmAiTelemetry)[0]).toMatchObject({
      operationKey: 'gtm:test:operation-1:call:1',
      surface: 'reply_draft',
      model: 'model-1',
      tokensIn: 100,
      tokensOut: 20,
      estimatedCostMicrousd: 225,
      rateCardVersion: 'fixture-v1',
      requestId: 'request-1',
    })
    expect(em.table(GtmAiTelemetry)[0].componentEstimates).toEqual({
      system: 20,
      tool_schema: 0,
      history: 30,
      evidence: 50,
      provider_rows: 0,
      durable_summary: 0,
    })
    expect(JSON.stringify(em.table(GtmAiTelemetry)[0])).not.toContain('unexpected_raw_prompt')
    expect(em.table(GtmAiTelemetry)[1].operationKey).toBe('gtm:test:operation-1:call:2')
  })

  it('leaves cost null without a complete configured rate card and scopes operation keys by org', async () => {
    delete process.env.GTM_AI_RATE_CARD_VERSION
    delete process.env.GTM_AI_INPUT_USD_PER_MILLION_TOKENS
    delete process.env.GTM_AI_OUTPUT_USD_PER_MILLION_TOKENS
    const em = new FakeEm()
    const input = {
      operationKey: 'same-key',
      surface: 'voice_derive',
      model: 'model',
      status: 'succeeded' as const,
      tokensIn: 1,
      tokensOut: 1,
    }
    const first = await recordGtmAiTelemetry(em, { organizationId: ORG, tenantId: TENANT }, input)
    const second = await recordGtmAiTelemetry(
      em,
      { organizationId: '00000000-0000-4000-8000-000000000099', tenantId: TENANT },
      input,
    )
    expect(first.estimatedCostMicrousd).toBeNull()
    expect(second.id).not.toBe(first.id)
    expect(em.table(GtmAiTelemetry)).toHaveLength(2)
  })

  it('preserves the local receipt and fails the operation when canonical metering fails', async () => {
    const em = new FakeEm()
    const canonicalMeter = jest.fn(async () => {
      throw new Error('temporary Noli Core outage')
    })
    const meter = createGtmTelemetryMeter({
      em,
      ctx: { organizationId: ORG, tenantId: TENANT, userId: USER, requestId: 'request-meter-failure' },
      operationKey: 'gtm:test:canonical-meter-failure',
      surface: 'voice_derive',
      canonicalMeter,
    })

    await expect(meter({
      model: 'gemini-3.7-flash',
      tokensIn: 100,
      tokensOut: 20,
      feature: 'gtm-voice-derive',
      status: 'succeeded',
    })).rejects.toBeInstanceOf(GtmAiMeteringError)

    expect(canonicalMeter).toHaveBeenCalledTimes(1)
    expect(em.table(GtmAiTelemetry)).toHaveLength(1)
    // Reviewed behaviour was wrong: the receipt used to say 'succeeded'
    // although no canonical usage row exists. It now records the canonical
    // failure so the operator dashboard cannot report a success that was
    // never metered.
    expect(em.table(GtmAiTelemetry)[0]).toMatchObject({
      operationKey: 'gtm:test:canonical-meter-failure:call:1',
      status: 'failed',
      failureCode: CANONICAL_METERING_FAILED,
      tokensIn: 100,
      tokensOut: 20,
    })
  })

  it('writes the receipt as pending BEFORE canonical metering and settles it to the reported status after', async () => {
    const em = new FakeEm()
    const statusesSeenByCanonical: string[] = []
    const canonicalMeter = jest.fn(async () => {
      const rows = em.table(GtmAiTelemetry)
      statusesSeenByCanonical.push(rows[rows.length - 1]?.status ?? 'missing')
    })
    const meter = createGtmTelemetryMeter({
      em,
      ctx: { organizationId: ORG, tenantId: TENANT, userId: USER, requestId: 'request-pending' },
      operationKey: 'gtm:test:pending-flow',
      surface: 'message_draft',
      canonicalMeter,
    })
    await meter({ model: 'm', tokensIn: 10, tokensOut: 2, feature: 'gtm-message-draft', status: 'succeeded' })
    await meter({
      model: 'm', tokensIn: 0, tokensOut: 0, tokenUsageKnown: false, feature: 'gtm-message-draft',
      status: 'failed', failureCode: 'model_provider_failure',
    })
    expect(statusesSeenByCanonical).toEqual(['pending', 'pending'])
    expect(em.table(GtmAiTelemetry).map((row) => [row.status, row.failureCode])).toEqual([
      ['succeeded', null],
      ['failed', 'model_provider_failure'],
    ])
  })

  it('a retry after a canonical outage settles the same failed receipt to succeeded, never downgrades a success', async () => {
    const em = new FakeEm()
    const ctx = { organizationId: ORG, tenantId: TENANT }
    await recordGtmAiTelemetry(em, ctx, {
      operationKey: 'k', surface: 's', model: 'm', status: 'pending', tokensIn: 1, tokensOut: 1,
    })
    await settleGtmAiTelemetry(em, ctx, { operationKey: 'k', status: 'failed', failureCode: CANONICAL_METERING_FAILED })
    expect(em.table(GtmAiTelemetry)[0]).toMatchObject({ status: 'failed', failureCode: CANONICAL_METERING_FAILED })
    await settleGtmAiTelemetry(em, ctx, { operationKey: 'k', status: 'succeeded', failureCode: null })
    expect(em.table(GtmAiTelemetry)[0]).toMatchObject({ status: 'succeeded', failureCode: null })
    // The canonical row already exists; a later transport failure on a replay
    // must not turn the receipt back into a failure.
    await settleGtmAiTelemetry(em, ctx, { operationKey: 'k', status: 'failed', failureCode: CANONICAL_METERING_FAILED })
    expect(em.table(GtmAiTelemetry)[0]).toMatchObject({ status: 'succeeded', failureCode: null })
    expect(await settleGtmAiTelemetry(em, ctx, { operationKey: 'missing', status: 'succeeded' })).toBeNull()
  })

  it('records failure and retry metadata for every reported model invocation without changing token truth', async () => {
    process.env.GTM_AI_RATE_CARD_VERSION = 'fixture-v1'
    process.env.GTM_AI_INPUT_USD_PER_MILLION_TOKENS = '1.25'
    process.env.GTM_AI_OUTPUT_USD_PER_MILLION_TOKENS = '5'
    const em = new FakeEm()
    const canonicalMeter = jest.fn(async () => {})
    const meter = createGtmTelemetryMeter({
      em,
      ctx: { organizationId: ORG, tenantId: TENANT, userId: USER, requestId: 'request-failure' },
      operationKey: 'gtm:test:failed-operation',
      surface: 'message_draft',
      canonicalMeter,
    })
    const failure = {
      model: 'gemini-3.7-flash',
      tokensIn: 0,
      tokensOut: 0,
      tokenUsageKnown: false,
      feature: 'gtm-message-draft',
      status: 'failed' as const,
      latencyMs: 501,
      retryCount: 2,
      failureCode: 'model_provider_failure',
    }

    await meter(failure)
    await meter(failure)

    expect(canonicalMeter).toHaveBeenCalledTimes(2)
    expect(em.table(GtmAiTelemetry)).toHaveLength(2)
    expect(em.table(GtmAiTelemetry)[0]).toMatchObject({
      operationKey: 'gtm:test:failed-operation:call:1',
      status: 'failed',
      tokensIn: 0,
      tokensOut: 0,
      tokenUsageKnown: false,
      latencyMs: 501,
      retryCount: 2,
      failureCode: 'model_provider_failure',
      estimatedCostMicrousd: null,
      rateCardVersion: null,
    })
    expect(em.table(GtmAiTelemetry)[1].operationKey).toBe('gtm:test:failed-operation:call:2')
  })
})
