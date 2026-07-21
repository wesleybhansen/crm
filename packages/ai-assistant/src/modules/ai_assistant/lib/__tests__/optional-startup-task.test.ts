import { once } from 'node:events'
import { createServer } from 'node:http'
import {
  createRunOncePerOwner,
  listenBeforeOptionalStartupTask,
  scheduleOptionalStartupTask,
} from '../optional-startup-task'

describe('scheduleOptionalStartupTask', () => {
  it('defers optional work without making the caller wait', async () => {
    let scheduled: (() => void) | undefined
    let finishTask: (() => void) | undefined
    const task = jest.fn(() => new Promise<void>((resolve) => {
      finishTask = resolve
    }))

    const handle = scheduleOptionalStartupTask(task, {
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
    await handle.completion
  })

  it('reports work that exceeds its background time budget and aborts it', async () => {
    let taskSignal: AbortSignal | undefined
    let reportError: ((value: { message: string; error: unknown }) => void) | undefined
    const errorReported = new Promise<{ message: string; error: unknown }>((resolve) => {
      reportError = resolve
    })

    const handle = scheduleOptionalStartupTask(
      (signal) => {
        taskSignal = signal
        return new Promise<void>(() => undefined)
      },
      {
        label: 'search indexing',
        timeoutMs: 5,
        onError: (message, error) => reportError?.({ message, error }),
        schedule: (callback) => callback(),
      },
    )

    const reported = await errorReported
    await handle.completion

    expect(reported.message).toContain('background time budget')
    expect(reported.error).toEqual(new Error('search indexing exceeded 5ms'))
    expect(taskSignal?.aborted).toBe(true)
  })

  it('contains task failures instead of creating an unhandled rejection', async () => {
    let reportError: ((value: unknown) => void) | undefined
    const errorReported = new Promise<unknown>((resolve) => {
      reportError = resolve
    })
    const failure = new Error('quota unavailable')

    const handle = scheduleOptionalStartupTask(
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
    await handle.completion
  })

  it('cancels pending work through its abort signal', async () => {
    let taskSignal: AbortSignal | undefined
    let taskStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      taskStarted = resolve
    })
    const handle = scheduleOptionalStartupTask(
      async (signal) => {
        taskSignal = signal
        taskStarted?.()
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      },
      {
        label: 'search indexing',
        timeoutMs: 1_000,
        onError: jest.fn(),
        schedule: (callback) => callback(),
      },
    )

    await started
    handle.cancel()
    await handle.completion

    expect(taskSignal?.aborted).toBe(true)
  })
})

describe('createRunOncePerOwner', () => {
  it('shares one in-flight and completed run for the same owner', async () => {
    const owner = {}
    const task = jest.fn(async () => undefined)
    const runOnce = createRunOncePerOwner(task)
    const controller = new AbortController()

    const first = runOnce(owner, controller.signal)
    const second = runOnce(owner, controller.signal)

    await Promise.all([first, second])
    await runOnce(owner, controller.signal)

    expect(task).toHaveBeenCalledTimes(1)
  })

  it('allows a retry after a failed run', async () => {
    const owner = {}
    const task = jest
      .fn<Promise<void>, [object, AbortSignal]>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(undefined)
    const runOnce = createRunOncePerOwner(task)
    const controller = new AbortController()

    await expect(runOnce(owner, controller.signal)).rejects.toThrow('temporary failure')
    await expect(runOnce(owner, controller.signal)).resolves.toBeUndefined()

    expect(task).toHaveBeenCalledTimes(2)
  })
})

describe('listenBeforeOptionalStartupTask', () => {
  it('accepts HTTP requests while optional work remains pending', async () => {
    let taskStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      taskStarted = resolve
    })
    const listener = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok' }))
    })
    const handle = listenBeforeOptionalStartupTask(
      listener,
      0,
      async (signal) => {
        taskStarted?.()
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      },
      {
        label: 'search indexing',
        timeoutMs: 1_000,
        onError: jest.fn(),
        onListening: jest.fn(),
      },
    )

    if (!listener.listening) await once(listener, 'listening')
    await started
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener')

    const response = await fetch(`http://127.0.0.1:${address.port}`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })

    handle.cancel()
    await handle.completion
    await new Promise<void>((resolve, reject) => {
      listener.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  })
})
