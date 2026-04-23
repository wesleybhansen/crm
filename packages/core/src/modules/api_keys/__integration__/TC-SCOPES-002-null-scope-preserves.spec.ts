import { test, expect } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/modules/core/__integration__/helpers/api'

/**
 * TC-SCOPES-002: Keys without scopes keep full role permissions
 *
 * Key created with scopes=null behaves exactly like pre-Phase-4:
 * role features alone decide access. Backward-compat guard.
 */
test.describe('TC-SCOPES-002: null scope preserves v1 behavior', () => {
  let adminToken: string
  let apiKey: string
  let apiKeyId: string

  test.beforeAll(async ({ request }) => {
    adminToken = await getAuthToken(request)
    const res = await apiRequest(request, 'POST', '/api/api-keys', {
      token: adminToken,
      data: { name: `scopes-null-${Date.now()}`, rateLimitTier: 'unlimited' },
    })
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    apiKey = body.secret as string
    apiKeyId = body.id as string
  })

  test.afterAll(async ({ request }) => {
    if (apiKeyId) await apiRequest(request, 'DELETE', `/api/api-keys?id=${apiKeyId}`, { token: adminToken }).catch(() => {})
  })

  test('GET /api/customers/people returns 200 (full role access)', async ({ request }) => {
    const baseURL = process.env.BASE_URL || 'http://localhost:3000'
    const res = await request.fetch(`${baseURL}/api/customers/people?pageSize=1`, { headers: { 'x-api-key': apiKey } })
    expect(res.status()).toBe(200)
  })

  test('GET /api/customers/deals returns 200 (full role access)', async ({ request }) => {
    const baseURL = process.env.BASE_URL || 'http://localhost:3000'
    const res = await request.fetch(`${baseURL}/api/customers/deals?pageSize=1`, { headers: { 'x-api-key': apiKey } })
    expect(res.status()).toBe(200)
  })
})
