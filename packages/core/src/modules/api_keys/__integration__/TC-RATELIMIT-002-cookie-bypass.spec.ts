import { test, expect } from '@playwright/test'
import { login } from '@open-mercato/core/modules/core/__integration__/helpers/auth'

/**
 * TC-RATELIMIT-002: Cookie-auth requests bypass the API-key limiter
 *
 * The internal UI uses cookie auth. Rate-limit middleware only runs when
 * auth.isApiKey is true. Verify that 100 cookie-auth calls in a minute
 * all succeed without 429.
 */
test.describe('TC-RATELIMIT-002: cookie-auth bypass', () => {
  test('100 cookie calls do not produce 429', async ({ page }) => {
    await login(page, 'admin')
    const url = '/api/webhooks/events'
    const statuses: number[] = []
    for (let i = 0; i < 100; i++) {
      const res = await page.request.fetch(url)
      statuses.push(res.status())
    }
    expect(statuses.filter((s) => s === 429).length).toBe(0)
  })
})
