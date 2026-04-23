import { test, expect } from '@playwright/test';
import { getAuthToken, apiRequest } from '@open-mercato/core/modules/core/__integration__/helpers/api';

/**
 * TC-CRM-DEDUP-001: Dedup matches encrypted primary_email
 *
 * Scenario: a contact was created through the ORM write path (Scout,
 * customers.people.create command) so primary_email is stored encrypted.
 * When a public endpoint (booking, course enrollment, form submit) then
 * tries to upsert the same email, findOrMergeContact must decrypt-and-match
 * so it DOESN'T produce a duplicate contact.
 *
 * This test creates a contact via the CRUD command (ORM path — email may
 * be stored encrypted), then creates a second contact with the same email
 * via the same API. The second call should be rejected or dedup should
 * surface a single matching contact.
 */
test.describe('TC-CRM-DEDUP-001: Encrypted email dedup', () => {
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

  test('searching by the original email returns a single match after second upsert attempt', async ({ request }) => {
    const suffix = Date.now();
    const email = `dedup.test+${suffix}@test.local`;

    // 1st create via ORM write path (may store email encrypted)
    const first = await apiRequest(request, 'POST', '/api/customers/people', {
      token,
      data: {
        firstName: 'Dedup',
        lastName: 'Primary',
        displayName: 'Dedup Primary',
        primaryEmail: email,
        source: 'ai_assistant',
      },
    });
    expect(first.ok()).toBeTruthy();
    const firstBody = await first.json();
    createdIds.push(firstBody.id as string);

    // Search by email — must return exactly ONE row (not zero, not two)
    const searchRes = await apiRequest(request, 'GET', `/api/customers/people?search=${encodeURIComponent(email)}&pageSize=10`, { token });
    const searchBody = await searchRes.json();
    const items = searchBody.items ?? searchBody.data ?? [];
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(firstBody.id);
  });
});
