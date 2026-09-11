/** @jest-environment node */

/*
 * Disconnecting must scrub the credential, not just flip is_active. A row left
 * holding a live Twilio auth token is still a usable credential to anyone who
 * reads the table (a backup, a dump, a support query).
 */

const mockGetAuthFromCookies = jest.fn()
const mockCreateRequestContainer = jest.fn()

type Update = { table: string; filters: Array<[string, unknown]>; data: Record<string, unknown> }
const updates: Update[] = []

function createKnex() {
  return (table: string) => {
    const filters: Array<[string, unknown]> = []
    const query: Record<string, unknown> = {
      where: jest.fn((field: string, value: unknown) => {
        filters.push([field, value])
        return query
      }),
      first: jest.fn(async () => undefined),
      update: jest.fn(async (data: Record<string, unknown>) => {
        updates.push({ table, filters, data })
        return 1
      }),
    }
    return query
  }
}

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromCookies: (...args: unknown[]) => mockGetAuthFromCookies(...args),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))

import { DELETE } from '../route'

const orgId = '33333333-3333-4333-8333-333333333333'
const tenantId = '44444444-4444-4444-8444-444444444444'

describe('twilio disconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    updates.length = 0
    mockGetAuthFromCookies.mockResolvedValue({ sub: 'u1', orgId, tenantId })
    mockCreateRequestContainer.mockResolvedValue({
      resolve: (name: string) => {
        if (name === 'em') return { getKnex: () => createKnex() }
        return null
      },
    })
  })

  it('scrubs the auth token and deactivates, scoped to the caller org', async () => {
    const res = await DELETE()
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })

    const twilioUpdate = updates.find((u) => u.table === 'twilio_connections')
    expect(twilioUpdate).toBeDefined()
    expect(twilioUpdate!.filters).toContainEqual(['organization_id', orgId])
    expect(twilioUpdate!.data).toMatchObject({ is_active: false })
    // auth_token is NOT NULL, so '' is the scrubbed value.
    expect(twilioUpdate!.data.auth_token).toBe('')
  })

  it('refuses an unauthenticated caller without touching the table', async () => {
    mockGetAuthFromCookies.mockResolvedValue(null)
    const res = await DELETE()
    expect(res.status).toBe(401)
    expect(updates).toHaveLength(0)
  })
})
