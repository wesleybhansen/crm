import { test, expect, type APIRequestContext } from '@playwright/test';
import { getAuthToken, apiRequest } from '@open-mercato/core/modules/core/__integration__/helpers/api';
import { createPersonFixture, createDealFixture, deleteEntityIfExists } from '@open-mercato/core/modules/core/__integration__/helpers/crmFixtures';
import { createApiKeyFixture } from '@open-mercato/core/modules/core/__integration__/helpers/apiKeysFixtures';
import { getTokenScope, readJsonSafe } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures';

/**
 * TC-TENANT-001: two customers, two tenants, no way across.
 *
 * Customer A is the seeded workspace (admin). Customer B signs up through
 * POST /api/auth/signup, which creates a tenant of its own (setupInitialTenant):
 * the same shape as a Noli org provisioned with CRM_TENANT_PER_CUSTOMER=1.
 * CI lists TENANT_B_EMAIL (default tenant-b@test.local) in
 * SIGNUP_INVITED_EMAILS (.github/workflows/ci.yml). If tenant B cannot be
 * created the spec FAILS: a skipped isolation test reads as a passing one
 * (it never ran from its creation until 2026-09-25).
 *
 * Every request asserts its status code: a 500 is never read as "isolated".
 * The Clerk / CRM_TENANT_PER_CUSTOMER sign-in path cannot be switched on for
 * one spec of the shared ephemeral app; it is covered by
 * packages/core/src/modules/auth/lib/__tests__/provision-tenant.pg.test.ts
 * (real Postgres, CI gtm-regression job) and the internal endpoints by
 * apps/mercato/src/modules/gtm/lib/__tests__/two-tenant-isolation.test.ts.
 *
 * Each customer creates contacts, deals, a form and an API key; then:
 * - B cannot list, search, open by id, update or delete A's contact or deal;
 * - B's API key sees only B's rows; A's key cannot open B's rows;
 * - public form slugs resolve to their own customer's form;
 * - an invite from B joins B's tenant.
 */

const TENANT_B_EMAIL = process.env.TENANT_B_EMAIL || 'tenant-b@test.local';
const TENANT_B_PASSWORD = 'Tenant-B-password-1!';

type Items = Array<Record<string, unknown>>;
const itemsOf = (body: any): Items => (body?.items ?? body?.data ?? []) as Items;

async function signupTenantB(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/signup', {
    data: { name: 'Tenant B Owner', email: TENANT_B_EMAIL, password: TENANT_B_PASSWORD },
  });
  if (res.ok()) {
    const body = (await res.json()) as { token?: string };
    if (body.token) return body.token;
    throw new Error('TC-TENANT-001: signup for tenant B returned no token');
  }
  if (res.status() === 409) {
    // Already signed up by an earlier run against the same database: log in.
    return getAuthToken(request, TENANT_B_EMAIL, TENANT_B_PASSWORD);
  }
  throw new Error(
    `TC-TENANT-001: cannot create tenant B (signup status ${res.status()}). `
      + `List ${TENANT_B_EMAIL} in SIGNUP_INVITED_EMAILS for the app under test.`,
  );
}

async function listPeople(
  request: APIRequestContext,
  auth: { token?: string; apiKey?: string },
  query: string,
): Promise<{ status: number; items: Items }> {
  const headers: Record<string, string> = auth.apiKey ? { 'x-api-key': auth.apiKey } : {};
  const res = auth.apiKey
    ? await request.get(`/api/customers/people?${query}`, { headers })
    : await apiRequest(request, 'GET', `/api/customers/people?${query}`, { token: auth.token! });
  return { status: res.status(), items: res.ok() ? itemsOf(await readJsonSafe(res)) : [] };
}

/** A cross-tenant write must be refused as not found / forbidden: never 2xx, never a 500. */
const REFUSED = [403, 404];

