jest.mock('next/headers', () => ({ cookies: jest.fn() }))

import { applySuperAdminScope, resolveApiKeyRoleNames } from '../server'

describe('API-key auth scope overrides', () => {
  it('never applies superadmin tenant or organization cookies to an API key', () => {
    const auth = {
      sub: 'api_key:key-org-a',
      tenantId: 'tenant-a',
      orgId: 'org-a',
      isApiKey: true,
      isSuperAdmin: true,
      roles: ['superadmin'],
    }

    expect(applySuperAdminScope(auth, 'tenant-b', 'org-b')).toEqual(auth)
  })

  it('does not expose a superadmin role name to legacy API-key bypass checks', () => {
    const names = ['admin', ' SuperAdmin ', 'employee']
    expect(resolveApiKeyRoleNames('platform-auto:v2:user:source:1', names)).toEqual([
      'admin', 'employee',
    ])
    expect(resolveApiKeyRoleNames('operator-managed', names)).toEqual(names)
  })
})
