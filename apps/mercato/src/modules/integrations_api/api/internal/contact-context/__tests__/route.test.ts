/** @jest-environment node */

const mockFindNoliUserById = jest.fn();
const mockResolveClerkUserToAuthContext = jest.fn();
const mockCreateRequestContainer = jest.fn();

type QueryScope = {
  table: string;
  filters: Array<[string, unknown]>;
};

const queryScopes: QueryScope[] = [];
let contactRow: Record<string, unknown> | null;
let emailRows: Array<Record<string, unknown>>;
let textRows: Array<Record<string, unknown>>;

function createKnex() {
  return (table: string) => {
    const scope: QueryScope = { table, filters: [] };
    queryScopes.push(scope);
    const query = {
      where: jest.fn((field: string, value: unknown) => {
        scope.filters.push([field, value]);
        return query;
      }),
      first: jest.fn(async () => contactRow),
      orderBy: jest.fn(() => query),
      limit: jest.fn(() => query),
      select: jest.fn(async () =>
        table === "email_messages" ? emailRows : textRows,
      ),
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

import { POST } from "../route";

const originalEnv = process.env;
const serviceSecret = "test-internal-service-secret";
const noliUserId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const orgId = "33333333-3333-4333-8333-333333333333";
const tenantId = "44444444-4444-4444-8444-444444444444";

function request(authorization = `Bearer ${serviceSecret}`): Request {
  return new Request("http://localhost/api/internal/contact-context", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ noliUserId, contactId }),
  });
}

describe("CRM internal contact-context projection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryScopes.length = 0;
    process.env = {
      ...originalEnv,
      NOLI_INTERNAL_SERVICE_SECRET: serviceSecret,
    };
    mockFindNoliUserById.mockResolvedValue({ clerk_user_id: "clerk-user-1" });
    mockResolveClerkUserToAuthContext.mockResolvedValue({
      userId: "local-user-1",
      orgId,
      tenantId,
    });
    contactRow = {
      id: contactId,
      display_name: "Ada Customer",
      primary_email: "ada@example.test",
      primary_phone: "+15551234567",
      email: "wrong-legacy-email@example.test",
      phone: "wrong-legacy-phone",
      status: "active",
    };
    emailRows = [
      {
        id: "email-1",
        direction: "inbound",
        subject: "Question",
        body_text: "",
        body_html: "<p>Hello <strong>there</strong></p>",
        created_at: "2026-08-12T12:00:00.000Z",
      },
    ];
    textRows = [
      {
        id: "text-1",
        direction: "outbound",
        body: "Following up",
        created_at: "2026-08-13T12:00:00.000Z",
      },
    ];
    mockCreateRequestContainer.mockResolvedValue({
      resolve: () => ({ getKnex: () => createKnex() }),
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("rejects an invalid service credential before resolving identity", async () => {
    const response = await POST(request("Bearer wrong"));

    expect(response.status).toBe(401);
    expect(mockFindNoliUserById).not.toHaveBeenCalled();
    expect(mockCreateRequestContainer).not.toHaveBeenCalled();
  });

  it("rejects incomplete input before resolving identity", async () => {
    const invalidRequest = new Request(
      "http://localhost/api/internal/contact-context",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ noliUserId }),
      },
    );

    const response = await POST(invalidRequest);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "noliUserId and contactId are required",
    });
    expect(mockFindNoliUserById).not.toHaveBeenCalled();
    expect(mockCreateRequestContainer).not.toHaveBeenCalled();
  });

  it("projects primary contact fields and returns only scoped email and text history", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        contact: {
          id: contactId,
          name: "Ada Customer",
          email: "ada@example.test",
          phone: "+15551234567",
          status: "active",
        },
        thread: [
          {
            id: "text-1",
            channel: "text",
            direction: "outbound",
            subject: null,
            text: "Following up",
            at: "2026-08-13T12:00:00.000Z",
          },
          {
            id: "email-1",
            channel: "email",
            direction: "inbound",
            subject: "Question",
            text: "Hello there",
            at: "2026-08-12T12:00:00.000Z",
          },
        ],
      },
    });
    expect(queryScopes).toHaveLength(3);
    expect(
      queryScopes.every(
        (scope) =>
          scope.filters.some(
            ([field, value]) => field === "organization_id" && value === orgId,
          ) &&
          scope.filters.some(
            ([field, value]) => field === "tenant_id" && value === tenantId,
          ),
      ),
    ).toBe(true);
    expect(
      queryScopes.every(
        (scope) =>
          scope.filters.some(
            ([field, value]) => field === "id" && value === contactId,
          ) ||
          scope.filters.some(
            ([field, value]) => field === "contact_id" && value === contactId,
          ),
      ),
    ).toBe(true);
  });

  it("does not read history when the scoped contact is absent", async () => {
    contactRow = null;

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(queryScopes).toHaveLength(1);
  });
});
