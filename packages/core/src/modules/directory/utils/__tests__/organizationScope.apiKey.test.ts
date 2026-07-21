import { resolveOrganizationScopeForRequest } from '../organizationScope'

describe('API-key organization scope', () => {
  const auth = {
    sub: 'api_key:key-org-a',
    tenantId: 'tenant-a',
    orgId: 'org-a',
    isApiKey: true,
    // Even a defensive/malformed upstream context must not make key cookies authoritative.
    isSuperAdmin: true,
    roles: ['superadmin'],
  }

  it('ignores tenant/org cookies and preserves the key row hard cap', async () => {
    const em = {
      find: jest.fn(async (_entity: unknown, where: { id?: { $in?: string[] } }) =>
        (where.id?.$in ?? []).map((id) => ({ id, descendantIds: [] })),
      ),
    }
    const rbac = {
      loadAcl: jest.fn(async () => ({
        isSuperAdmin: true,
        features: ['*'],
        // Simulate an all-org role or a stale pre-hardening cache entry.
        organizations: null,
      })),
    }
    const container = {
      resolve: (token: string) => (token === 'em' ? em : rbac),
    }
    const request = new Request('http://localhost/api/test', {
      headers: {
        cookie: 'om_selected_tenant=tenant-b; om_selected_org=org-b',
      },
    })

    const scope = await resolveOrganizationScopeForRequest({
      container: container as never,
      auth,
      request,
    })

    expect(scope.tenantId).toBe('tenant-a')
    expect(scope.selectedId).toBeNull()
    expect(scope.allowedIds).toEqual(['org-a'])
    expect(scope.filterIds).toEqual(['org-a'])
  })

  it('fails back to the key organization when scope services are unavailable', async () => {
    const container = {
      resolve: () => {
        throw new Error('unavailable')
      },
    }

    const scope = await resolveOrganizationScopeForRequest({
      container: container as never,
      auth,
      selectedId: 'org-b',
      tenantId: 'tenant-b',
    })

    expect(scope).toEqual({
      selectedId: 'org-a',
      filterIds: ['org-a'],
      allowedIds: ['org-a'],
      tenantId: 'tenant-a',
    })
  })
})
