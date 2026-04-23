import { test, expect } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/modules/core/__integration__/helpers/api'

/**
 * TC-RATELIMIT-003: unlimited tier skips the limiter
 *
 * Issue 80 API-key calls against an "unlimited" tier key (exceeds default
 * minute cap of 60). All must succeed. Also asserts the policy header
 * advertises the unlimited tier.
 */
test.describe('TC-RATELIMIT-003: unlimited tier', () => {
  let adminToken: string
  let apiKey: string
  let apiKeyId: string

  test.beforeAll(async ({ request }) => {
    adminToken = await getAuthToken(request)
    const res = await apiRequest(request, 'POST', '/api/api-keys', {
      token: adminToken,
      data: { name: `ratelimit-unlimited-${Date.now()}`, rateLimitTier: 'unlimited' },
    })
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    apiKey = body.secret as string
    apiKeyId = body.id as string
  })

  test.afterAll(async ({ request }) => {
    if (apiKeyId) await apiRequest(request, 'DELETE', `/api/api-keys?id=${apiKeyId}`, { token: adminToken }).catch(() => {})
  })

  test('80 calls all succeed on unlimited tier', async ({ request }) => {
    const baseURL = process.env.BASE_URL || 'http://localhost:3000'
    const url = `${baseURL}/api/webhooks/events`
    const results: Array<{ status: number; policy: string | null }> = []
    for (let i = 0; i < 80; i++) {
      const r = await request.fetch(url, { headers: { 'x-api-key': apiKey } })
      results.push({ status: r.status(), policy: r.headers()['ratelimit-policy'] ?? null })
    }
    expect(results.filter((r) => r.status === 429).length).toBe(0)
    expect(results.every((r) => r.status === 200)).toBe(true)
    const sample = results.find((r) => r.policy)
    expect(sample?.policy).toContain('unlimited')
  })
})
