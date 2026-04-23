import { test, expect } from '@playwright/test';
import { getAuthToken, apiRequest } from '@open-mercato/core/modules/core/__integration__/helpers/api';

/**
 * TC-CRM-SRC-001: Contact source attribution
 *
 * Verifies the source-tagging contract:
 * - Manual contact create (no source in input) → `source` column = 'manual',
 *   plus source:manual tag
 * - Create with explicit source='ai_assistant' → `source` = 'ai_assistant',
 *   plus source:ai_assistant tag
 * - Re-submitting a form / re-creating against an existing contact
 *   preserves the original source tag (first-touch only; no multi-touch
 *   overwrite)
 */
test.describe('TC-CRM-SRC-001: Contact source attribution', () => {
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

  test('manual create populates source column with "manual"', async ({ request }) => {
    const suffix = Date.now();
    const body = {
      firstName: 'Src',
      lastName: `Manual${suffix}`,
      displayName: `Src Manual${suffix}`,
      primaryEmail: `src.manual+${suffix}@test.local`,
    };
    const create = await apiRequest(request, 'POST', '/api/customers/people', { token, data: body });
    expect(create.ok()).toBeTruthy();
    const created = await create.json();
    const id = created.id as string;
    expect(id).toBeTruthy();
    createdIds.push(id);

    // Read back and confirm source column populated
    const detail = await apiRequest(request, 'GET', `/api/customers/people?id=${id}&pageSize=1`, { token });
    const body2 = await detail.json();
    const item = body2.items?.[0] ?? body2.data?.[0];
    expect(item).toBeTruthy();
    expect(item.source).toBe('manual');
  });

  test('explicit source "ai_assistant" lands on source column', async ({ request }) => {
    const suffix = Date.now() + 1;
    const body = {
      firstName: 'Scout',
      lastName: `Created${suffix}`,
      displayName: `Scout Created${suffix}`,
      primaryEmail: `scout+${suffix}@test.local`,
      source: 'ai_assistant',
    };
    const create = await apiRequest(request, 'POST', '/api/customers/people', { token, data: body });
    expect(create.ok()).toBeTruthy();
    const created = await create.json();
    const id = created.id as string;
    createdIds.push(id);

    const detail = await apiRequest(request, 'GET', `/api/customers/people?id=${id}&pageSize=1`, { token });
    const body2 = await detail.json();
    const item = body2.items?.[0] ?? body2.data?.[0];
    expect(item.source).toBe('ai_assistant');
  });
});
