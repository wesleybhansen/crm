/* Platform admin user search: users.email is encrypted at rest, so search
 * matches the lookup hash and each row is decrypted in its own scope. */
import { query, queryOne } from '@/lib/db'
import { decryptRowFieldsByRowScope } from '@open-mercato/shared/lib/encryption/decryptRows'
import { computeEmailHash } from '@open-mercato/core/modules/auth/lib/emailHash'

jest.mock('@/lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }))
jest.mock('../auth', () => ({ getAdminAuth: jest.fn(async () => ({ userId: 'root', email: 'root@noli.test' })) }))
jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  decryptRowFieldsByRowScope: jest.fn(async (_em: unknown, _key: string, rows: Array<Record<string, unknown>>) => {
    for (const row of rows) row.email = `plain-for-${String(row.scope_tenant_id)}`
    return rows
  }),
}))

import { GET } from '../users/route'

describe('GET /admin/users', () => {
  it('matches email by hash (never ILIKE on ciphertext) and decrypts per row scope', async () => {
    jest.mocked(queryOne).mockResolvedValue({ total: 1 })
    jest.mocked(query).mockResolvedValue([
      { id: 'u1', name: 'Ann', email: 'v1:cipher', scope_tenant_id: 't1', scope_org_id: 'o1' },
    ])
    const url = new URL('http://localhost/api/admin/users?search=Ann@Example.com')
    const res = await GET({ nextUrl: url } as never)
    const json = await res.json()
    const [sql, params] = jest.mocked(query).mock.calls[0]!
    expect(String(sql)).not.toMatch(/email ILIKE/i)
    expect(String(sql)).toContain('u.email_hash = $2')
    expect(params).toContain(computeEmailHash('ann@example.com'))
    expect(decryptRowFieldsByRowScope).toHaveBeenCalledWith(null, 'auth:user', expect.any(Array), ['email'], {
      tenantColumn: 'scope_tenant_id',
      orgColumn: 'scope_org_id',
    })
    expect(json.data[0].email).toBe('plain-for-t1')
    expect(json.data[0]).not.toHaveProperty('scope_tenant_id')
    // One tenant per customer: the platform view shows each user's tenant, and
    // a role name only counts when the role belongs to that tenant.
    expect(String(sql)).toContain('u.tenant_id, u.organization_id')
    expect(String(sql)).toContain('r.tenant_id = u.tenant_id')
  })
})
