/* Team role change / member removal in the shared tenant: the target must be
 * a member of the caller's own workspace. */
import { query, queryOne } from '@/lib/db'

jest.mock('@/lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }))
jest.mock('../auth', () => ({
  ...jest.requireActual('../auth'),
  getTeamAuth: jest.fn(async () => ({
    userId: 'owner-a',
    tenantId: '22560ecc-0000-4000-8000-000000000000',
    orgId: 'aaaaaaaa-0000-4000-8000-000000000001',
    email: 'owner@a.test',
    roleName: 'admin',
    isOwner: true,
    maxSeats: 5,
  })),
}))

import { PUT as changeRole } from '../role/route'
import { DELETE as removeMember } from '../member/route'

const mockQuery = jest.mocked(query)
const mockQueryOne = jest.mocked(queryOne)
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001'

const users: Record<string, { org: string }> = {
  'user-a': { org: ORG_A },
  'user-b': { org: 'bbbbbbbb-0000-4000-8000-000000000001' },
}

beforeEach(() => {
  jest.clearAllMocks()
  mockQueryOne.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM users WHERE id = $1 AND organization_id = $2')) {
      const user = users[String(params?.[0])]
      return user && user.org === params?.[1] ? { id: params?.[0] } : null
    }
    if (sql.includes('FROM organizations')) return { owner_user_id: 'owner-a' }
    if (sql.includes('FROM roles')) return { id: 'role-member' }
    if (sql.includes('FROM role_acls')) return { id: 'acl-member', is_super_admin: false }
    return null
  })
  mockQuery.mockResolvedValue([])
})

const req = (method: string, body: Record<string, unknown>) =>
  new Request('http://localhost/api/team', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

describe('team routes: another customer\'s user', () => {
  it('role change on B\'s user is refused and touches no role rows', async () => {
    const res = await changeRole(req('PUT', { userId: 'user-b', role: 'member' }))
    expect(res.status).toBe(404)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('role change on an own member still works', async () => {
    const res = await changeRole(req('PUT', { userId: 'user-a', role: 'member' }))
    expect(res.status).toBe(200)
    expect(mockQuery.mock.calls.some(([s]) => String(s).includes('INSERT INTO user_roles'))).toBe(true)
  })

  it('removing B\'s user is refused and strips no roles or ACLs', async () => {
    const res = await removeMember(req('DELETE', { userId: 'user-b' }))
    expect(res.status).toBe(404)
    expect(mockQuery).not.toHaveBeenCalled()
  })
})
