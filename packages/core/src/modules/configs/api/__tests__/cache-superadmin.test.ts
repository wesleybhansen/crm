/** @jest-environment node */
/* The tenant cache holds every customer's entries in the shared tenant (keys
 * carry organisation ids and queries); reading or clearing it, and the system
 * status snapshot/purge, are super-admin only. */

let superAdmin = false
const cache = { clear: jest.fn(async () => 3) }

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: async () => ({ sub: 'admin-a', tenantId: 't1', orgId: 'org-a', roles: ['admin'] }),
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
  runWithCacheTenant: async (_t: unknown, fn: () => unknown) => fn(),
}))

import { GET as cacheGet, POST as cachePost } from '../cache/route'
import { GET as statusGet, POST as statusPost } from '../system-status/route'

const post = (body: unknown) => new Request('http://x/api/configs/cache', { method: 'POST', body: JSON.stringify(body) })

describe('configs cache + system status (shared tenant)', () => {
  beforeEach(() => { cache.clear.mockClear() })

  it('refuses a customer admin', async () => {
    superAdmin = false
    expect((await cacheGet(new Request('http://x/api/configs/cache'))).status).toBe(403)
    expect((await cachePost(post({ action: 'purgeAll' }))).status).toBe(403)
    expect((await statusGet(new Request('http://x/api/configs/system-status'))).status).toBe(403)
    expect((await statusPost(post({}))).status).toBe(403)
    expect(cache.clear).not.toHaveBeenCalled()
  })

  it('allows a super admin', async () => {
    superAdmin = true
    expect((await cacheGet(new Request('http://x/api/configs/cache'))).status).toBe(200)
    expect((await cachePost(post({ action: 'purgeAll' }))).status).toBe(200)
    expect(cache.clear).toHaveBeenCalled()
  })
})
