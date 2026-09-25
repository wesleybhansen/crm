/**
 * Regression: the organization switcher must never list another customer's
 * organization.
 *
 * Every Noli customer shares ONE tenant, and every member holds the seeded
 * `admin` role whose ACL carries no organization list. The app used to call a
 * custom `/api/org-switcher` route that fell back to "every organization in
 * the tenant" and hard-coded `canManage: true`, so any signed-in member saw
 * every customer's organization name and id. The app now calls this core
 * route, whose menu is capped by `resolveOrganizationScope`.
 */
import { Organization, Tenant } from '@open-mercato/core/modules/directory/data/entities'

const mockGetAuthFromRequest = jest.fn()
const mockLoadAcl = jest.fn()
const mockUserHasAllFeatures = jest.fn()
const mockEmFind = jest.fn()

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: (...args: unknown[]) => mockGetAuthFromRequest(...args),
}))

jest.mock('@open-mercato/shared/lib/crud/factory', () => ({
  logCrudAccess: jest.fn(async () => undefined),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({
    resolve: (token: string) => {
      if (token === 'em') return { find: (...args: unknown[]) => mockEmFind(...args) }
      if (token === 'rbacService') {
        return {
          loadAcl: (...args: unknown[]) => mockLoadAcl(...args),
          userHasAllFeatures: (...args: unknown[]) => mockUserHasAllFeatures(...args),
        }
      }
      throw new Error(`unexpected token ${token}`)
    },
  })),
}))

import { GET } from '../route'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG_ALICE = '22222222-2222-4222-8222-222222222222'
const ORG_BOB = '33333333-3333-4333-8333-333333333333'
const ORG_CAROL = '44444444-4444-4444-8444-444444444444'

type OrgRow = {
  id: string
  name: string
  parentId: string | null
  isActive: boolean
  descendantIds: string[]
  deletedAt: Date | null
}

const orgs: OrgRow[] = [
  { id: ORG_ALICE, name: 'Alice Realty', parentId: null, isActive: true, descendantIds: [], deletedAt: null },
  { id: ORG_BOB, name: 'Bob Homes', parentId: null, isActive: true, descendantIds: [], deletedAt: null },
  { id: ORG_CAROL, name: 'Carol Group', parentId: null, isActive: true, descendantIds: [], deletedAt: null },
]

function installEm() {
  mockEmFind.mockImplementation(async (entity: unknown, where: Record<string, any>) => {
    if (entity === Tenant) {
      return [{ id: TENANT, name: 'Noli', isActive: true }]
    }
    if (entity === Organization) {
      if (where.tenant !== TENANT) return []
      const ids: string[] | undefined = where.id?.$in
      return orgs.filter((org) => !ids || ids.includes(org.id))
    }
    return []
  })
}

function memberAuth(sub: string, orgId: string) {
  return { sub, tenantId: TENANT, orgId, roles: ['admin'], isSuperAdmin: false }
}

function request(cookie?: string) {
  return new Request('https://crm.example.test/api/directory/organization-switcher', {
    headers: cookie ? { cookie } : {},
  }) as never
}

function flatIds(items: Array<{ id: string; children: any[] }>): string[] {
  return items.flatMap((item) => [item.id, ...flatIds(item.children ?? [])])
}

beforeEach(() => {
  jest.clearAllMocks()
  installEm()
  // The seeded `admin` role: every feature, no organization list ("all orgs").
  mockLoadAcl.mockResolvedValue({ isSuperAdmin: false, features: ['*'], organizations: null })
  mockUserHasAllFeatures.mockResolvedValue(true)
})

describe('GET /api/directory/organization-switcher — one shared tenant', () => {
  it('shows each of two customers only their own organization', async () => {
    mockGetAuthFromRequest.mockResolvedValueOnce(memberAuth('user-alice', ORG_ALICE))
    const aliceRes = await GET(request())
    const alice = await aliceRes.json()

    mockGetAuthFromRequest.mockResolvedValueOnce(memberAuth('user-bob', ORG_BOB))
    const bobRes = await GET(request())
    const bob = await bobRes.json()

    expect(aliceRes.status).toBe(200)
    expect(flatIds(alice.items)).toEqual([ORG_ALICE])
    expect(alice.items[0].name).toBe('Alice Realty')
    expect(alice.selectedId).toBe(ORG_ALICE)
    expect(alice.isSuperAdmin).toBe(false)
    expect(alice.tenants).toEqual([])

    expect(bobRes.status).toBe(200)
    expect(flatIds(bob.items)).toEqual([ORG_BOB])
    expect(bob.items[0].name).toBe('Bob Homes')
    expect(bob.selectedId).toBe(ORG_BOB)

    const serialized = JSON.stringify([alice, bob])
    expect(serialized).not.toContain(ORG_CAROL)
    expect(serialized).not.toContain('Carol Group')
    expect(JSON.stringify(alice)).not.toContain('Bob Homes')
    expect(JSON.stringify(bob)).not.toContain('Alice Realty')
  })

  it('ignores a forged om_selected_org / om_selected_tenant cookie pointing at another customer', async () => {
    mockGetAuthFromRequest.mockResolvedValueOnce(memberAuth('user-alice', ORG_ALICE))
    const res = await GET(request(`om_selected_org=${ORG_BOB}; om_selected_tenant=${TENANT}`))
    const body = await res.json()

    expect(flatIds(body.items)).toEqual([ORG_ALICE])
    expect(body.selectedId).not.toBe(ORG_BOB)
    expect(JSON.stringify(body)).not.toContain('Bob Homes')
  })

  it('derives canManage from the permission check instead of hard-coding it', async () => {
    mockUserHasAllFeatures.mockResolvedValue(false)
    mockGetAuthFromRequest.mockResolvedValueOnce(memberAuth('user-alice', ORG_ALICE))
    const body = await (await GET(request())).json()

    expect(body.canManage).toBe(false)
    expect(flatIds(body.items)).toEqual([ORG_ALICE])
  })

  it('keeps the super-admin view of the whole tenant', async () => {
    mockLoadAcl.mockResolvedValue({ isSuperAdmin: true, features: ['*'], organizations: null })
    mockGetAuthFromRequest.mockResolvedValueOnce({
      sub: 'user-root',
      tenantId: TENANT,
      orgId: ORG_ALICE,
      roles: ['superadmin'],
      isSuperAdmin: true,
    })
    const body = await (await GET(request())).json()

    expect(body.isSuperAdmin).toBe(true)
    expect(body.canManage).toBe(true)
    expect(flatIds(body.items).sort()).toEqual([ORG_ALICE, ORG_BOB, ORG_CAROL].sort())
    expect(body.tenants).toEqual([{ id: TENANT, name: 'Noli', isActive: true }])
  })

  it('returns 401 with an empty menu when signed out', async () => {
    mockGetAuthFromRequest.mockResolvedValueOnce(null)
    const res = await GET(request())
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.items).toEqual([])
  })
})