test.describe('TC-TENANT-001: two customers in two tenants are isolated', () => {
  let tokenA: string;
  let tokenB: string;
  const suffix = Date.now();
  const nameA = `IsoAlpha${suffix}`;
  const nameB = `IsoBravo${suffix}`;
  let personA = '';
  let personB = '';
  let dealA = '';
  let keyA: { id: string; secret: string } | null = null;
  let keyB: { id: string; secret: string } | null = null;
  let formSlugA = '';
  let formSlugB = '';

  test.beforeAll(async ({ request }) => {
    tokenA = await getAuthToken(request, 'admin');
    tokenB = await signupTenantB(request);
    personA = await createPersonFixture(request, tokenA, { firstName: 'Iso', lastName: nameA, displayName: `Iso ${nameA}` });
    personB = await createPersonFixture(request, tokenB, { firstName: 'Iso', lastName: nameB, displayName: `Iso ${nameB}` });
    dealA = await createDealFixture(request, tokenA, { title: `Deal ${nameA}` });
    keyA = await createApiKeyFixture(request, tokenA, `iso-a-${suffix}`);
    keyB = await createApiKeyFixture(request, tokenB, `iso-b-${suffix}`);
    for (const [token, name, setSlug] of [
      [tokenA, nameA, (s: string) => { formSlugA = s }],
      [tokenB, nameB, (s: string) => { formSlugB = s }],
    ] as const) {
      const res = await apiRequest(request, 'POST', '/api/forms', { token, data: { name: `Form ${name}`, fields: [], status: 'published' } });
      if (!res.ok()) throw new Error(`TC-TENANT-001: form create for ${name} failed with status ${res.status()}`);
      const body = (await readJsonSafe(res)) as any;
      const slug = body?.data?.slug ?? body?.slug ?? '';
      if (slug) setSlug(String(slug));
    }
  });

  test.afterAll(async ({ request }) => {
    if (personA) await deleteEntityIfExists(request, tokenA, '/api/customers/people', personA);
    if (dealA) await deleteEntityIfExists(request, tokenA, '/api/customers/deals', dealA);
    if (personB) await deleteEntityIfExists(request, tokenB, '/api/customers/people', personB);
  });

  test('the two customers live in different tenants', async () => {
    const a = getTokenScope(tokenA);
    const b = getTokenScope(tokenB);
    expect(a.tenantId).toBeTruthy();
    expect(b.tenantId).toBeTruthy();
    expect(b.tenantId).not.toBe(a.tenantId);
    expect(b.organizationId).not.toBe(a.organizationId);
  });

  test('B cannot list, search or open A\'s contact by id', async ({ request }) => {
    const listed = await listPeople(request, { token: tokenB }, 'pageSize=100');
    expect(listed.status).toBe(200);
    expect(listed.items.some((i) => i.id === personA)).toBe(false);
    expect(listed.items.some((i) => i.id === personB)).toBe(true);
    const searched = await listPeople(request, { token: tokenB }, `search=${nameA}&pageSize=10`);
    expect(searched.status).toBe(200);
    expect(searched.items).toHaveLength(0);
    const byId = await listPeople(request, { token: tokenB }, `id=${personA}&pageSize=1`);
    expect(byId.status).toBe(200);
    expect(byId.items).toHaveLength(0);
    // A still finds its own contact by the same search.
    const own = await listPeople(request, { token: tokenA }, `search=${nameA}&pageSize=10`);
    expect(own.status).toBe(200);
    expect(own.items.some((i) => i.id === personA)).toBe(true);
  });

  test('B cannot update or delete A\'s rows', async ({ request }) => {
    const upd = await apiRequest(request, 'PUT', '/api/customers/people', { token: tokenB, data: { id: personA, displayName: 'hijacked' } });
    expect(REFUSED).toContain(upd.status());
    const del = await apiRequest(request, 'DELETE', `/api/customers/deals?id=${dealA}`, { token: tokenB });
    expect(REFUSED).toContain(del.status());
    const stillThere = await listPeople(request, { token: tokenA }, `id=${personA}&pageSize=1`);
    expect(stillThere.status).toBe(200);
    expect(stillThere.items).toHaveLength(1);
    expect(String(stillThere.items[0].display_name ?? stillThere.items[0].displayName ?? '')).toContain(nameA);
  });

  test('API keys only reach their own tenant', async ({ request }) => {
    expect(keyA?.secret, 'API key for A was not created').toBeTruthy();
    expect(keyB?.secret, 'API key for B was not created').toBeTruthy();
    const viaB = await listPeople(request, { apiKey: keyB!.secret }, 'pageSize=100');
    expect(viaB.status).toBe(200);
    expect(viaB.items.some((i) => i.id === personA)).toBe(false);
    expect(viaB.items.some((i) => i.id === personB)).toBe(true);
    const viaA = await listPeople(request, { apiKey: keyA!.secret }, `id=${personB}&pageSize=1`);
    expect(viaA.status).toBe(200);
    expect(viaA.items).toHaveLength(0);
  });

  test('public form slugs resolve to their own customer', async ({ request }) => {
    expect(formSlugA, 'form slug for A').toBeTruthy();
    expect(formSlugB, 'form slug for B').toBeTruthy();
    expect(formSlugA).not.toBe(formSlugB);
    const a = await request.get(`/api/forms/public/${encodeURIComponent(formSlugA)}`);
    const b = await request.get(`/api/forms/public/${encodeURIComponent(formSlugB)}`);
    expect(a.status()).toBe(200);
    expect(b.status()).toBe(200);
    // The public route renders the form as an HTML page.
    const bodyA = await a.text();
    const bodyB = await b.text();
    expect(bodyA).toContain(nameA);
    expect(bodyA).not.toContain(nameB);
    expect(bodyB).toContain(nameB);
    expect(bodyB).not.toContain(nameA);
  });

  test('an invite from B joins B\'s tenant', async ({ request }) => {
    const email = `iso-invitee-${suffix}@test.local`;
    const invite = await apiRequest(request, 'POST', '/api/team', { token: tokenB, data: { email, role: 'member' } });
    expect(invite.ok(), `invite status ${invite.status()}`).toBe(true);
    const body = (await readJsonSafe(invite)) as any;
    const inviteUrl: string | undefined = body?.data?.inviteUrl;
    // The link is only returned when no email provider delivered it.
    test.skip(!inviteUrl, 'invite link not returned (an email provider sent it)');
    const token = new URL(inviteUrl!).searchParams.get('token');
    const accept = await request.post('/api/invite/accept', { data: { token, name: 'Invitee', password: 'Invitee-password-1!' } });
    expect(accept.ok()).toBe(true);
    const cookie = accept.headers()['set-cookie'] ?? '';
    const jwt = /auth_token=([^;]+)/.exec(cookie)?.[1];
    expect(jwt).toBeTruthy();
    expect(getTokenScope(decodeURIComponent(jwt!)).tenantId).toBe(getTokenScope(tokenB).tenantId);
  });
});
