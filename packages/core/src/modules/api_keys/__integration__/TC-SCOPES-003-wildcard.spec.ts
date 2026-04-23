import { test, expect } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/modules/core/__integration__/helpers/api'

/**
 * TC-SCOPES-003: Wildcard scopes work as expected
 *
 * Key with scopes=['customers.*'] allows all customer-module routes but
 * denies routes from other modules. Tests the prefix match path.
 */
test.describe('TC-SCOPES-003: wildcard scope', () => {
  let adminToken: string
  let apiKey: string
  let apiKeyId: string

  test.beforeAll(async ({ request }) => {
    adminToken = await getAuthToken(request)
    const res = await apiRequest(request, 'POST', '/api/api-keys', {
      token: adminToken,
      data: {
        name: `scopes-wildcard-${Date.now()}`,
        rateLimitTier: 'unlimited',
        scopes: ['customers.*'],
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

  test('any customers.* feature is allowed', async ({ request }) => {
    const baseURL = process.env.BASE_URL || 'http://localhost:3000'
    const people = await request.fetch(`${baseURL}/api/customers/people?pageSize=1`, { headers: { 'x-api-key': apiKey } })
    expect(people.status()).toBe(200)
    const deals = await request.fetch(`${baseURL}/api/customers/deals?pageSize=1`, { headers: { 'x-api-key': apiKey } })
    expect(deals.status()).toBe(200)
  })

  test('a non-customers route requires its own scope — 403', async ({ request }) => {
    const baseURL = process.env.BASE_URL || 'http://localhost:3000'
    const res = await request.fetch(`${baseURL}/api/webhooks/subscriptions`, { headers: { 'x-api-key': apiKey } })
    expect(res.status()).toBe(403)
  })
})
