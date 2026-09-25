/* Invite accept in the shared tenant: never grant super-admin, never move or
 * take over an existing account, store the email encrypted. */
import { query, queryOne } from '@/lib/db'
import { encryptRowForRawWrite } from '@open-mercato/shared/lib/encryption/rawWrite'

jest.mock('@/lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }))
jest.mock('@open-mercato/shared/lib/auth/jwt', () => ({ signJwt: jest.fn(() => 'jwt-token') }))
jest.mock('@open-mercato/shared/lib/encryption/rawWrite', () => ({
  encryptRowForRawWrite: jest.fn(async (_entity: string, row: Record<string, unknown>) => ({
    ...row,
    email: `enc(${String(row.email)})`,
  })),
}))

import { POST } from '../route'

const TENANT = '22560ecc-0000-4000-8000-000000000000'
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000001'

type World = {
  invite: Record<string, unknown> | null
  existingUser: Record<string, unknown> | null
  roles: Record<string, { id: string; aclSuper: boolean | null }>
  /** Tenant the invite's organization lives in today (defaults to the invite's). */
  orgTenant?: string | null
}

const mockQuery = jest.mocked(query)
const mockQueryOne = jest.mocked(queryOne)

function install(world: World) {
  mockQueryOne.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM team_invites')) return world.invite
    if (sql.includes('FROM users')) return world.existingUser
    if (sql.includes('FROM organizations')) {
      const tenant = world.orgTenant === undefined ? world.invite?.tenant_id : world.orgTenant
      return tenant ? { tenant_id: tenant } : null
    }
    if (sql.includes('FROM roles')) {
      const role = world.roles[String(params?.[1])]
      return role ? { id: role.id } : null
    }
    if (sql.includes('FROM role_acls')) {
      const role = Object.values(world.roles).find((r) => r.id === params?.[0])
      if (!role || role.aclSuper === null) return null
      return { id: `acl-${role.id}`, is_super_admin: role.aclSuper }
    }
    return null
  })
  mockQuery.mockResolvedValue([])
}

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/invite/accept', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

const allSql = () => mockQuery.mock.calls.map(([sql]) => String(sql))
const body = { token: 'tok', name: 'Ann', password: 'correct-horse' }
const invite = (role: string) => ({ id: 'inv-1', email: 'Ann@Example.com', role, organization_id: ORG_A, tenant_id: TENANT })

describe('POST /invite/accept (shared tenant)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('admin invite uses the seeded admin role and never grants is_super_admin', async () => {
    install({ invite: invite('admin'), existingUser: null, roles: { admin: { id: 'role-admin', aclSuper: false } } })
    const res = await POST(request(body))
    expect(res.status).toBe(200)
    const sql = allSql()
    expect(sql.some((s) => s.includes('INSERT INTO role_acls'))).toBe(false)
    expect(sql.some((s) => s.includes('INSERT INTO roles'))).toBe(false)
    expect(sql.some((s) => /is_super_admin[^]*true/i.test(s))).toBe(false)
    const roleInsert = mockQuery.mock.calls.find(([s]) => String(s).includes('INSERT INTO user_roles'))
    expect(roleInsert?.[1]?.[2]).toBe('role-admin')
  })

  it('refuses to hand out an admin role whose ACL is super admin', async () => {
    install({ invite: invite('admin'), existingUser: null, roles: { admin: { id: 'role-admin', aclSuper: true } } })
    const res = await POST(request(body))
    expect(res.status).toBe(500)
    expect(allSql().some((s) => s.includes('INSERT INTO users'))).toBe(false)
  })

  it('refuses when the tenant has no seeded admin role (does not create one)', async () => {
    install({ invite: invite('admin'), existingUser: null, roles: {} })
    const res = await POST(request(body))
    expect(res.status).toBe(500)
    expect(allSql().some((s) => s.includes('INSERT INTO roles') || s.includes('INSERT INTO role_acls'))).toBe(false)
  })

  it('member role is created without super-admin rights when missing', async () => {
    install({ invite: invite('member'), existingUser: null, roles: {} })
    const res = await POST(request(body))
    expect(res.status).toBe(200)
    const aclInsert = mockQuery.mock.calls.find(([s]) => String(s).includes('INSERT INTO role_acls'))
    expect(String(aclInsert?.[0])).toContain('false')
  })

  it('stores the new user email through the encrypting path, with its hash', async () => {
    install({ invite: invite('admin'), existingUser: null, roles: { admin: { id: 'role-admin', aclSuper: false } } })
    await POST(request(body))
    expect(encryptRowForRawWrite).toHaveBeenCalledWith('auth:user', expect.objectContaining({ email: 'ann@example.com' }), TENANT, ORG_A)
    const insert = mockQuery.mock.calls.find(([s]) => String(s).includes('INSERT INTO users'))
    expect(insert?.[1]?.[3]).toBe('enc(ann@example.com)')
    expect(typeof insert?.[1]?.[4]).toBe('string')
    expect(insert?.[1]?.[4]).not.toBe('ann@example.com')
  })

  it('refuses an existing account on a different tenant instead of rewriting it', async () => {
    install({
      invite: invite('admin'),
      existingUser: { id: 'user-x', tenant_id: 'other-tenant', organization_id: 'other-org' },
      roles: { admin: { id: 'role-admin', aclSuper: false } },
    })
    const res = await POST(request(body))
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toMatch(/different tenant/)
    expect(allSql().some((s) => s.startsWith('UPDATE users') || s.includes('INSERT INTO users'))).toBe(false)
  })

  it('refuses an existing account from another customer in the same tenant (no takeover, no sign-in)', async () => {
    install({
      invite: invite('admin'),
      existingUser: { id: 'user-b', tenant_id: TENANT, organization_id: ORG_B },
      roles: { admin: { id: 'role-admin', aclSuper: false } },
    })
    const res = await POST(request(body))
    expect(res.status).toBe(409)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(allSql().some((s) => s.includes('UPDATE users') || s.includes('user_roles'))).toBe(false)
  })

  it('refuses an invite whose organization has moved to another tenant since it was sent', async () => {
    install({
      invite: invite('admin'),
      existingUser: null,
      roles: { admin: { id: 'role-admin', aclSuper: false } },
      orgTenant: '33333333-0000-4000-8000-000000000000',
    })
    const res = await POST(request(body))
    expect(res.status).toBe(400)
    expect(allSql().some((s) => s.includes('INSERT INTO users') || s.includes('user_roles'))).toBe(false)
  })
})
