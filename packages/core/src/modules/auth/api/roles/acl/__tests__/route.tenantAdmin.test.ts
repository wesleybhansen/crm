/** @jest-environment node */
/* One tenant per customer (CRM_TENANT_PER_CUSTOMER): a customer admin saves
 * the role permissions of its own tenant (TC-AUTH-013), but only there and
 * only within its own permissions: no other tenant's role, no super admin
 * flag, no feature it does not hold, no organisation of another tenant. A
 * super admin is not limited by any of this. */

import { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'

const TENANT_A = 'aaaaaaaa-0000-4000-8000-000000000000'
const TENANT_B = 'bbbbbbbb-0000-4000-8000-000000000000'
const ORG_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ORG_A2 = 'aaaaaaaa-0000-4000-8000-0000000000a2'
const ORG_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ROLE_A = 'aaaaaaaa-1111-4000-8000-000000000001'
const ROLE_B = 'bbbbbbbb-1111-4000-8000-000000000001'
const ROLE_GLOBAL = 'cccccccc-1111-4000-8000-000000000001'

type AclRow = { role: { id: string }; tenantId: string; isSuperAdmin: boolean; featuresJson?: string[] | null; organizationsJson?: string[] | null }
type ActorAcl = { isSuperAdmin: boolean; features: string[]; organizations: string[] | null }

const ROLES: Record<string, { id: string; tenantId: string | null }> = {
  [ROLE_A]: { id: ROLE_A, tenantId: TENANT_A },
  [ROLE_B]: { id: ROLE_B, tenantId: TENANT_B },
  [ROLE_GLOBAL]: { id: ROLE_GLOBAL, tenantId: null },
}
const ORG_TENANT: Record<string, string> = { [ORG_A]: TENANT_A, [ORG_A2]: TENANT_A, [ORG_B]: TENANT_B }

let acls: Map<string, AclRow>
let persisted: AclRow[]
let currentAuth: { sub: string; tenantId: string | null; orgId: string | null; roles: string[] }
let actorAcl: ActorAcl

const aclKey = (roleId: string, tenantId: string) => `${roleId}:${tenantId}`

const em = {
  findOne: jest.fn(async (entity: { name: string }, where: Record<string, any>) => {
    if (entity.name === 'Role') return ROLES[where.id] ?? null
    if (entity.name === 'RoleAcl') return acls.get(aclKey(where.role.id, where.tenantId)) ?? null
    throw new Error(`unexpected findOne(${entity.name})`)
  }),
  count: jest.fn(async (entity: { name: string }, where: Record<string, any>) => {
    if (entity.name !== 'Organization') throw new Error(`unexpected count(${entity.name})`)
    const ids: string[] = where.id.$in
    return ids.filter((id) => ORG_TENANT[id] === where.tenant).length
  }),
  create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ ...data })),
  persistAndFlush: jest.fn(async (row: AclRow) => {
    persisted.push({ ...row })
    acls.set(aclKey(row.role.id, row.tenantId), row)
  }),
}

// The real service, so feature coverage (exact and `module.*` wildcards) is
// the matcher the rest of RBAC uses; only the actor's ACL lookup is stubbed.
const rbacService = new RbacService(em as never)
jest.spyOn(rbacService, 'loadAcl').mockImplementation(async () => actorAcl)
const invalidateTenantCache = jest.spyOn(rbacService, 'invalidateTenantCache').mockImplementation(async () => undefined)

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: async () => currentAuth,
}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (key: string) => {
      if (key === 'em') return em
      if (key === 'rbacService') return rbacService
      if (key === 'cache') return { deleteByTags: async () => undefined }
      throw new Error(`no ${key}`)
    },
  }),
}))
jest.mock('@open-mercato/shared/lib/crud/factory', () => ({
  ...jest.requireActual('@open-mercato/shared/lib/crud/factory'),
  logCrudAccess: jest.fn(async () => undefined),
}))

import { GET, PUT } from '../route'

