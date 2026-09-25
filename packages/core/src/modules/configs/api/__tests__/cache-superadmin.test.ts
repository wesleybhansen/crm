/** @jest-environment node */
/* One tenant per customer: the cache is read and cleared per tenant, so a
 * customer admin manages its own tenant's entries. A caller with no tenant
 * would reach the global cache (super admins only), and the system status
 * snapshot/purge describes the whole deployment (super admins only). */

let superAdmin = false
let authTenant: string | null = 't1'
const cacheTenants: unknown[] = []
const cache = { clear: jest.fn(async () => 3) }

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: async () => ({ sub: 'admin-a', tenantId: authTenant, orgId: 'org-a', roles: ['admin'] }),
}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (k: string) => {
      if (k === 'rbacService') return { loadAcl: async () => ({ isSuperAdmin: superAdmin, features: ['configs.*'] }) }
      if (k === 'cache') return cache
      throw new Error(`no ${k}`)
    },
  }),
}))
jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (_k: string, fallback?: string) => fallback ?? _k }),
}))
jest.mock('@open-mercato/shared/lib/crud/cache-stats', () => ({
  collectCrudCacheStats: jest.fn(async () => ({ total: 1, segments: [{ key: 'crud:selectedOrg:org-b' }] })),
  purgeCrudCacheSegment: jest.fn(async () => ({ deleted: 1 })),
}))
jest.mock('@open-mercato/cache', () => ({
  runWithCacheTenant: async (t: unknown, fn: () => unknown) => { cacheTenants.push(t); return fn() },
}))

import { GET as cacheGet, POST as cachePost } from '../cache/route'
import { GET as statusGet, POST as statusPost } from '../system-status/route'

const post = (body: unknown) => new Request('http://x/api/configs/cache', { method: 'POST', body: JSON.stringify(body) })

describe('configs cache + system status (one tenant per customer)', () => {
  beforeEach(() => { cache.clear.mockClear(); cacheTenants.length = 0; authTenant = 't1' })

  it('lets a customer admin read and clear only its own tenant cache', async () => {
    superAdmin = false
    expect((await cacheGet(new Request('http://x/api/configs/cache'))).status).toBe(200)
    expect((await cachePost(post({ action: 'purgeAll' }))).status).toBe(200)
    expect(cache.clear).toHaveBeenCalled()
    expect(new Set(cacheTenants)).toEqual(new Set(['t1']))
  })

  it('refuses a tenant-less non-super-admin the (global) cache', async () => {
    superAdmin = false
    authTenant = null
    expect((await cacheGet(new Request('http://x/api/configs/cache'))).status).toBe(403)
    expect((await cachePost(post({ action: 'purgeAll' }))).status).toBe(403)
    expect(cache.clear).not.toHaveBeenCalled()
  })

  it('keeps the deployment-wide system status super-admin only', async () => {
    superAdmin = false
    expect((await statusGet(new Request('http://x/api/configs/system-status'))).status).toBe(403)
    expect((await statusPost(post({}))).status).toBe(403)
  })

  it('allows a super admin', async () => {
    superAdmin = true
    expect((await cacheGet(new Request('http://x/api/configs/cache'))).status).toBe(200)
    expect((await cachePost(post({ action: 'purgeAll' }))).status).toBe(200)
    expect(cache.clear).toHaveBeenCalled()
  })
})
