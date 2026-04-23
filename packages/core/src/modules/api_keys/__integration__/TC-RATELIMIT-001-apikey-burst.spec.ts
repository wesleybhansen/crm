import { test, expect } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/modules/core/__integration__/helpers/api'

/**
 * TC-RATELIMIT-001: API-key burst trips per-minute limit
 *
 * Default tier allows 60 req/min. Issue 62 rapid API-key calls and expect
 * at least one 429 with the IETF rate-limit headers + Retry-After.
 *
 * The test assumes a DEFAULT-tier key exists; it creates one via the
 * keys CRUD endpoint using the admin JWT, then bursts against a cheap
 * GET route.
 */
test.describe('TC-RATELIMIT-001: API-key burst', () => {
  let adminToken: string
  let apiKey: string
  let apiKeyId: string

  test.beforeAll(async ({ request }) => {
    adminToken = await getAuthToken(request)
    const res = await apiRequest(request, 'POST', '/api/api-keys', {
      token: adminToken,
      data: { name: `ratelimit-burst-${Date.now()}`, rateLimitTier: 'default' },
    })
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    apiKey = body.secret as string
    apiKeyId = body.id as string
    expect(apiKey).toBeTruthy()
  })

  test.afterAll(async ({ request }) => {
    if (apiKeyId) await apiRequest(request, 'DELETE', `/api/api-keys?id=${apiKeyId}`, { token: adminToken }).catch(() => {})
  })

  test('62 rapid calls produce at least one 429 with headers', async ({ request }) => {
    const baseURL = process.env.BASE_URL || 'http://localhost:3000'
    const url = `${baseURL}/api/webhooks/events` // cheap, cached endpoint
    const results: Array<{ status: number; retryAfter: string | null; limit: string | null; remaining: string | null }> = []
    for (let i = 0; i < 62; i++) {
      const r = await request.fetch(url, { headers: { 'x-api-key': apiKey } })
      results.push({
        status: r.status(),
        retryAfter: r.headers()['retry-after'] ?? null,
        limit: r.headers()['ratelimit-limit'] ?? null,
        remaining: r.headers()['ratelimit-remaining'] ?? null,
      })
    }
    const throttled = results.filter((r) => r.status === 429)
    expect(throttled.length).toBeGreaterThanOrEqual(1)
    const sample = throttled[0]
    expect(sample.retryAfter).toBeTruthy()
    expect(sample.limit).toBe('60')
    expect(sample.remaining).toBe('0')

    // Successful calls should carry the policy header
    const okCall = results.find((r) => r.status === 200)
    expect(okCall?.limit).toBe('60')
  })
})
