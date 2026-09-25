/* Team list: users.email is encrypted at rest per workspace, so the raw read
 * must be decrypted in the caller's own scope before it reaches the Team row. */
import { query, queryOne } from '@/lib/db'
import { decryptRowFields } from '@open-mercato/shared/lib/encryption/decryptRows'
import { computeEmailHash } from '@open-mercato/core/modules/auth/lib/emailHash'

jest.mock('@/lib/db', () => ({ query: jest.fn(), queryOne: jest.fn() }))
jest.mock('@/modules/email/lib/platform-sender', () => ({ sendPlatformNotification: jest.fn(async () => ({ ok: true })) }))
jest.mock('../auth', () => ({
  ...jest.requireActual('../auth'),
  getTeamAuth: jest.fn(async () => ({
    userId: 'owner-a',
    tenantId: 't-1',
    orgId: 'o-1',
    email: 'owner@a.test',
    roleName: 'admin',
    isOwner: true,
    maxSeats: 5,
  })),
}))
jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  decryptRowFields: jest.fn(async (_em: unknown, _key: string, rows: Array<Record<string, unknown>>) => {
    for (const row of rows) if (row.email === 'iv:ct:tag:v1') row.email = 'owner@a.test'
    return rows
  }),
}))

import { GET, POST } from '../route'

beforeEach(() => jest.clearAllMocks())

describe('GET /team', () => {
  it('decrypts member emails in the caller workspace scope', async () => {
    jest.mocked(query)
      .mockResolvedValueOnce([{ id: 'owner-a', name: 'Wesley', email: 'iv:ct:tag:v1', role_name: 'admin', is_owner: true }])
      .mockResolvedValueOnce([])
    jest.mocked(queryOne).mockResolvedValue({ active_users: 1, pending_invites: 0 })
    const res = await GET()
    const json = await res.json()
    expect(decryptRowFields).toHaveBeenCalledWith(null, 'auth:user', expect.any(Array), ['email'], 't-1', 'o-1')
    expect(json.data.members[0].email).toBe('owner@a.test')
  })
})

describe('POST /team', () => {
  it('detects an existing member through the email hash, not the ciphertext column alone', async () => {
    jest.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('active_users')) return { active_users: 1, pending_invites: 0 }
      if (sql.includes('email_hash')) return { id: 'u-2' }
      return null
    })
    const req = new Request('http://localhost/api/team', {
      method: 'POST',
      body: JSON.stringify({ email: 'Ann@Example.com', role: 'member' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(409)
    const call = jest.mocked(queryOne).mock.calls.find(([sql]) => String(sql).includes('email_hash'))!
    expect(String(call[0])).toContain('email_hash = $3')
    expect(call[1]).toContain(computeEmailHash('ann@example.com'))
  })
})
