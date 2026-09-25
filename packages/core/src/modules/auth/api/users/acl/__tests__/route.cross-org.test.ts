/** @jest-environment node */
/* A customer admin must not read the ACL of another customer's user. */

const TARGET_ORG: Record<string, string> = { 'user-a': 'org-a', 'user-b': 'org-b' }
let superAdmin = false

const knex = (table: string) => {
  let id: unknown
  const api = {
    where: (_c: string, v: unknown) => { id = v; return api },
    first: async () => (table === 'users' && typeof id === 'string' && TARGET_ORG[id] ? { organization_id: TARGET_ORG[id] } : undefined),
  }
  return api
}
const em = {
  getKnex: () => knex,
  findOne: jest.fn(async () => ({ isSuperAdmin: false, featuresJson: ['customers.*'], organizationsJson: null })),
}

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: async () => ({ sub: 'admin-a', tenantId: 't1', orgId: 'org-a', roles: ['admin'] }),
}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (k: string) => {
      if (k === 'em') return em
      if (k === 'rbacService') return { loadAcl: async () => ({ isSuperAdmin: superAdmin }) }
      throw new Error(`no ${k}`)
    },
  }),
}))
jest.mock('@open-mercato/shared/lib/crud/factory', () => ({
  ...jest.requireActual('@open-mercato/shared/lib/crud/factory'),
  logCrudAccess: jest.fn(async () => undefined),
}))

import { GET } from '../route'

const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'
TARGET_ORG[USER_A] = 'org-a'
TARGET_ORG[USER_B] = 'org-b'

describe('GET /api/auth/users/acl (shared tenant)', () => {
  it('refuses reading another customer\'s user ACL', async () => {
    superAdmin = false
    const res = await GET(new Request(`http://x/api/auth/users/acl?userId=${USER_B}`))
    expect(res.status).toBe(403)
    expect(em.findOne).not.toHaveBeenCalled()
  })

  it('allows reading an own-organization user ACL', async () => {
    superAdmin = false
    const res = await GET(new Request(`http://x/api/auth/users/acl?userId=${USER_A}`))
    expect(res.status).toBe(200)
  })
})
