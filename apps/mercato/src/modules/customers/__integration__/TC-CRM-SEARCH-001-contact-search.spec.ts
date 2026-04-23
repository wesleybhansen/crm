import { test, expect } from '@playwright/test';
import { getAuthToken, apiRequest } from '@open-mercato/core/modules/core/__integration__/helpers/api';

/**
 * TC-CRM-SEARCH-001: Contacts search matches name, email, and phone
 *
 * Regression guard for the contacts search UI. Search must match any of:
 * display_name, primary_email, primary_phone. Must work when tenant
 * data encryption is enabled — the route decrypts candidate rows before
 * filtering, so ciphertext storage doesn't hide contacts from the search.
 */
test.describe('TC-CRM-SEARCH-001: Contacts search (name/email/phone)', () => {
  let token: string;
  const createdIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    token = await getAuthToken(request);
    const suffix = Date.now();
    const res = await apiRequest(request, 'POST', '/api/customers/people', {
      token,
      data: {
        firstName: 'Searchable',
        lastName: `Person${suffix}`,
        displayName: `Searchable Person${suffix}`,
        primaryEmail: `searchable.person+${suffix}@test.local`,
        primaryPhone: `+1-555-${String(suffix).slice(-4)}`,
      },
    });
    expect(res.ok()).toBeTruthy();
    const created = await res.json();
    createdIds.push(created.id as string);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIds) {
      await apiRequest(request, 'DELETE', `/api/customers/people?id=${id}`, { token }).catch(() => {});
    }
  });

  test('search by display name finds the contact', async ({ request }) => {
    const res = await apiRequest(request, 'GET', '/api/customers/people?search=Searchable&pageSize=10', { token });
    const body = await res.json();
    const items = body.items ?? body.data ?? [];
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i: any) => String(i.display_name || '').includes('Searchable'))).toBeTruthy();
  });

  test('search by partial email finds the contact', async ({ request }) => {
    const res = await apiRequest(request, 'GET', '/api/customers/people?search=searchable.person&pageSize=10', { token });
    const body = await res.json();
    const items = body.items ?? body.data ?? [];
    expect(items.length).toBeGreaterThan(0);
  });

  test('search by partial phone finds the contact', async ({ request }) => {
    // Phone numbers vary per-test; fetch the created row to get the phone
    // we inserted, then search by the last 4 digits.
    const listRes = await apiRequest(request, 'GET', `/api/customers/people?id=${createdIds[0]}&pageSize=1`, { token });
    const listBody = await listRes.json();
    const item = (listBody.items ?? listBody.data ?? [])[0];
    const phoneSuffix = String(item?.primary_phone || '').slice(-4);
    if (!phoneSuffix) test.skip();
    const res = await apiRequest(request, 'GET', `/api/customers/people?search=${phoneSuffix}&pageSize=10`, { token });
    const body = await res.json();
    const items = body.items ?? body.data ?? [];
    expect(items.some((i: any) => i.id === createdIds[0])).toBeTruthy();
  });

  test('search with no matches returns empty list (does not leak unrelated contacts)', async ({ request }) => {
    const res = await apiRequest(request, 'GET', '/api/customers/people?search=zzznotarealvaluezzz99999&pageSize=10', { token });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const items = body.items ?? body.data ?? [];
    expect(items.length).toBe(0);
  });
});
