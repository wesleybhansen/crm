/** @jest-environment node */

const mockFindNoliUserById = jest.fn();
const mockResolveClerkUserToAuthContext = jest.fn();
const mockCreateRequestContainer = jest.fn();

type CountValue = string | number | Error | undefined;
type QueryScope = {
  table: string;
  filters: Array<[string, unknown]>;
  nulls: string[];
};

const countValues = new Map<string, CountValue>();
const queryScopes: QueryScope[] = [];

function createKnex() {
  return (table: string) => {
    const scope: QueryScope = { table, filters: [], nulls: [] };
    queryScopes.push(scope);
    const query = {
      where: jest.fn((field: string, value: unknown) => {
        scope.filters.push([field, value]);
        return query;
      }),
      whereNull: jest.fn((field: string) => {
        scope.nulls.push(field);
        return query;
      }),
      count: jest.fn(() => query),
      first: jest.fn(async () => {
        const value = countValues.get(table);
        if (value instanceof Error) throw value;
        return value === undefined ? undefined : { n: value };
      }),
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
const orgId = "22222222-2222-4222-8222-222222222222";
const tenantId = "33333333-3333-4333-8333-333333333333";

function request(authorization = `Bearer ${serviceSecret}`): Request {
  return new Request("http://localhost/api/internal/setup-status", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ noliUserId }),
  });
}

async function expectUnavailable(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({
    exists: false,
    unavailable: true,
    error: "setup_status_unavailable",
  });
}

describe("CRM internal setup-status contract", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    countValues.clear();
    queryScopes.length = 0;
    process.env = {
      ...originalEnv,
      NOLI_INTERNAL_SERVICE_SECRET: serviceSecret,
    };
    mockFindNoliUserById.mockResolvedValue({ clerk_user_id: "clerk-user-1" });
    mockResolveClerkUserToAuthContext.mockResolvedValue({ orgId, tenantId });
    for (const table of [
      "customer_entities",
      "landing_pages",
      "booking_pages",
      "email_accounts",
    ]) {
      countValues.set(table, "0");
    }
    mockCreateRequestContainer.mockResolvedValue({
      resolve: () => ({ getKnex: () => createKnex() }),
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("rejects an invalid service credential before dependency access", async () => {
    const response = await POST(request("Bearer wrong"));

    expect(response.status).toBe(401);
    expect(mockFindNoliUserById).not.toHaveBeenCalled();
    expect(mockCreateRequestContainer).not.toHaveBeenCalled();
  });

  it("rejects a missing Noli user id before dependency access", async () => {
    const invalidRequest = new Request(
      "http://localhost/api/internal/setup-status",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );

    const response = await POST(invalidRequest);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "noliUserId required",
    });
    expect(mockFindNoliUserById).not.toHaveBeenCalled();
    expect(mockCreateRequestContainer).not.toHaveBeenCalled();
  });

  it.each([
    ["missing Noli identity", null],
    ["missing Clerk identity", { id: noliUserId }],
  ])(
    "preserves %s as an unconfigured account",
    async (_condition, identity) => {
      mockFindNoliUserById.mockResolvedValue(identity);

      const response = await POST(request());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ exists: false });
      expect(mockCreateRequestContainer).not.toHaveBeenCalled();
    },
  );

  it("does not query when the resolved organization or tenant is incomplete", async () => {
    mockResolveClerkUserToAuthContext.mockResolvedValue({ orgId });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ exists: false });
    expect(mockCreateRequestContainer).not.toHaveBeenCalled();
  });

  it("returns the empty projection from four successful scoped counts", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      exists: true,
      hasContacts: false,
      hasCapturePage: false,
      emailConnected: false,
    });
    expect(queryScopes).toHaveLength(4);
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
      queryScopes.find((scope) => scope.table === "customer_entities")?.nulls,
    ).toEqual(["deleted_at"]);
  });

  it("returns the configured projection from successful positive counts", async () => {
    countValues.set("customer_entities", 2);
    countValues.set("landing_pages", "1");
    countValues.set("email_accounts", 1);

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      exists: true,
      hasContacts: true,
      hasCapturePage: true,
      emailConnected: true,
    });
  });

  it("returns unavailable when a count query fails", async () => {
    countValues.set("booking_pages", new Error("private database detail"));
    const consoleSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expectUnavailable(await POST(request()));

    expect(consoleSpy).toHaveBeenCalledWith(
      "[internal.setup-status] setup_status_unavailable",
    );
    consoleSpy.mockRestore();
  });

  it("returns unavailable when a count result is malformed", async () => {
    countValues.set("customer_entities", "not-a-count");
    const consoleSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expectUnavailable(await POST(request()));

    consoleSpy.mockRestore();
  });

  it("returns unavailable when an identity dependency rejects", async () => {
    mockFindNoliUserById.mockRejectedValue(
      new Error("private dependency detail"),
    );
    const consoleSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expectUnavailable(await POST(request()));

    expect(mockCreateRequestContainer).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      "[internal.setup-status] setup_status_unavailable",
    );
    consoleSpy.mockRestore();
  });
});
