/** @jest-environment node */

const mockFindNoliUserById = jest.fn()
const mockFindPrimaryOrgIdForUser = jest.fn()
const mockIsEntitled = jest.fn()
const mockResolveClerkUserToAuthContext = jest.fn()
const mockProvisionPlatformAutoApiKey = jest.fn()
const mockInvalidateTenantCache = jest.fn()
const mockInvalidateAllCache = jest.fn()

const mockEm = {
  findOne: jest.fn(),
  find: jest.fn(),
}

jest.mock('@open-mercato/shared/lib/noli/core-client', () => ({
  findNoliUserById: (...args: unknown[]) => mockFindNoliUserById(...args),
  findPrimaryOrgIdForUser: (...args: unknown[]) => mockFindPrimaryOrgIdForUser(...args),
  isEntitled: (...args: unknown[]) => mockIsEntitled(...args),
}))

jest.mock('@open-mercato/shared/lib/auth/clerk', () => ({
  resolveClerkUserToAuthContext: (...args: unknown[]) => mockResolveClerkUserToAuthContext(...args),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({
    resolve: (token: string) => {
      if (token === 'em') return mockEm
      if (token === 'rbacService') {
        return {
          invalidateTenantCache: mockInvalidateTenantCache,
          invalidateAllCache: mockInvalidateAllCache,
        }
      }
      return undefined
    },
  })),
}))

jest.mock('@open-mercato/core/modules/api_keys/services/platformAutoKeyService', () => ({
  getPlatformAutoCredentialVersion: jest.fn(() => 1),
  getPlatformAutoOverlapSeconds: jest.fn(() => 600),
  provisionPlatformAutoApiKey: (...args: unknown[]) => mockProvisionPlatformAutoApiKey(...args),
}))

import { POST } from '../route'

const serviceSecret = 'test-internal-service-secret'
const noliUserId = '11111111-1111-4111-8111-111111111111'
const localOrgId = '22222222-2222-4222-8222-222222222222'

function request(body: Record<string, unknown> = { noliUserId, source: 'cos' }): Request {
  return new Request('http://localhost/api/internal/provision-key', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${serviceSecret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

describe('CRM internal provision-key entitlement semantics', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.NOLI_INTERNAL_SERVICE_SECRET = serviceSecret
    process.env.NOLI_COS_CREDENTIAL_DERIVATION_SECRET =
      'test-only-credential-derivation-secret-1234567890'
    mockFindNoliUserById.mockResolvedValue({
      id: noliUserId,
      clerk_user_id: 'clerk-user-1',
    })
    mockFindPrimaryOrgIdForUser.mockResolvedValue('noli-org-1')
    mockIsEntitled.mockResolvedValue(true)
    mockResolveClerkUserToAuthContext.mockResolvedValue({
      userId: 'local-user-1',
      orgId: localOrgId,
      tenantId: 'local-tenant-1',
      noliUserId,
    })
    mockEm.findOne.mockImplementation(async (_entity, criteria) =>
      'clerkUserId' in (criteria as Record<string, unknown>)
        ? {
            id: 'local-user-1',
            organizationId: localOrgId,
            clerkUserId: 'clerk-user-1',
          }
        : {
            id: localOrgId,
            noliOrgId: 'noli-org-1',
            isActive: true,
          },
    )
    mockEm.find.mockResolvedValue([{ role: { id: 'role-admin' } }])
    mockProvisionPlatformAutoApiKey.mockResolvedValue({
      secret: 'omk_12345678.test',
      record: { id: 'managed-key-1', keyPrefix: 'omk_12345678' },
      version: 1,
      overlapSeconds: 600,
      reused: false,
    })
  })

  afterAll(() => {
    delete process.env.NOLI_INTERNAL_SERVICE_SECRET
    delete process.env.NOLI_COS_CREDENTIAL_DERIVATION_SECRET
  })

  it('emits remove=true only after a positive inactive entitlement result', async () => {
    mockIsEntitled.mockResolvedValue(false)

    const response = await POST(request())
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      code: 'entitlement_lapsed',
      remove: true,
    })
    expect(mockResolveClerkUserToAuthContext).not.toHaveBeenCalled()
    expect(mockProvisionPlatformAutoApiKey).not.toHaveBeenCalled()
  })

  it('treats a missing noli identity as indeterminate and keeps the hand', async () => {
    mockFindNoliUserById.mockResolvedValue(null)

    const response = await POST(request())
    const payload = await response.json()
    expect(response.status).toBe(503)
    expect(payload.code).toBe('noli_identity_unavailable')
    expect(payload.remove).toBeUndefined()
  })

  it('treats resolver failure after a positive entitlement as indeterminate', async () => {
    mockResolveClerkUserToAuthContext.mockResolvedValue(null)

    const response = await POST(request())
    const payload = await response.json()
    expect(response.status).toBe(503)
    expect(payload.code).toBe('crm_identity_unavailable')
    expect(payload.remove).toBeUndefined()
  })

  it('treats an entitlement authority error as transient and keeps the hand', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockIsEntitled.mockRejectedValue(new Error('noli-core unavailable'))

    const response = await POST(request())
    const payload = await response.json()
    expect(response.status).toBe(500)
    expect(payload.remove).toBeUndefined()
    expect(mockResolveClerkUserToAuthContext).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('does not mint when the local organization is not linked to the current noli org', async () => {
    mockEm.findOne.mockImplementation(async (_entity, criteria) =>
      'clerkUserId' in (criteria as Record<string, unknown>)
        ? {
            id: 'local-user-1',
            organizationId: localOrgId,
            clerkUserId: 'clerk-user-1',
          }
        : {
            id: localOrgId,
            noliOrgId: 'different-noli-org',
            isActive: true,
          },
    )

    const response = await POST(request())
    const payload = await response.json()
    expect(response.status).toBe(503)
    expect(payload.code).toBe('crm_org_unavailable')
    expect(payload.remove).toBeUndefined()
    expect(mockProvisionPlatformAutoApiKey).not.toHaveBeenCalled()
  })

  it('returns a user-scoped stable credential after all authority checks pass', async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        key: 'omk_12345678.test',
        credentialVersion: 1,
        overlapSeconds: 600,
      },
    })
    expect(mockProvisionPlatformAutoApiKey).toHaveBeenCalledWith(
      mockEm,
      expect.objectContaining({
        noliUserId,
        organizationId: localOrgId,
        createdBy: 'local-user-1',
        source: 'cos',
      }),
    )
    expect(mockInvalidateTenantCache).toHaveBeenCalledWith('local-tenant-1')
  })

  it('returns the committed credential when RBAC cache invalidation is unavailable', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    mockInvalidateTenantCache.mockRejectedValueOnce(new Error('cache unavailable'))

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { key: 'omk_12345678.test' },
    })
    expect(consoleSpy).toHaveBeenCalledWith(
      '[internal.provision-key] RBAC cache invalidation failed',
    )
    consoleSpy.mockRestore()
  })
})
