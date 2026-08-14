/** @jest-environment node */

const mockFindNoliUserById = jest.fn();
const mockResolveClerkUserToAuthContext = jest.fn();
const mockCreateRequestContainer = jest.fn();
const mockRefreshTokenIfNeeded = jest.fn();

type QueryScope = {
  table: string;
  filters: Array<[string, unknown]>;
};

const queryScopes: QueryScope[] = [];

function createKnex() {
  return (table: string) => {
    const scope: QueryScope = { table, filters: [] };
    queryScopes.push(scope);
    const query = {
      where: jest.fn((field: string, value: unknown) => {
        scope.filters.push([field, value]);
        return query;
      }),
      first: jest.fn(async () => ({
        id: "connection-1",
        calendar_id: "primary",
        refresh_token: "refresh-token-never-returned",
      })),
    };
    return query;
  };
}

jest.mock("@open-mercato/shared/lib/noli/core-client", () => ({
  findNoliUserById: (...args: unknown[]) => mockFindNoliUserById(...args),
}));

jest.mock("@open-mercato/shared/lib/auth/clerk", () => ({
  resolveClerkUserToAuthContext: (...args: unknown[]) =>
    mockResolveClerkUserToAuthContext(...args),
}));

jest.mock("@open-mercato/shared/lib/di/container", () => ({
  createRequestContainer: (...args: unknown[]) =>
    mockCreateRequestContainer(...args),
}));

jest.mock("@/modules/calendar/lib/google-calendar-service", () => ({
  refreshTokenIfNeeded: (...args: unknown[]) =>
    mockRefreshTokenIfNeeded(...args),
}));

import { POST } from "../route";

const originalEnv = process.env;
const originalFetch = global.fetch;
const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
const serviceSecret = "test-internal-service-secret";
const noliUserId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const orgId = "33333333-3333-4333-8333-333333333333";
const tenantId = "44444444-4444-4444-8444-444444444444";

function request(
  body: Record<string, unknown> = { noliUserId, op: "list" },
  authorization = `Bearer ${serviceSecret}`,
): Request {
  return new Request("http://localhost/api/internal/calendar-events", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function googleResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CRM internal calendar-events contract", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryScopes.length = 0;
    process.env = {
      ...originalEnv,
      NOLI_INTERNAL_SERVICE_SECRET: serviceSecret,
    };
    global.fetch = fetchMock;
    mockFindNoliUserById.mockResolvedValue({ clerk_user_id: "clerk-user-1" });
    mockResolveClerkUserToAuthContext.mockResolvedValue({
      userId,
      orgId,
      tenantId,
    });
    mockCreateRequestContainer.mockResolvedValue({
      resolve: () => ({ getKnex: () => createKnex() }),
    });
    mockRefreshTokenIfNeeded.mockResolvedValue("calendar-access-token");
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("rejects an invalid service credential before resolving identity", async () => {
    const response = await POST(request(undefined, "Bearer wrong"));

    expect(response.status).toBe(401);
    expect(mockFindNoliUserById).not.toHaveBeenCalled();
    expect(mockCreateRequestContainer).not.toHaveBeenCalled();
  });

  it.each([
    [{ op: "list" }, "noliUserId required"],
    [{ noliUserId, op: "delete" }, "op must be list or upsert"],
  ])("rejects invalid input before dependency access", async (body, error) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, error });
    expect(mockFindNoliUserById).not.toHaveBeenCalled();
    expect(mockCreateRequestContainer).not.toHaveBeenCalled();
  });

  it("requires the resolved user, organization, and tenant before reading a connection", async () => {
    mockResolveClerkUserToAuthContext.mockResolvedValue({ userId, orgId });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "not_connected",
    });
    expect(mockCreateRequestContainer).not.toHaveBeenCalled();
  });

  it("scopes the connection and forwards page and sync tokens unchanged", async () => {
    fetchMock.mockResolvedValueOnce(
      googleResponse({
        items: [{ id: "event-1" }],
        nextPageToken: "next-page",
        nextSyncToken: "next-sync",
      }),
    );

    const response = await POST(
      request({
        noliUserId,
        op: "list",
        pageToken: "page-token",
        syncToken: "sync-token",
        updatedMinMs: 123,
      }),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      ok: true,
      expired: false,
      items: [{ id: "event-1" }],
      nextPageToken: "next-page",
      nextSyncToken: "next-sync",
    });
    expect(queryScopes).toEqual([
      {
        table: "google_calendar_connections",
        filters: [
          ["user_id", userId],
          ["organization_id", orgId],
          ["tenant_id", tenantId],
          ["is_active", true],
        ],
      },
    ]);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("pageToken")).toBe("page-token");
    expect(url.searchParams.get("syncToken")).toBe("sync-token");
    expect(url.searchParams.has("updatedMin")).toBe(false);
    expect(
      new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe("Bearer calendar-access-token");
    expect(JSON.stringify(payload)).not.toContain(
      "refresh-token-never-returned",
    );
  });

  it("returns the typed expired result for a stale sync token", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 410 }));

    const response = await POST(
      request({ noliUserId, op: "list", syncToken: "stale" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      expired: true,
      items: [],
      nextPageToken: null,
      nextSyncToken: null,
    });
  });

  it("maps a provider outage to a truthful gateway failure", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("unavailable", { status: 503 }),
    );

    const response = await POST(request());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "google_503",
    });
  });

  it("rejects a successful create response without an event id", async () => {
    fetchMock.mockResolvedValueOnce(googleResponse({}));

    const response = await POST(
      request({
        noliUserId,
        op: "upsert",
        event: { summary: "Customer call" },
      }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "google_invalid_response",
    });
  });
});
