import type { Page } from '@playwright/test'

const OM_EVENT_NAME = 'om:event'
const CAPTURED_EVENTS_KEY = '__capturedOmEvents'

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
}

export async function getCapturedOmEvents(page: Page): Promise<CapturedEvent[]> {
  return page.evaluate((storageKey) => {
    const store = (window as unknown as Record<string, unknown>)[storageKey]
    if (!Array.isArray(store)) return []
    return store as CapturedEvent[]
  }, CAPTURED_EVENTS_KEY).catch(() => [])
}
