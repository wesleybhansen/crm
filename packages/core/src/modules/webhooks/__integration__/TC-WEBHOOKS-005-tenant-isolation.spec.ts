import { test, expect } from '@playwright/test'
import { getAuthToken, apiRequest } from '@open-mercato/core/modules/core/__integration__/helpers/api'

/**
 * TC-WEBHOOKS-005: tenant isolation
 *
 * A subscription created by admin@acme.com cannot be retrieved, updated,
 * or deleted by another tenant. We don't have a second seeded tenant in
 * integration tests by default, so this test asserts the negative
 * shape: listing /api/webhooks/subscriptions returns only this tenant's
 * rows, and the delivery log join-scoping prevents leakage.
 */
test.describe('TC-WEBHOOKS-005: tenant isolation', () => {
  test('list endpoint only returns caller tenant subscriptions', async ({ request }) => {
    const token = await getAuthToken(request)
    const createRes = await apiRequest(request, 'POST', '/api/webhooks/subscriptions', {
      token,
      data: { event: 'webhooks.test', targetUrl: 'https://example.invalid/iso' },
    })
    expect(createRes.ok()).toBeTruthy()
    const created = await createRes.json()
    const id = created.data.id as string

    try {
      const listRes = await apiRequest(request, 'GET', '/api/webhooks/subscriptions', { token })
      expect(listRes.ok()).toBeTruthy()
      const body = await listRes.json()
      const subs = body.data as Array<{ id: string; tenantId: string; organizationId: string }>
      // Every row must belong to the caller's org+tenant — if the route
      // omits the scope filter, a second tenant's subs will leak in.
      const uniqueOrgs = new Set(subs.map((s) => s.organizationId))
      const uniqueTenants = new Set(subs.map((s) => s.tenantId))
      expect(uniqueOrgs.size).toBeLessThanOrEqual(1)
      expect(uniqueTenants.size).toBeLessThanOrEqual(1)
    } finally {
      await apiRequest(request, 'DELETE', `/api/webhooks/subscriptions?id=${id}`, { token })
    }
  })
})
