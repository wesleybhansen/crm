/** @jest-environment node */

const mockFindNoliUserById = jest.fn()
const mockResolveClerkUserToAuthContext = jest.fn()
const mockCreateRequestContainer = jest.fn()
const mockSendReply = jest.fn()
const mockAllowance = jest.fn()

jest.mock('@open-mercato/shared/lib/noli/core-client', () => ({
  findNoliUserById: (...args: unknown[]) => mockFindNoliUserById(...args),
}))
jest.mock('@open-mercato/shared/lib/auth/clerk', () => ({
  resolveClerkUserToAuthContext: (...args: unknown[]) => mockResolveClerkUserToAuthContext(...args),
}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))
jest.mock('@/modules/customers/lib/send-reply', () => ({
  sendReply: (...args: unknown[]) => mockSendReply(...args),
}))
jest.mock('@/lib/usage/allowance', () => ({
  checkCustomersAiAllowance: (...args: unknown[]) => mockAllowance(...args),
}))
jest.mock('@/lib/usage/meter', () => ({ meterCustomersAi: jest.fn() }))

import { POST } from '../route'

const secret = 'test-internal-service-secret'
const initiativeId = '55555555-5555-4555-8555-555555555555'
const originalEnv = process.env

/** A chainable stand-in for knex: every builder call returns the chain; the
 *  terminal calls resolve per table. `failTables` makes a table's read reject. */
function createKnex(failTables: string[] = []) {
  const tables: string[] = []
  const knex: any = (table: string) => {
    tables.push(table)
    const chain: any = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return undefined
          if (prop === 'select' || prop === 'orderBy' || prop === 'limit') {
            return () => {
              const result = failTables.includes(table) ? Promise.reject(new Error('down')) : Promise.resolve([])
              return Object.assign(result, { limit: () => result, orderBy: () => result })
            }
          }
          if (prop === 'first') return async () => ({ n: 0 })
          if (prop === 'update') return async () => 0
          return () => chain
        },
      },
    )
    return chain
  }
  knex.raw = (sql: string) => sql
  knex.transaction = async (fn: (trx: any) => Promise<void>) => fn(knex)
  return { knex, tables }
}

function request(body: Record<string, unknown>, authorization = `Bearer ${secret}`): Request {
  return new Request('http://localhost/api/internal/reactivation', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  process.env = { ...originalEnv, NOLI_INTERNAL_SERVICE_SECRET: secret }
  jest.clearAllMocks()
  mockFindNoliUserById.mockResolvedValue({ clerk_user_id: 'user_clerk' })
  mockResolveClerkUserToAuthContext.mockResolvedValue({ userId: 'u', orgId: 'org', tenantId: 'tenant' })
})
afterAll(() => {
  process.env = originalEnv
})

describe('internal reactivation route', () => {
  it('rejects a wrong or missing service secret', async () => {
    expect((await POST(request({ op: 'candidates', noliUserId: 'n' }, 'Bearer nope'))).status).toBe(401)
    delete process.env.NOLI_INTERNAL_SERVICE_SECRET
    expect((await POST(request({ op: 'candidates', noliUserId: 'n' }))).status).toBe(401)
  })

  it('requires a known op and a user', async () => {
    expect((await POST(request({ op: 'send-everything', noliUserId: 'n' }))).status).toBe(400)
    expect((await POST(request({ op: 'candidates' }))).status).toBe(400)
  })

  it('returns 404 when the user has no CRM account', async () => {
    mockResolveClerkUserToAuthContext.mockResolvedValue(null)
    expect((await POST(request({ op: 'candidates', noliUserId: 'n' }))).status).toBe(404)
  })

  it('validates draft input before spending anything', async () => {
    const { knex } = createKnex()
    mockCreateRequestContainer.mockResolvedValue({ resolve: () => ({ getKnex: () => knex }) })
    const badId = await POST(request({ op: 'draft', noliUserId: 'n', initiativeId: 'x', kind: 'check_in' }))
    expect(badId.status).toBe(400)
    const badKind = await POST(request({ op: 'draft', noliUserId: 'n', initiativeId, kind: 'sales_blast' }))
    expect(badKind.status).toBe(400)
    expect(mockAllowance).not.toHaveBeenCalled()
  })

  it('refuses to send anything when the unsubscribe list cannot be read', async () => {
    const { knex } = createKnex(['email_unsubscribes'])
    mockCreateRequestContainer.mockResolvedValue({ resolve: () => ({ getKnex: () => knex }) })
    const res = await POST(request({ op: 'send-batch', noliUserId: 'n', initiativeId, dailyCap: 5 }))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: 'suppression_list_unavailable' })
    expect(mockSendReply).not.toHaveBeenCalled()
  })

  it('sends nothing when there is nothing approved', async () => {
    const { knex } = createKnex()
    mockCreateRequestContainer.mockResolvedValue({ resolve: () => ({ getKnex: () => knex }) })
    const res = await POST(request({ op: 'send-batch', noliUserId: 'n', initiativeId, dailyCap: 5 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, sent: 0, remaining: 0, refused: [] })
    expect(mockSendReply).not.toHaveBeenCalled()
  })
})
