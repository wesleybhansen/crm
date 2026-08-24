import type { QueuedJob } from '@open-mercato/queue'
import type { GtmAutoRefillJob } from '../auto-refill/contract'
import handle, { GTM_AUTO_REFILL_QUEUE, metadata } from '../../workers/auto-refill'

function job(payload: unknown): QueuedJob<GtmAutoRefillJob> {
  return {
    id: 'job-r38',
    payload: payload as GtmAutoRefillJob,
    createdAt: '2026-08-24T15:00:00.000Z',
  }
}

describe('R38 auto-refill worker gate', () => {
  const originalModuleGate = process.env.GTM_ENGINEER_ENABLED
  const originalAutoRefillGate = process.env.GTM_AUTO_REFILL_ENABLED

  afterEach(() => {
    if (originalModuleGate === undefined) delete process.env.GTM_ENGINEER_ENABLED
    else process.env.GTM_ENGINEER_ENABLED = originalModuleGate
    if (originalAutoRefillGate === undefined) delete process.env.GTM_AUTO_REFILL_ENABLED
    else process.env.GTM_AUTO_REFILL_ENABLED = originalAutoRefillGate
  })

  it('registers a single-concurrency platform queue target', () => {
    expect(GTM_AUTO_REFILL_QUEUE).toBe('gtm-auto-refill')
    expect(metadata).toEqual({
      queue: GTM_AUTO_REFILL_QUEUE,
      id: 'gtm:auto-refill',
      concurrency: 1,
    })
  })

  it.each([
    [undefined, undefined],
    ['true', undefined],
    [undefined, 'true'],
    ['false', 'true'],
    ['true', 'false'],
  ])('returns before payload and dependency access while either gate is dark', async (moduleGate, refillGate) => {
    if (moduleGate === undefined) delete process.env.GTM_ENGINEER_ENABLED
    else process.env.GTM_ENGINEER_ENABLED = moduleGate
    if (refillGate === undefined) delete process.env.GTM_AUTO_REFILL_ENABLED
    else process.env.GTM_AUTO_REFILL_ENABLED = refillGate
    const resolve = jest.fn(() => {
      throw new Error('must remain unreachable')
    })
    await expect(handle(job({ credentials: 'not-even-parsed' }), {
      jobId: 'job-r38',
      attemptNumber: 1,
      queueName: GTM_AUTO_REFILL_QUEUE,
      resolve,
    })).resolves.toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('validates an enabled payload before resolving the ORM', async () => {
    process.env.GTM_ENGINEER_ENABLED = 'true'
    process.env.GTM_AUTO_REFILL_ENABLED = 'true'
    const resolve = jest.fn()
    await expect(handle(job({ policyId: 'not-a-uuid' }), {
      jobId: 'job-r38',
      attemptNumber: 1,
      queueName: GTM_AUTO_REFILL_QUEUE,
      resolve,
    })).rejects.toThrow()
    expect(resolve).not.toHaveBeenCalled()
  })
})
