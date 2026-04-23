import { test, expect } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/modules/core/__integration__/helpers/api'

/**
 * TC-SCOPES-001: A scoped key allows only its scoped feature
 *
 * Admin-role key with scopes=['customers.people.view']:
 *   - GET /api/customers/people → 200 (scope matches)
 *   - POST /api/customers/people → 403 (role allows but scope doesn't)
 *   - GET /api/customers/deals → 403 (scope doesn't match)
 */
test.describe('TC-SCOPES-001: narrow key allow/deny', () => {
  let adminToken: string
  let apiKey: string
  let apiKeyId: string

  test.beforeAll(async ({ request }) => {
    adminToken = await getAuthToken(request)
    const res = await apiRequest(request, 'POST', '/api/api-keys', {
      token: adminToken,
      data: {
        name: `scopes-narrow-${Date.now()}`,
        rateLimitTier: 'unlimited',
        scopes: ['customers.people.view'],
      },
    })
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    apiKey = body.secret as string
    apiKeyId = body.id as string
  })

  test.afterAll(async ({ request }) => {
    if (apiKeyId) await apiRequest(request, 'DELETE', `/api/api-keys?id=${apiKeyId}`, { token: adminToken }).catch(() => {})
  })

  test('GET on the scoped feature returns 200', async ({ request }) => {
    const baseURL = process.env.BASE_URL || 'http://localhost:3000'
    const res = await request.fetch(`${baseURL}/api/customers/people?pageSize=1`, { headers: { 'x-api-key': apiKey } })
    expect(res.status()).toBe(200)
  })

  test('POST on an out-of-scope manage feature returns 403', async ({ request }) => {
    const baseURL = process.env.BASE_URL || 'http://localhost:3000'
    const res = await request.fetch(`${baseURL}/api/customers/people`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      data: { displayName: 'Scope Test', firstName: 'Scope', lastName: 'Test', primaryEmail: `scope+${Date.now()}@test.local` },
    })
    expect(res.status()).toBe(403)
    const body = await res.json()
    expect(body.error).toContain('not scoped')
  })

  test('GET on a completely different resource returns 403', async ({ request }) => {
    const baseURL = process.env.BASE_URL || 'http://localhost:3000'
    const res = await request.fetch(`${baseURL}/api/customers/deals?pageSize=1`, { headers: { 'x-api-key': apiKey } })
    expect(res.status()).toBe(403)
  })
})
