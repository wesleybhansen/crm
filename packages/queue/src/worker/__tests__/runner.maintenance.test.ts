import { createQueue } from '../../factory'
import type { Queue } from '../../types'
import { isWorkerMaintenanceMode, runWorker } from '../runner'

/* 2026-09-25 review, M6: queue workers wrote straight through the
 * MAINTENANCE window (only the HTTP dispatcher refused writes). */

jest.mock('../../factory', () => ({
  createQueue: jest.fn(),
}))

describe('queue workers during maintenance', () => {
  const createQueueMock = createQueue as jest.MockedFunction<typeof createQueue>
  const saved = process.env.MAINTENANCE

  afterEach(() => {
    jest.clearAllMocks()
    if (saved === undefined) delete process.env.MAINTENANCE
    else process.env.MAINTENANCE = saved
  })

  it('reads the flag like the rest of the app', () => {
    expect(isWorkerMaintenanceMode({ MAINTENANCE: '1' })).toBe(true)
    expect(isWorkerMaintenanceMode({ MAINTENANCE: 'true' })).toBe(true)
    expect(isWorkerMaintenanceMode({ MAINTENANCE: '' })).toBe(false)
    expect(isWorkerMaintenanceMode({ MAINTENANCE: '0' })).toBe(false)
    expect(isWorkerMaintenanceMode({})).toBe(false)
  })

  it('a worker started under MAINTENANCE never creates or processes its queue', async () => {
    process.env.MAINTENANCE = '1'
    const handler = jest.fn()
    await runWorker({ queueName: 'q-maint', handler, background: true, gracefulShutdown: false })
    expect(createQueueMock).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('a job picked up after MAINTENANCE is switched on is refused, not run', async () => {
    delete process.env.MAINTENANCE
    let registered: ((job: unknown, ctx: unknown) => Promise<void>) | null = null
    const queue = {
      name: 'q-live', strategy: 'local',
      enqueue: jest.fn(), clear: jest.fn(), close: jest.fn(), getJobCounts: jest.fn(),
      process: jest.fn(async (h: any) => { registered = h; return { processed: 0, failed: 0, lastJobId: undefined } }),
    } as unknown as Queue<unknown>
    createQueueMock.mockReturnValueOnce(queue)
    const handler = jest.fn(async () => undefined)
    await runWorker({ queueName: 'q-live', handler, background: true, gracefulShutdown: false })
    expect(registered).not.toBeNull()
    await registered!({ id: 'j1', payload: {} }, {})
    expect(handler).toHaveBeenCalledTimes(1)
    process.env.MAINTENANCE = '1'
    await expect(registered!({ id: 'j2', payload: {} }, {})).rejects.toThrow(/MAINTENANCE/)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
