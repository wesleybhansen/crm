import { listenBeforeOptionalStartupTask, scheduleOptionalStartupTask } from '../optional-startup-task'

describe('scheduleOptionalStartupTask', () => {
  it('defers optional work without making the caller wait', async () => {
    let scheduled: (() => void) | undefined
    let finishTask: (() => void) | undefined
    const task = jest.fn(() => new Promise<void>((resolve) => {
      finishTask = resolve
    }))

    scheduleOptionalStartupTask(task, {
      label: 'search indexing',
      timeoutMs: 1_000,
      onError: jest.fn(),
      schedule: (callback) => {
        scheduled = callback
      },
    })

    expect(task).not.toHaveBeenCalled()
    expect(scheduled).toBeDefined()

    scheduled?.()
    await Promise.resolve()

    expect(task).toHaveBeenCalledTimes(1)
    finishTask?.()
  })

  it('reports work that exceeds its background time budget', async () => {
    let finishTask: (() => void) | undefined
    let reportError: ((value: { message: string; error: unknown }) => void) | undefined
    const errorReported = new Promise<{ message: string; error: unknown }>((resolve) => {
      reportError = resolve
    })

    scheduleOptionalStartupTask(
      () => new Promise<void>((resolve) => {
        finishTask = resolve
      }),
      {
        label: 'search indexing',
        timeoutMs: 5,
        onError: (message, error) => reportError?.({ message, error }),
        schedule: (callback) => callback(),
      },
    )

    const reported = await errorReported

    expect(reported.message).toContain('background time budget')
    expect(reported.error).toEqual(new Error('search indexing exceeded 5ms'))
    finishTask?.()
  })

  it('contains task failures instead of creating an unhandled rejection', async () => {
    let reportError: ((value: unknown) => void) | undefined
    const errorReported = new Promise<unknown>((resolve) => {
      reportError = resolve
    })
    const failure = new Error('quota unavailable')

    scheduleOptionalStartupTask(
      async () => {
        throw failure
      },
      {
        label: 'search indexing',
        timeoutMs: 1_000,
        onError: (_message, error) => reportError?.(error),
        schedule: (callback) => callback(),
      },
    )

    await expect(errorReported).resolves.toBe(failure)
  })

  it('binds the listener before scheduling optional work', async () => {
    const events: string[] = []
    let scheduled: (() => void) | undefined
    const task = jest.fn(async () => {
      events.push('task')
    })
    const listener = {
      listen: jest.fn((_port: number, onListening: () => void) => {
        events.push('listen')
        onListening()
      }),
    }

    listenBeforeOptionalStartupTask(listener, 3001, task, {
      label: 'search indexing',
      timeoutMs: 1_000,
      onError: jest.fn(),
      onListening: () => events.push('ready'),
      schedule: (callback) => {
        events.push('scheduled')
        scheduled = callback
      },
    })

    expect(listener.listen).toHaveBeenCalledWith(3001, expect.any(Function))
    expect(events).toEqual(['listen', 'ready', 'scheduled'])
    expect(task).not.toHaveBeenCalled()

    scheduled?.()
    await Promise.resolve()

    expect(events).toEqual(['listen', 'ready', 'scheduled', 'task'])
  })
})
