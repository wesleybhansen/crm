/*
 * 2026-09-25 review, H4: the AI lead check metered every pass of a run under
 * `gtm:lead-check:<runId>`, and the meter numbers calls from 1 per pass, so a
 * second pass (rescue, re-run after a skipped pass, another user's check)
 * produced the same invocation keys and the canonical upsert dropped them as
 * duplicates: fresh model calls nobody was billed for. Each pass now has its
 * own operation key.
 */
const operationKeys: string[] = []

jest.mock('../../../../lib/usage/allowance', () => ({
  checkCustomersAiAllowance: async () => ({ allowed: true, byoApiKey: 'byo-key' }),
}))
jest.mock('../../../../lib/usage/meter', () => ({ meterCustomersAiStrict: async () => undefined }))
jest.mock('../ai/model', () => ({ createGeminiDraftModel: () => ({}) }))
jest.mock('../ai/telemetry', () => ({
  createGtmTelemetryMeter: (input: { operationKey: string }) => {
    operationKeys.push(input.operationKey)
    return async () => undefined
  },
}))
jest.mock('../research/judge', () => ({
  judgeRunOpportunities: async () => ({ judged: 0, accepted: 0, rejected: 0 }),
}))

import { runLeadCheck } from '../research/judge-runner'

describe('lead check metering key', () => {
  it('gives every pass over the same run its own operation key', async () => {
    const run = { id: 'run-1', organizationId: 'org-1', tenantId: 'tenant-1', limits: null } as never
    const first = await runLeadCheck({ em: {}, run, play: {} as never, noliUserId: 'noli-1' })
    const second = await runLeadCheck({ em: {}, run, play: {} as never, noliUserId: 'noli-1', rescueNearMisses: true })
    expect(first.status).toBe('checked')
    expect(second.status).toBe('checked')
    expect(operationKeys).toHaveLength(2)
    expect(operationKeys[0]).toMatch(/^gtm:lead-check:run-1:pass:/)
    expect(operationKeys[1]).toMatch(/^gtm:lead-check:run-1:pass:/)
    expect(operationKeys[0]).not.toBe(operationKeys[1])
  })
})
