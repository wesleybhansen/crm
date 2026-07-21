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

export function scheduleOptionalStartupTask(
  task: () => Promise<void>,
  options: OptionalStartupTaskOptions,
): void {
  const schedule = options.schedule ?? setImmediate

  schedule(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const taskPromise = Promise.resolve().then(task)
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`${options.label} exceeded ${options.timeoutMs}ms`))
      }, options.timeoutMs)
      timeout.unref?.()
    })

    void Promise.race([taskPromise, timeoutPromise])
      .catch((error: unknown) => {
        options.onError(`${options.label} did not complete during its background time budget`, error)
      })
      .finally(() => {
        if (timeout) clearTimeout(timeout)
      })
  })
}

export function listenBeforeOptionalStartupTask(
  listener: OptionalStartupListener,
  port: number,
  task: () => Promise<void>,
  options: OptionalStartupListenerOptions,
): void {
  listener.listen(port, () => {
    options.onListening()
    scheduleOptionalStartupTask(task, options)
  })
}
