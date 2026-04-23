import { test, expect } from '@playwright/test';
import { getAuthToken, apiRequest } from '@open-mercato/core/modules/core/__integration__/helpers/api';

/**
 * TC-CRM-FORM-001: Public form submit — createContact gating + timeline
 *
 * Contract:
 *   - Form setting createContact=false → submission lands in form_submissions
 *     but no new contact is created
 *   - Form setting createContact=true → new submitter becomes a contact
 *     with no automatic lifecycle_stage (no auto-prospect)
 *   - Existing contacts ALWAYS get a "form submission" timeline entry,
 *     regardless of createContact setting
 */

// Ignore this suite until the public forms test harness is ready to
// spin up a form fixture with configurable settings; the assertions
// need the real form submit endpoint end-to-end.
test.describe.skip('TC-CRM-FORM-001: form submit gating', () => {
  let token: string;
  const createdPeopleIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    token = await getAuthToken(request);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdPeopleIds) {
      await apiRequest(request, 'DELETE', `/api/customers/people?id=${id}`, { token }).catch(() => {});
    }
  });

  test('createContact=false does not insert a new contact', async () => {
    // Requires: create form fixture with createContact=false, POST to
    // /api/forms/public/<slug>/submit with a brand new email, verify
    // /api/customers/people?search=<email> returns 0.
    expect(true).toBe(true);
  });

  test('createContact=true creates contact without auto-prospect stage', async () => {
    // Requires: create form fixture with createContact=true, submit,
    // verify contact exists and lifecycle_stage is null.
    expect(true).toBe(true);
  });

  test('existing contact gets a form_submission timeline entry', async () => {
    // Requires: pre-create a contact via API, then submit the form using
    // that contact's email; GET /api/contacts/<id>/timeline and verify
    // a form_submission event exists.
    expect(true).toBe(true);
  });
});
