import type { Page } from '@playwright/test'

const OM_EVENT_NAME = 'om:event'
const CAPTURED_EVENTS_KEY = '__capturedOmEvents'
const EVENT_SOURCE_KEY = '__omIntegrationEventSource'
const SSE_ENDPOINT = '/api/events/stream'

export type CapturedEvent = {
  id: string
  payload?: Record<string, unknown>
}

export async function installOmEventCollector(page: Page): Promise<void> {
  const installCollector = ({ eventName, storageKey }: { eventName: string; storageKey: string }) => {
    ;(window as unknown as Record<string, unknown>)[storageKey] = []
    window.addEventListener(eventName, (event: Event) => {
      const detail = (event as CustomEvent<CapturedEvent>).detail
      if (!detail || typeof detail !== 'object') return
      const store = (window as unknown as Record<string, unknown>)[storageKey]
      if (!Array.isArray(store)) return
      store.push(detail)
    })
  }
  const collectorOptions = { eventName: OM_EVENT_NAME, storageKey: CAPTURED_EVENTS_KEY }
  await page.addInitScript(installCollector, collectorOptions)
  await page.evaluate(installCollector, collectorOptions)
  await page.evaluate(
    ({ endpoint, sourceKey, storageKey }) => new Promise<void>((resolve, reject) => {
      const target = window as unknown as Record<string, unknown>
      const previousSource = target[sourceKey]
      if (previousSource instanceof EventSource) previousSource.close()

      const source = new EventSource(endpoint, { withCredentials: true })
      target[sourceKey] = source
      const timeout = window.setTimeout(() => {
        source.close()
        reject(new Error('Timed out waiting for the integration SSE connection'))
      }, 8_000)

      source.onopen = () => {
        window.clearTimeout(timeout)
        resolve()
      }
      source.onmessage = (event) => {
        if (!event.data || event.data === ':heartbeat') return
        try {
          const detail = JSON.parse(event.data) as CapturedEvent
          if (!detail || typeof detail !== 'object' || typeof detail.id !== 'string') return
          const store = target[storageKey]
          if (Array.isArray(store)) store.push(detail)
        } catch {}
      }
      source.onerror = () => {
        if (source.readyState !== EventSource.CLOSED) return
        window.clearTimeout(timeout)
        reject(new Error('The integration SSE connection closed before opening'))
      }
    }),
    {
      endpoint: SSE_ENDPOINT,
      sourceKey: EVENT_SOURCE_KEY,
      storageKey: CAPTURED_EVENTS_KEY,
    },
  )
}

export async function getCapturedOmEvents(page: Page): Promise<CapturedEvent[]> {
  return page.evaluate((storageKey) => {
    const store = (window as unknown as Record<string, unknown>)[storageKey]
    if (!Array.isArray(store)) return []
    return store as CapturedEvent[]
  }, CAPTURED_EVENTS_KEY).catch(() => [])
}
