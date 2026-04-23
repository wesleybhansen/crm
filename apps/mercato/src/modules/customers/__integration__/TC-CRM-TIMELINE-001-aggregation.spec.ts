import { test, expect } from '@playwright/test';
import { getAuthToken, apiRequest } from '@open-mercato/core/modules/core/__integration__/helpers/api';

/**
 * TC-CRM-TIMELINE-001: Contact timeline aggregation returns contact_created
 *
 * Smoke test for the /api/contacts/[id]/timeline endpoint.
 * Every newly-created contact should have at least one timeline event:
 * the synthetic "Contact added" entry that the timeline route always
 * appends. This locks in the contract that the endpoint returns a non-
 * empty array for a valid contact and that auth resolution works.
 *
 * Further timeline coverage (bookings, forms, enrollments) should live
 * in module-specific specs that create the interaction and then hit
 * this endpoint.
 */
test.describe('TC-CRM-TIMELINE-001: Timeline base aggregation', () => {
  let token: string;
  const createdIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    token = await getAuthToken(request);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIds) {
      await apiRequest(request, 'DELETE', `/api/customers/people?id=${id}`, { token }).catch(() => {});
    }
  });

  test('newly-created contact timeline contains contact_created event', async ({ request }) => {
    const suffix = Date.now();
    const create = await apiRequest(request, 'POST', '/api/customers/people', {
      token,
      data: {
        firstName: 'Timeline',
        lastName: `Seed${suffix}`,
        displayName: `Timeline Seed${suffix}`,
        primaryEmail: `timeline.seed+${suffix}@test.local`,
      },
    });
    expect(create.ok()).toBeTruthy();
    const created = await create.json();
    const id = created.id as string;
    createdIds.push(id);

    const res = await apiRequest(request, 'GET', `/api/contacts/${id}/timeline`, { token });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    const events = body.data as Array<{ type: string }>;
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === 'contact_created')).toBe(true);
  });
});
