import http from 'node:http'
import crypto from 'node:crypto'
import { test, expect } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/modules/core/__integration__/helpers/api'

/**
 * TC-WEBHOOKS-001: subscribe and receive
 *
 * Creates a webhook subscription targeting a local HTTP server on a
 * random port, triggers the internal event (by creating a person
 * contact), and asserts the server received exactly one POST with a
 * matching event ID and valid HMAC-SHA256 signature.
 */
test.describe('TC-WEBHOOKS-001: subscribe and receive', () => {
  let token: string
  const createdSubIds: string[] = []
  const createdPeopleIds: string[] = []

  test.beforeAll(async ({ request }) => {
    token = await getAuthToken(request)
  })

  test.afterAll(async ({ request }) => {
    for (const id of createdSubIds) {
      await apiRequest(request, 'DELETE', `/api/webhooks/subscriptions?id=${id}`, { token }).catch(() => {})
    }
    for (const id of createdPeopleIds) {
      await apiRequest(request, 'DELETE', `/api/customers/people?id=${id}`, { token }).catch(() => {})
    }
  })

  test('contact.created fires and signature verifies', async ({ request }) => {
    const received: Array<{ event: string; body: string; signature: string | null }> = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        received.push({
          event: (req.headers['x-webhook-event'] as string) || '',
          body,
          signature: (req.headers['x-webhook-signature'] as string) || null,
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })
    const targetUrl = `http://127.0.0.1:${port}/hook`

    // 1. Create subscription
    const subRes = await apiRequest(request, 'POST', '/api/webhooks/subscriptions', {
      token,
      data: { event: 'contact.created', targetUrl },
    })
    expect(subRes.ok()).toBeTruthy()
    const subBody = await subRes.json()
    const subId = subBody.data.id as string
    const secret = subBody.data.secret as string
    createdSubIds.push(subId)
    expect(secret).toBeTruthy()

    // 2. Trigger the event
    const suffix = Date.now()
    const personRes = await apiRequest(request, 'POST', '/api/customers/people', {
      token,
      data: {
        firstName: 'Hook',
        lastName: `Test${suffix}`,
        displayName: `Hook Test${suffix}`,
        primaryEmail: `hook.test+${suffix}@test.local`,
      },
    })
    expect(personRes.ok()).toBeTruthy()
    const personBody = await personRes.json()
    createdPeopleIds.push(personBody.id as string)

    // 3. Wait for async delivery (dispatch is fire-and-forget)
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && received.length === 0) {
      await new Promise((r) => setTimeout(r, 200))
    }
    server.close()

    expect(received.length).toBe(1)
    expect(received[0].event).toBe('contact.created')

    // 4. Verify signature
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(received[0].body).digest('hex')
    expect(received[0].signature).toBe(expected)
  })
})
