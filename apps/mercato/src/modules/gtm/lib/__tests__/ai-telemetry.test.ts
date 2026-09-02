import { GtmAiTelemetry } from '../../data/entities'
import { GtmAiMeteringError, createGtmTelemetryMeter, recordGtmAiTelemetry } from '../ai/telemetry'
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

  it('awaits canonical metering then stores one bounded content-free receipt', async () => {
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
    expect(em.table(GtmAiTelemetry)).toHaveLength(1)
    expect(em.table(GtmAiTelemetry)[0]).toMatchObject({
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
    expect(em.table(GtmAiTelemetry)[0]).toMatchObject({
      operationKey: 'gtm:test:canonical-meter-failure',
      status: 'succeeded',
      tokensIn: 100,
      tokensOut: 20,
    })
  })

  it('records provider failure and retry metadata idempotently without changing token truth', async () => {
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
    expect(em.table(GtmAiTelemetry)).toHaveLength(1)
    expect(em.table(GtmAiTelemetry)[0]).toMatchObject({
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
  })
})
