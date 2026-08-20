import { GtmAiTelemetry } from '../../data/entities'
import { getAiTelemetryDiagnostics } from '../diagnostics/ai-telemetry'
import { FakeEm } from './support/fake-em'

const ORG = '00000000-0000-4000-8000-000000000001'
const TENANT = '00000000-0000-4000-8000-000000000002'

describe('GTM AI telemetry diagnostics', () => {
  it('aggregates only known usage and returns no receipt identity or content', async () => {
    const em = new FakeEm()
    em.persist(em.create(GtmAiTelemetry, {
      organizationId: ORG,
      tenantId: TENANT,
      operationKey: 'secret-operation-key',
      surface: 'message_draft',
      model: 'fixture-model',
      status: 'succeeded',
      tokensIn: 120,
      tokensOut: 30,
      tokenUsageKnown: true,
      latencyMs: 200,
      retryCount: 1,
      estimatedCostMicrousd: 300,
      requestId: 'private-request-id',
      componentEstimates: { evidence: 80, raw_prompt: 'must-not-return' },
      createdAt: new Date('2026-08-17T20:00:00.000Z'),
    }))
    em.persist(em.create(GtmAiTelemetry, {
      organizationId: ORG,
      tenantId: TENANT,
      operationKey: 'failed-operation',
      surface: 'message_draft',
      model: 'fixture-model',
      status: 'failed',
      tokensIn: 0,
      tokensOut: 0,
      tokenUsageKnown: false,
      latencyMs: 500,
      retryCount: 2,
      estimatedCostMicrousd: null,
      failureCode: 'model_provider_failure',
      createdAt: new Date('2026-08-17T20:01:00.000Z'),
    }))
    em.persist(em.create(GtmAiTelemetry, {
      organizationId: ORG,
      tenantId: '00000000-0000-4000-8000-000000000099',
      operationKey: 'foreign-operation',
      surface: 'message_draft',
      model: 'fixture-model',
      status: 'succeeded',
      tokensIn: 999,
      tokensOut: 999,
    }))
    await em.flush()

    const result = await getAiTelemetryDiagnostics(em, {
      organizationId: ORG,
      tenantId: TENANT,
    })
    expect(result.totals).toMatchObject({
      operations: 2,
      usageKnown: 1,
      usageUnknown: 1,
      tokensInKnown: 120,
      tokensOutKnown: 30,
      retries: 3,
      latencySamples: 2,
      latencyTotalMs: 700,
      latencyMaxMs: 500,
      costSamples: 1,
      estimatedCostMicrousd: 300,
    })
    expect(result.groups).toHaveLength(2)
    expect(result.window).toEqual({ rowCap: 5000, truncated: false })
    const encoded = JSON.stringify(result)
    expect(encoded).not.toContain('secret-operation-key')
    expect(encoded).not.toContain('private-request-id')
    expect(encoded).not.toContain('must-not-return')
    expect(encoded).not.toContain('foreign-operation')
  })
})
