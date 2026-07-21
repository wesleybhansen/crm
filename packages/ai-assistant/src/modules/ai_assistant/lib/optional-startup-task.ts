export type OptionalStartupTaskOptions = {
  label: string
  timeoutMs: number
  onError: (message: string, error: unknown) => void
  schedule?: (callback: () => void) => void
}

export type OptionalStartupListener = {
  listen: (port: number, onListening: () => void) => unknown
}

export type OptionalStartupListenerOptions = OptionalStartupTaskOptions & {
  onListening: () => void
}

export type OptionalStartupTaskHandle = {
  cancel: () => void
  completion: Promise<void>
}

export function createRunOncePerOwner<Owner extends object>(
  task: (owner: Owner, signal: AbortSignal) => Promise<void>,
): (owner: Owner, signal: AbortSignal) => Promise<void> {
  const runs = new WeakMap<Owner, Promise<void>>()

  return (owner, signal) => {
    const existingRun = runs.get(owner)
    if (existingRun) return existingRun

    const run = Promise.resolve()
      .then(() => task(owner, signal))
      .catch((error: unknown) => {
        runs.delete(owner)
        throw error
      })
    runs.set(owner, run)
    return run
  }
}

export function scheduleOptionalStartupTask(
  task: (signal: AbortSignal) => Promise<void>,
  options: OptionalStartupTaskOptions,
): OptionalStartupTaskHandle {
  const controller = new AbortController()
  const schedule = options.schedule ?? setImmediate
  let timeout: ReturnType<typeof setTimeout> | undefined
  let completed = false
  let complete: (() => void) | undefined
  const completion = new Promise<void>((resolve) => {
    complete = resolve
  })

  const finish = () => {
    if (completed) return
    completed = true
    if (timeout) clearTimeout(timeout)
    complete?.()
  }

  schedule(() => {
    if (controller.signal.aborted) {
      finish()
      return
    }

    timeout = setTimeout(() => {
      const error = new Error(`${options.label} exceeded ${options.timeoutMs}ms`)
      controller.abort(error)
      options.onError(`${options.label} did not complete during its background time budget`, error)
      finish()
    }, options.timeoutMs)
    timeout.unref?.()

    void Promise.resolve()
      .then(() => task(controller.signal))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          options.onError(`${options.label} failed`, error)
        }
      })
      .finally(finish)
  })

  return {
    completion,
    cancel: () => {
      if (!controller.signal.aborted) {
        controller.abort(new Error(`${options.label} cancelled`))
      }
      finish()
    },
  }
}

export function listenBeforeOptionalStartupTask(
  listener: OptionalStartupListener,
  port: number,
  task: (signal: AbortSignal) => Promise<void>,
  options: OptionalStartupListenerOptions,
): OptionalStartupTaskHandle {
  let cancelled = false
  let taskHandle: OptionalStartupTaskHandle | undefined
  let complete: (() => void) | undefined
  const completion = new Promise<void>((resolve) => {
    complete = resolve
  })

  listener.listen(port, () => {
    options.onListening()
    if (cancelled) {
      complete?.()
      return
    }

    taskHandle = scheduleOptionalStartupTask(task, options)
    void taskHandle.completion.finally(() => complete?.())
  })

  return {
    completion,
    cancel: () => {
      cancelled = true
      taskHandle?.cancel()
      complete?.()
    },
  }
}
