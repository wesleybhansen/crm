import { test, expect } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/modules/core/__integration__/helpers/api'

/**
 * TC-WEBHOOKS-003: secret rotation
 *
 * Rotate a subscription's secret and assert the new value differs from
 * the old one. (Signature validity is covered by TC-WEBHOOKS-001.)
 */
test.describe('TC-WEBHOOKS-003: secret rotation', () => {
  let token: string
  const createdSubIds: string[] = []

  test.beforeAll(async ({ request }) => {
    token = await getAuthToken(request)
  })

  test.afterAll(async ({ request }) => {
    for (const id of createdSubIds) {
      await apiRequest(request, 'DELETE', `/api/webhooks/subscriptions?id=${id}`, { token }).catch(() => {})
    }
  })

  test('POST /subscriptions/:id/rotate-secret returns a new secret', async ({ request }) => {
    const subRes = await apiRequest(request, 'POST', '/api/webhooks/subscriptions', {
      token,
      data: { event: 'webhooks.test', targetUrl: 'https://example.invalid/hook' },
    })
    expect(subRes.ok()).toBeTruthy()
    const subBody = await subRes.json()
    const subId = subBody.data.id as string
    const originalSecret = subBody.data.secret as string
    createdSubIds.push(subId)

    const rotateRes = await apiRequest(request, 'POST', `/api/webhooks/subscriptions/${subId}/rotate-secret`, { token })
    expect(rotateRes.ok()).toBeTruthy()
    const rotateBody = await rotateRes.json()
    const newSecret = rotateBody.data.secret as string
    expect(newSecret).toBeTruthy()
    expect(newSecret).not.toBe(originalSecret)
    expect(newSecret.startsWith('whsec_')).toBe(true)
  })
})
