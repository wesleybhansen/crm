import { FakeEm } from './fake-em'

/*
 * Handler-level harness for the internal GTM routes. The routes resolve the
 * represented human through three shared modules (noli-core user lookup,
 * Clerk auth context, DI container with rbacService + em); each test file
 * mocks those module paths with the objects below via
 *   jest.mock('<path>', () => require('./support/route-harness').coreClientMock)
 * and then drives `harness` to decide what the mocks return. Nothing here
 * opens a socket or touches a real database.
 */

export const HARNESS_SECRET = 'route-harness-shared-secret-0123456789'
export const HARNESS_ORG = 'aaaaaaaa-1111-4111-8111-111111111111'
export const HARNESS_TENANT = 'bbbbbbbb-2222-4222-8222-222222222222'
export const HARNESS_USER = 'cccccccc-3333-4333-8333-333333333333'
export const HARNESS_NOLI_USER = 'noli-user-1'

export type RouteHarnessState = {
  em: FakeEm
  // features the represented user holds; empty = feature-less user
  features: Set<string>
  noliUser: { id: string; clerk_user_id: string } | null
  auth: { userId: string; orgId: string; tenantId: string } | null
  // extra container registrations (e.g. commandBus) a route may resolve
  services: Record<string, unknown>
}

export const harness: RouteHarnessState = {
  em: new FakeEm(),
  features: new Set<string>(),
  noliUser: { id: HARNESS_NOLI_USER, clerk_user_id: 'clerk_user_1' },
  auth: { userId: HARNESS_USER, orgId: HARNESS_ORG, tenantId: HARNESS_TENANT },
  services: {},
}

export function resetHarness(options: { features?: string[]; em?: FakeEm } = {}): void {
  harness.em = options.em ?? new FakeEm()
  harness.features = new Set(options.features ?? [])
  harness.noliUser = { id: HARNESS_NOLI_USER, clerk_user_id: 'clerk_user_1' }
  harness.auth = { userId: HARNESS_USER, orgId: HARNESS_ORG, tenantId: HARNESS_TENANT }
  harness.services = {}
  process.env.NOLI_INTERNAL_SERVICE_SECRET = HARNESS_SECRET
  process.env.GTM_ENGINEER_ENABLED = 'true'
}

export const coreClientMock = {
  findNoliUserById: async () => harness.noliUser,
  findPrimaryOrgIdForUser: async () => 'noli-org-1',
  hasNoliOrgMembership: async () => true,
}

export const clerkMock = {
  resolveClerkUserToAuthContext: async () => harness.auth,
}

export const containerMock = {
  createRequestContainer: async () => ({
    resolve: (name: string) => {
      if (name === 'em') return harness.em
      if (name === 'rbacService') {
        return {
          userHasAllFeatures: async (_userId: string, features: string[]) =>
            features.every((feature) => harness.features.has(feature)),
        }
      }
      return harness.services[name] ?? null
    },
  }),
}

export function bearer(secret: string = HARNESS_SECRET): Record<string, string> {
  return { authorization: `Bearer ${secret}` }
}

export function internalRequest(
  body: unknown,
  headers: Record<string, string> = bearer(),
  path = '/api/internal/gtm/test',
): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
  })
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}
