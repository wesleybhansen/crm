/** @jest-environment node */

const mockFindNoliUserById = jest.fn()
const mockResolveClerkUserToAuthContext = jest.fn()
const mockCreateRequestContainer = jest.fn()

type QueryScope = {
  table: string
  filters: Array<[string, unknown]>
  nulls: string[]
}

const queryScopes: QueryScope[] = []
let dealRow: unknown
let contactRow: unknown

function createKnex() {
  const knex = ((table: string) => {
    const scope: QueryScope = { table, filters: [], nulls: [] }
    queryScopes.push(scope)
    const query = {
      where: jest.fn((field: string, value: unknown) => {
        scope.filters.push([field, value])
        return query
      }),
      whereNull: jest.fn((field: string) => {
        scope.nulls.push(field)
        return query
      }),
      select: jest.fn(() => query),
      count: jest.fn(() => query),
      first: jest.fn(async () => (table === 'customer_deals' ? dealRow : contactRow)),
    }
    return query
  }) as ((table: string) => unknown) & { raw: (sql: string) => string }
  knex.raw = (sql: string) => sql
  return knex
}

jest.mock('@open-mercato/shared/lib/noli/core-client', () => ({
  findNoliUserById: (...args: unknown[]) => mockFindNoliUserById(...args),
}))

jest.mock('@open-mercato/shared/lib/auth/clerk', () => ({
  resolveClerkUserToAuthContext: (...args: unknown[]) => mockResolveClerkUserToAuthContext(...args),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))

import { POST } from '../route'

const originalEnv = process.env
const serviceSecret = 'test-internal-service-secret'
const noliUserId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const tenantId = '33333333-3333-4333-8333-333333333333'

function request(body: unknown, authorization = `Bearer ${serviceSecret}`): Request {
  return new Request('http://localhost/api/internal/cos-metrics', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('CRM internal COS metrics boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    queryScopes.length = 0
    dealRow = { total_deals: '7', open_deals: '3' }
    contactRow = { total_contacts: '11' }
    process.env = { ...originalEnv, NOLI_INTERNAL_SERVICE_SECRET: serviceSecret }
    mockFindNoliUserById.mockResolvedValue({ clerk_user_id: 'clerk-user-1' })
    mockResolveClerkUserToAuthContext.mockResolvedValue({ orgId: organizationId, tenantId })
    mockCreateRequestContainer.mockResolvedValue({
      resolve: () => ({ getKnex: () => createKnex() }),
    })
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('authenticates before parsing identity or touching dependencies', async () => {
    const response = await POST(request({}, 'Bearer wrong'))
    expect(response.status).toBe(401)
    expect(mockFindNoliUserById).not.toHaveBeenCalled()
    expect(mockCreateRequestContainer).not.toHaveBeenCalled()
  })

  it.each([
    [{ noliUserId, organizationId: '' }],
    [{ noliUserId: 'bad id', organizationId }],
    [{ noliUserId, organizationId: 'x'.repeat(129) }],
  ])('rejects an invalid bounded identity scope before dependency access', async (body) => {
    const response = await POST(request(body))
    expect(response.status).toBe(400)
    expect(mockFindNoliUserById).not.toHaveBeenCalled()
    expect(mockCreateRequestContainer).not.toHaveBeenCalled()
  })

  it('refuses a current-organization mismatch before database access', async () => {
    mockResolveClerkUserToAuthContext.mockResolvedValue({ orgId: 'another-org', tenantId })
    const response = await POST(request({ noliUserId, organizationId }))
    expect(response.status).toBe(403)
    expect(mockCreateRequestContainer).not.toHaveBeenCalled()
  })

  it('returns only exact counts from organization-and-tenant-scoped reads', async () => {
    const response = await POST(request({ noliUserId, organizationId }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0')
    const body = await response.json() as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.data).toEqual({ openDeals: 3, totalDeals: 7, totalContacts: 11 })
    expect(typeof body.asOf).toBe('string')
    expect(queryScopes).toHaveLength(2)
    for (const scope of queryScopes) {
      expect(scope.filters).toEqual(expect.arrayContaining([
        ['organization_id', organizationId],
        ['tenant_id', tenantId],
      ]))
      expect(scope.nulls).toEqual(['deleted_at'])
    }
  })

  it('fails closed without private detail when a projection is ambiguous', async () => {
    dealRow = { total_deals: 'not-a-count', open_deals: '3' }
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = await POST(request({ noliUserId, organizationId }))
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'cos_metrics_unavailable' })
    expect(consoleSpy).toHaveBeenCalledWith('[internal.cos-metrics] cos_metrics_unavailable')
    consoleSpy.mockRestore()
  })
})
