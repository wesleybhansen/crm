/* /backend/integrations and /backend/products 404 (their modules are off).
 * Sync-failure notifications linked there; the redirects catch old links. */
import { legacyBackendRedirects, INTEGRATIONS_HOME, PRODUCTS_HOME } from '../legacy-redirects'
import { notificationTypes } from '../../modules/email/notifications'

describe('legacyBackendRedirects', () => {
  const bySource = new Map(legacyBackendRedirects().map((r) => [r.source, r]))

  it('sends integrations and products routes to real pages, temporarily', () => {
    expect(bySource.get('/backend/integrations')?.destination).toBe(INTEGRATIONS_HOME)
    expect(bySource.get('/backend/integrations/:path*')?.destination).toBe(INTEGRATIONS_HOME)
    expect(bySource.get('/backend/products')?.destination).toBe(PRODUCTS_HOME)
    expect(bySource.get('/backend/products/:path*')?.destination).toBe(PRODUCTS_HOME)
    for (const r of bySource.values()) expect(r.permanent).toBe(false)
  })

  it('no redirect targets a route that is itself redirected', () => {
    for (const r of bySource.values()) {
      expect(r.destination.startsWith('/backend/integrations')).toBe(false)
      expect(r.destination.startsWith('/backend/products')).toBe(false)
    }
  })
})

describe('email sync-failed notification', () => {
  it('links to the settings page, not the missing integrations page', () => {
    const def = notificationTypes.find((t) => t.type === 'email.sync.failed')!
    expect(def.linkHref).toBe(INTEGRATIONS_HOME)
    expect(def.actions?.every((a) => a.href === INTEGRATIONS_HOME)).toBe(true)
  })
})
