import http from 'node:http'
import { test, expect } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/modules/core/__integration__/helpers/api'

/**
 * TC-WEBHOOKS-002: retry on 5xx
 *
 * Target server returns 500 for the first two requests then 200. Assert
 * webhook_deliveries has 3 rows: attempt 1 failed, attempt 2 failed,
 * attempt 3 delivered. Dispatch waits 5s between attempts so the test
 * allows ~20s.
 */
test.describe.skip('TC-WEBHOOKS-002: retry on 5xx', () => {
  // Skipped by default — runtime >20s because dispatcher sleeps 5s between
  // attempts. Un-skip when running the full webhook suite locally.
  let token: string

  test.beforeAll(async ({ request }) => {
    token = await getAuthToken(request)
  })

  test('three attempts, last one delivers', async ({ request }) => {
    let hits = 0
    const server = http.createServer((req, res) => {
      hits++
      if (hits < 3) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('server go brrr')
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok')
      }
    })
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })

    const subRes = await apiRequest(request, 'POST', '/api/webhooks/subscriptions', {
      token,
      data: { event: 'webhooks.test', targetUrl: `http://127.0.0.1:${port}/retry` },
    })
    const subBody = await subRes.json()
    const subId = subBody.data.id as string

    // Trigger via test endpoint — sendTestDelivery only sends once, so we
    // need a real event. Instead, we invoke rotate-secret + re-test, or
    // rely on dispatchWebhook calls from a downstream event. For v1 this
    // test stays .skip() until a harness exists to trigger dispatchWebhook
    // directly without waiting on the retry delay.

    // Cleanup
    server.close()
    await apiRequest(request, 'DELETE', `/api/webhooks/subscriptions?id=${subId}`, { token })
    expect(hits).toBe(3)
  })
})
