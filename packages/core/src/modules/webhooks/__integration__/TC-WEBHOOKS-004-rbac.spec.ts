import { test, expect } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/modules/core/__integration__/helpers/api'

/**
 * TC-WEBHOOKS-004: RBAC enforcement
 *
 * Employee role gets webhooks.view (can list) but not webhooks.manage (cannot
 * create/update/delete). Admin role can do both. Verifies the route metadata
 * guards are enforced.
 */
test.describe('TC-WEBHOOKS-004: RBAC enforcement', () => {
  test('employee cannot POST subscription', async ({ request }) => {
    const employeeToken = await getAuthToken(request, 'employee')
    const res = await apiRequest(request, 'POST', '/api/webhooks/subscriptions', {
      token: employeeToken,
      data: { event: 'webhooks.test', targetUrl: 'https://example.invalid/hook' },
    })
    expect([401, 403]).toContain(res.status())
  })

  test('employee can GET subscriptions list', async ({ request }) => {
    const employeeToken = await getAuthToken(request, 'employee')
    const res = await apiRequest(request, 'GET', '/api/webhooks/subscriptions', { token: employeeToken })
    expect(res.ok()).toBeTruthy()
  })

  test('admin can POST subscription', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const res = await apiRequest(request, 'POST', '/api/webhooks/subscriptions', {
      token: adminToken,
      data: { event: 'webhooks.test', targetUrl: 'https://example.invalid/hook' },
    })
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    await apiRequest(request, 'DELETE', `/api/webhooks/subscriptions?id=${body.data.id}`, { token: adminToken })
  })
})