function put(body: Record<string, unknown>) {
  return PUT(new Request('http://x/api/auth/roles/acl', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

function asTenantAdmin(features: string[] = ['auth.*', 'api_keys.*', 'customers.*']) {
  currentAuth = { sub: 'admin-a', tenantId: TENANT_A, orgId: ORG_A, roles: ['admin'] }
  actorAcl = { isSuperAdmin: false, features, organizations: null }
}

function asSuperAdmin() {
  currentAuth = { sub: 'root', tenantId: TENANT_A, orgId: ORG_A, roles: ['superadmin'] }
  actorAcl = { isSuperAdmin: true, features: ['*'], organizations: null }
}

beforeEach(() => {
  acls = new Map()
  persisted = []
  jest.clearAllMocks()
})

describe('PUT /api/auth/roles/acl: a tenant admin saves its own tenant\'s roles', () => {
  it('saves a new role\'s ACL in its own tenant (TC-AUTH-013)', async () => {
    asTenantAdmin()
    const res = await put({ roleId: ROLE_A, tenantId: TENANT_A, isSuperAdmin: false, features: ['api_keys.view', 'customers.people.view'], organizations: null })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, sanitized: false })
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({ tenantId: TENANT_A, isSuperAdmin: false, featuresJson: ['api_keys.view', 'customers.people.view'], organizationsJson: null })
    expect(invalidateTenantCache).toHaveBeenCalledWith(TENANT_A)
  })

  it('writes the row scoped to its own tenant when the payload names no tenant', async () => {
    asTenantAdmin()
    const res = await put({ roleId: ROLE_A, features: ['customers.*'] })
    expect(res.status).toBe(200)
    expect(persisted[0]).toMatchObject({ tenantId: TENANT_A, featuresJson: ['customers.*'] })
  })

  it('limits a role to organisations of its own tenant', async () => {
    asTenantAdmin()
    const res = await put({ roleId: ROLE_A, tenantId: TENANT_A, features: ['customers.people.view'], organizations: [ORG_A, ORG_A2] })
    expect(res.status).toBe(200)
    expect(persisted[0].organizationsJson).toEqual([ORG_A, ORG_A2])
  })

  it('removes features, including ones it does not hold itself, and keeps ones already on the role', async () => {
    asTenantAdmin(['customers.*', 'api_keys.*'])
    acls.set(aclKey(ROLE_A, TENANT_A), {
      role: { id: ROLE_A }, tenantId: TENANT_A, isSuperAdmin: false,
      featuresJson: ['customers.*', 'sales.orders.view', 'sales.quotes.view'], organizationsJson: null,
    })
    const res = await put({ roleId: ROLE_A, tenantId: TENANT_A, isSuperAdmin: false, features: ['sales.orders.view', 'api_keys.view'] })
    expect(res.status).toBe(200)
    expect(persisted[0].featuresJson).toEqual(['sales.orders.view', 'api_keys.view'])
  })

  it('narrows a wildcard already on the role to one of its features', async () => {
    asTenantAdmin(['customers.*'])
    acls.set(aclKey(ROLE_A, TENANT_A), { role: { id: ROLE_A }, tenantId: TENANT_A, isSuperAdmin: false, featuresJson: ['sales.*'] })
    const res = await put({ roleId: ROLE_A, features: ['sales.orders.view'] })
    expect(res.status).toBe(200)
    expect(persisted[0].featuresJson).toEqual(['sales.orders.view'])
  })

  it('grants a narrower wildcard covered by a module wildcard it holds', async () => {
    asTenantAdmin(['customers.*'])
    const res = await put({ roleId: ROLE_A, features: ['customers.deals.*', 'customers'] })
    expect(res.status).toBe(200)
    expect(persisted[0].featuresJson).toEqual(['customers.deals.*', 'customers'])
  })
})

describe('PUT /api/auth/roles/acl: another tenant is refused', () => {
  it('refuses a role that belongs to another tenant', async () => {
    asTenantAdmin()
    const res = await put({ roleId: ROLE_B, tenantId: TENANT_B, features: ['customers.people.view'] })
    expect(res.status).toBe(403)
    expect(em.persistAndFlush).not.toHaveBeenCalled()
  })

  it('refuses another tenant\'s role even when the payload names its own tenant', async () => {
    asTenantAdmin()
    const res = await put({ roleId: ROLE_B, tenantId: TENANT_A, features: ['customers.people.view'] })
    expect(res.status).toBe(403)
    expect(em.persistAndFlush).not.toHaveBeenCalled()
  })

  it('refuses writing its own role\'s ACL row into another tenant', async () => {
    asTenantAdmin()
    const res = await put({ roleId: ROLE_A, tenantId: TENANT_B, features: ['customers.people.view'] })
    expect(res.status).toBe(403)
    expect(em.persistAndFlush).not.toHaveBeenCalled()
  })

  it('refuses writing a global role\'s ACL row into another tenant', async () => {
    asTenantAdmin()
    const res = await put({ roleId: ROLE_GLOBAL, tenantId: TENANT_B, features: ['customers.people.view'] })
    expect(res.status).toBe(403)
    expect(em.persistAndFlush).not.toHaveBeenCalled()
  })

  it('refuses organisations of another tenant', async () => {
    asTenantAdmin()
    const res = await put({ roleId: ROLE_A, tenantId: TENANT_A, features: ['customers.people.view'], organizations: [ORG_A, ORG_B] })
    expect(res.status).toBe(403)
    expect(em.persistAndFlush).not.toHaveBeenCalled()
  })

  it('refuses organisation ids that are not ids at all', async () => {
    asTenantAdmin()
    const res = await put({ roleId: ROLE_A, features: ['customers.people.view'], organizations: ['not-an-id'] })
    expect(res.status).toBe(400)
    expect(em.persistAndFlush).not.toHaveBeenCalled()
  })

  it('refuses a caller with no tenant', async () => {
    asTenantAdmin()
    currentAuth = { ...currentAuth, tenantId: null }
    const res = await put({ roleId: ROLE_GLOBAL, tenantId: TENANT_A, features: ['customers.people.view'] })
    expect(res.status).toBe(403)
    expect(em.persistAndFlush).not.toHaveBeenCalled()
  })
})

describe('PUT /api/auth/roles/acl: super admin escalation is refused', () => {
  it('refuses marking a new ACL row as super admin', async () => {
    asTenantAdmin()
    const res = await put({ roleId: ROLE_A, tenantId: TENANT_A, isSuperAdmin: true, features: [] })
    expect(res.status).toBe(403)
    expect(em.create).not.toHaveBeenCalled()
    expect(em.persistAndFlush).not.toHaveBeenCalled()
  })

  it('refuses marking an existing row as super admin', async () => {
    asTenantAdmin()
    acls.set(aclKey(ROLE_A, TENANT_A), { role: { id: ROLE_A }, tenantId: TENANT_A, isSuperAdmin: false, featuresJson: ['customers.*'] })
    const res = await put({ roleId: ROLE_A, isSuperAdmin: true, features: ['customers.*'] })
    expect(res.status).toBe(403)
    expect(em.persistAndFlush).not.toHaveBeenCalled()
  })

  it('refuses editing a super admin row while keeping the flag on (flag omitted)', async () => {
    asTenantAdmin()
    acls.set(aclKey(ROLE_A, TENANT_A), { role: { id: ROLE_A }, tenantId: TENANT_A, isSuperAdmin: true, featuresJson: [] })
    const res = await put({ roleId: ROLE_A, features: ['customers.people.view'] })
    expect(res.status).toBe(403)
    expect(em.persistAndFlush).not.toHaveBeenCalled()
  })

  it('refuses changing a super admin row at all, including switching it off', async () => {
    asTenantAdmin()
    acls.set(aclKey(ROLE_A, TENANT_A), { role: { id: ROLE_A }, tenantId: TENANT_A, isSuperAdmin: true, featuresJson: [] })
    const res = await put({ roleId: ROLE_A, isSuperAdmin: false, features: [] })
    expect(res.status).toBe(403)
    expect(acls.get(aclKey(ROLE_A, TENANT_A))?.isSuperAdmin).toBe(true)
  })
})

describe('PUT /api/auth/roles/acl: features beyond the caller\'s own are refused', () => {
  it('refuses a feature the caller does not hold', async () => {
    asTenantAdmin(['customers.*', 'api_keys.*'])
    const res = await put({ roleId: ROLE_A, features: ['customers.people.view', 'sales.orders.view'] })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toContain('sales.orders.view')
    expect(em.persistAndFlush).not.toHaveBeenCalled()
  })

  it('refuses a module wildcard when the caller holds only single features of that module', async () => {
    asTenantAdmin(['customers.people.view', 'customers.people.manage'])
    const res = await put({ roleId: ROLE_A, features: ['customers.*'] })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toContain('customers.*')
    expect(em.persistAndFlush).not.toHaveBeenCalled()
  })

  it('refuses a wildcard of a module the caller has no access to', async () => {
    asTenantAdmin(['customers.*'])
    const res = await put({ roleId: ROLE_A, features: ['auth.*'] })
    expect(res.status).toBe(403)
    expect(em.persistAndFlush).not.toHaveBeenCalled()
  })

  it('refuses adding a feature the caller lacks alongside ones already on the role', async () => {
    asTenantAdmin(['customers.*'])
    acls.set(aclKey(ROLE_A, TENANT_A), { role: { id: ROLE_A }, tenantId: TENANT_A, isSuperAdmin: false, featuresJson: ['sales.orders.view'] })
    const res = await put({ roleId: ROLE_A, features: ['sales.orders.view', 'sales.orders.manage'] })
    expect(res.status).toBe(403)
    expect(em.persistAndFlush).not.toHaveBeenCalled()
  })

  it('still drops the platform-only features silently (reported as sanitized)', async () => {
    asTenantAdmin(['*'])
    const res = await put({ roleId: ROLE_A, features: ['*', 'directory.tenants.manage', 'customers.*'] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, sanitized: true })
    expect(persisted[0].featuresJson).toEqual(['customers.*'])
  })
})

describe('PUT /api/auth/roles/acl: a super admin is unaffected', () => {
  it('writes another tenant\'s role, the super admin flag, any feature and any organisation', async () => {
    asSuperAdmin()
    const res = await put({ roleId: ROLE_B, tenantId: TENANT_B, isSuperAdmin: true, features: ['*', 'directory.tenants.manage'], organizations: [ORG_B, ORG_A] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, sanitized: false })
    expect(persisted[0]).toMatchObject({
      tenantId: TENANT_B, isSuperAdmin: true, featuresJson: ['*', 'directory.tenants.manage'], organizationsJson: [ORG_B, ORG_A],
    })
    expect(em.count).not.toHaveBeenCalled()
    expect(invalidateTenantCache).toHaveBeenCalledWith(TENANT_B)
  })

  it('switches a super admin row off', async () => {
    asSuperAdmin()
    acls.set(aclKey(ROLE_A, TENANT_A), { role: { id: ROLE_A }, tenantId: TENANT_A, isSuperAdmin: true, featuresJson: [] })
    const res = await put({ roleId: ROLE_A, tenantId: TENANT_A, isSuperAdmin: false, features: ['customers.*'] })
    expect(res.status).toBe(200)
    expect(persisted[0]).toMatchObject({ isSuperAdmin: false, featuresJson: ['customers.*'] })
  })
})

describe('GET /api/auth/roles/acl: a tenant admin reads its own tenant only', () => {
  function get(query: string) {
    return GET(new Request(`http://x/api/auth/roles/acl?${query}`))
  }

  it('reads its own role\'s ACL', async () => {
    asTenantAdmin()
    acls.set(aclKey(ROLE_A, TENANT_A), { role: { id: ROLE_A }, tenantId: TENANT_A, isSuperAdmin: false, featuresJson: ['customers.*'], organizationsJson: null })
    const res = await get(`roleId=${ROLE_A}&tenantId=${TENANT_A}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ isSuperAdmin: false, features: ['customers.*'], organizations: null })
  })

  it('refuses another tenant\'s role', async () => {
    asTenantAdmin()
    const res = await get(`roleId=${ROLE_B}`)
    expect(res.status).toBe(403)
  })

  it('refuses reading a global role\'s ACL row of another tenant', async () => {
    asTenantAdmin()
    acls.set(aclKey(ROLE_GLOBAL, TENANT_B), { role: { id: ROLE_GLOBAL }, tenantId: TENANT_B, isSuperAdmin: false, featuresJson: ['sales.*'], organizationsJson: [ORG_B] })
    const res = await get(`roleId=${ROLE_GLOBAL}&tenantId=${TENANT_B}`)
    expect(res.status).toBe(403)
  })

  it('lets a super admin read any tenant', async () => {
    asSuperAdmin()
    acls.set(aclKey(ROLE_B, TENANT_B), { role: { id: ROLE_B }, tenantId: TENANT_B, isSuperAdmin: false, featuresJson: ['sales.*'], organizationsJson: [ORG_B] })
    const res = await get(`roleId=${ROLE_B}&tenantId=${TENANT_B}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ isSuperAdmin: false, features: ['sales.*'], organizations: [ORG_B] })
  })
})
