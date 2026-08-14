/** @jest-environment node */

import type { EntityManager } from '@mikro-orm/postgresql'
import { User } from '@open-mercato/core/modules/auth/data/entities'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import { ApiKey } from '../../data/entities'
import { findApiKeyBySecret } from '../apiKeyService'
import {
  ABSOLUTE_PLATFORM_AUTO_LEGACY_CUTOFF_MS,
  DEFAULT_PLATFORM_AUTO_LEGACY_CUTOFF_MS,
  derivePlatformAutoApiKeySecret,
  getPlatformAutoOverlapSeconds,
  getPlatformAutoLegacyCutoffMs,
  isLegacyPlatformAutoKeyUsable,
  isPlatformAutoApiKeyAuthorized,
  parsePlatformAutoKeyName,
  platformAutoKeyName,
  platformAutoSourceFingerprint,
  provisionPlatformAutoApiKey,
} from '../platformAutoKeyService'

const mockFindNoliUserById = jest.fn()
const mockFindUserByClerkId = jest.fn()
const mockHasNoliOrgMembership = jest.fn()
const mockIsEntitled = jest.fn()

jest.mock('@open-mercato/shared/lib/noli/core-client', () => ({
  findNoliUserById: (...args: unknown[]) => mockFindNoliUserById(...args),
  findUserByClerkId: (...args: unknown[]) => mockFindUserByClerkId(...args),
  hasNoliOrgMembership: (...args: unknown[]) => mockHasNoliOrgMembership(...args),
  isEntitled: (...args: unknown[]) => mockIsEntitled(...args),
}))

type Criteria = Record<string, unknown>

function matchesApiKey(record: ApiKey, criteria: Criteria): boolean {
  return Object.entries(criteria).every(([field, expected]) => {
    const actual = record[field as keyof ApiKey]
    if (field === 'name' && expected && typeof expected === 'object' && '$like' in expected) {
      const pattern = String((expected as { $like: unknown }).$like)
      return record.name.startsWith(pattern.slice(0, -1))
    }
    if (expected === null) return actual == null
    return actual === expected
  })
}

function createMockEm() {
  const apiKeys: ApiKey[] = []
  const users: User[] = []
  const organizations: Organization[] = []
  const execute = jest.fn(async () => undefined)
  let nextId = 1

  const em = {
    transactional: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(em)),
    execute,
    find: jest.fn(async (entity: unknown, criteria: Criteria) => {
      if (entity === ApiKey) return apiKeys.filter((record) => matchesApiKey(record, criteria))
      return []
    }),
    findOne: jest.fn(async (entity: unknown, criteria: Criteria) => {
      if (entity === User) {
        return (
          users.find((record) =>
            Object.entries(criteria).every(([field, expected]) => {
              const actual = record[field as keyof User]
              return expected === null ? actual == null : actual === expected
            }),
          ) ?? null
        )
      }
      if (entity === Organization) {
        return (
          organizations.find((record) =>
            Object.entries(criteria).every(([field, expected]) => {
              const actual = record[field as keyof Organization]
              return expected === null ? actual == null : actual === expected
            }),
          ) ?? null
        )
      }
      return null
    }),
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) =>
      Object.assign(new ApiKey(), data, { id: `key-${nextId++}` }),
    ),
    persist: jest.fn((record: ApiKey) => {
      if (!apiKeys.includes(record)) apiKeys.push(record)
    }),
    flush: jest.fn(async () => undefined),
    persistAndFlush: jest.fn(async () => undefined),
  }

  return {
    em: em as unknown as EntityManager,
    apiKeys,
    users,
    organizations,
    execute,
  }
}

const derivationSecret = 'test-only-credential-derivation-secret-1234567890'
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const userId = '11111111-1111-4111-8111-111111111111'
const localUserId = '22222222-2222-4222-8222-222222222222'
const tenantId = '33333333-3333-4333-8333-333333333333'

function provisionInput(overrides: Record<string, unknown> = {}) {
  return {
    noliUserId: userId,
    source: 'cos',
    version: 1,
    derivationSecret,
    overlapSeconds: 600,
    tenantId,
    organizationId: orgId,
    roles: ['role-admin'],
    createdBy: localUserId,
    ...overrides,
  }
}

describe('platform-auto CRM credentials', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFindNoliUserById.mockResolvedValue({
      id: userId,
      clerk_user_id: 'clerk-user-1',
    })
    mockFindUserByClerkId.mockResolvedValue({
      id: userId,
      clerk_user_id: 'clerk-user-1',
    })
    mockHasNoliOrgMembership.mockResolvedValue(true)
    mockIsEntitled.mockResolvedValue(true)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('derives a stable scoped secret and round-trips v2 metadata', () => {
    const name = platformAutoKeyName(userId, 'cos', 7)
    expect(parsePlatformAutoKeyName(name)).toEqual({
      noliUserId: userId,
      sourceFingerprint: platformAutoSourceFingerprint('cos'),
      version: 7,
    })
    const input = {
      derivationSecret,
      tenantId,
      organizationId: orgId,
      noliUserId: userId,
      sourceFingerprint: platformAutoSourceFingerprint('cos'),
      version: 7,
    }
    expect(derivePlatformAutoApiKeySecret(input)).toEqual(derivePlatformAutoApiKeySecret(input))
    expect(
      derivePlatformAutoApiKeySecret({ ...input, tenantId: 'different-tenant' }),
    ).not.toEqual(derivePlatformAutoApiKeySecret(input))
  })

  it('returns one unchanged credential for repeated same-user provisioning', async () => {
    const { em, apiKeys, execute } = createMockEm()
    const first = await provisionPlatformAutoApiKey(em, provisionInput())
    const second = await provisionPlatformAutoApiKey(
      em,
      provisionInput({ roles: ['role-current'] }),
    )

    expect(second.secret).toBe(first.secret)
    expect(second.reused).toBe(true)
    expect(second.record.rolesJson).toEqual(['role-current'])
    expect(apiKeys).toHaveLength(1)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledWith(
      'select pg_advisory_xact_lock(hashtext(?))',
      [expect.stringContaining(`:${orgId}:${userId}:`)],
    )
  })

  it('rebinds the same noli-user credential if the local CRM user row changes', async () => {
    const { em, apiKeys } = createMockEm()
    const first = await provisionPlatformAutoApiKey(em, provisionInput())
    const replacementLocalUser = '66666666-6666-4666-8666-666666666666'
    const reprovisioned = await provisionPlatformAutoApiKey(
      em,
      provisionInput({ createdBy: replacementLocalUser }),
    )

    expect(reprovisioned.secret).toBe(first.secret)
    expect(reprovisioned.record.createdBy).toBe(replacementLocalUser)
    expect(apiKeys).toHaveLength(1)
  })

  it('caps a late legacy key when stable v2 provisioning runs again', async () => {
    const { em, apiKeys } = createMockEm()
    const first = await provisionPlatformAutoApiKey(em, provisionInput())
    const delayedLegacy = Object.assign(new ApiKey(), {
      id: 'late-legacy',
      name: 'platform-auto:cos',
      tenantId,
      organizationId: orgId,
      createdBy: localUserId,
      deletedAt: null,
      expiresAt: null,
    })
    apiKeys.push(delayedLegacy)

    const repeated = await provisionPlatformAutoApiKey(em, provisionInput())
    expect(repeated.secret).toBe(first.secret)
    expect(delayedLegacy.expiresAt?.getTime()).toBeGreaterThan(Date.now())
    expect(delayedLegacy.expiresAt?.getTime()).toBeLessThanOrEqual(Date.now() + 600_000)
  })

  it('isolates teammates even when their local organization and source match', async () => {
    const { em, apiKeys } = createMockEm()
    const teammateNoliId = '44444444-4444-4444-8444-444444444444'
    const teammateLocalId = '55555555-5555-4555-8555-555555555555'
    const first = await provisionPlatformAutoApiKey(em, provisionInput())
    const second = await provisionPlatformAutoApiKey(
      em,
      provisionInput({
        noliUserId: teammateNoliId,
        createdBy: teammateLocalId,
      }),
    )

    expect(second.secret).not.toBe(first.secret)
    expect(apiKeys).toHaveLength(2)
    expect(first.record.expiresAt).toBeNull()
    expect(second.record.expiresAt).toBeNull()
  })

  it('rotates atomically with bounded same-user legacy overlap only', async () => {
    const { em, apiKeys } = createMockEm()
    const ownLegacy = Object.assign(new ApiKey(), {
      id: 'legacy-own',
      name: 'platform-auto:cos',
      tenantId,
      organizationId: orgId,
      createdBy: localUserId,
      deletedAt: null,
      expiresAt: null,
    })
    const teammateLegacy = Object.assign(new ApiKey(), {
      id: 'legacy-teammate',
      name: 'platform-auto:cos',
      tenantId,
      organizationId: orgId,
      createdBy: 'different-local-user',
      deletedAt: null,
      expiresAt: null,
    })
    apiKeys.push(ownLegacy, teammateLegacy)

    const first = await provisionPlatformAutoApiKey(em, provisionInput())
    const rotated = await provisionPlatformAutoApiKey(em, provisionInput({ version: 2 }))

    expect(rotated.secret).not.toBe(first.secret)
    expect(rotated.record.expiresAt).toBeNull()
    expect(first.record.expiresAt?.getTime()).toBeGreaterThan(Date.now())
    expect(first.record.expiresAt?.getTime()).toBeLessThanOrEqual(Date.now() + 600_000)
    expect(ownLegacy.expiresAt).toBeInstanceOf(Date)
    expect(teammateLegacy.expiresAt).toBeNull()
    expect(getPlatformAutoOverlapSeconds('999999')).toBe(3600)
  })

  it('returns the latest credential to a stale lower-version provision request', async () => {
    const { em, apiKeys } = createMockEm()
    const first = await provisionPlatformAutoApiKey(em, provisionInput())
    const latest = await provisionPlatformAutoApiKey(em, provisionInput({ version: 2 }))
    const stale = await provisionPlatformAutoApiKey(em, provisionInput({ version: 1 }))

    expect(stale.secret).toBe(latest.secret)
    expect(stale.secret).not.toBe(first.secret)
    expect(stale.version).toBe(2)
    expect(stale.reused).toBe(true)
    expect(apiKeys).toHaveLength(2)
  })

  it('refreshes a live predecessor role downgrade without extending its overlap', async () => {
    const { em } = createMockEm()
    const first = await provisionPlatformAutoApiKey(em, provisionInput())
    await provisionPlatformAutoApiKey(em, provisionInput({ version: 2 }))
    const fixedExpiry = first.record.expiresAt?.getTime()

    await provisionPlatformAutoApiKey(
      em,
      provisionInput({ version: 2, roles: ['role-employee'] }),
    )

    expect(first.record.rolesJson).toEqual(['role-employee'])
    expect(first.record.expiresAt?.getTime()).toBe(fixedExpiry)
  })

  it('retains only the immediately superseded key across rapid version bumps', async () => {
    const { em } = createMockEm()
    const first = await provisionPlatformAutoApiKey(em, provisionInput())
    const second = await provisionPlatformAutoApiKey(em, provisionInput({ version: 2 }))
    const third = await provisionPlatformAutoApiKey(em, provisionInput({ version: 3 }))

    expect(first.record.expiresAt?.getTime()).toBeLessThanOrEqual(Date.now())
    expect(second.record.expiresAt?.getTime()).toBeGreaterThan(Date.now())
    expect(third.record.expiresAt).toBeNull()
  })

  it('re-checks the encoded user entitlement and exact noli org at use time', async () => {
    const { em, users, organizations } = createMockEm()
    users.push(
      Object.assign(new User(), {
        id: localUserId,
        clerkUserId: 'clerk-user-1',
        tenantId,
        organizationId: orgId,
        isConfirmed: true,
        deletedAt: null,
      }),
    )
    organizations.push(
      Object.assign(new Organization(), {
        id: orgId,
        noliOrgId: 'noli-org-1',
        isActive: true,
        deletedAt: null,
      }),
    )
    const provisioned = await provisionPlatformAutoApiKey(em, provisionInput())

    await expect(isPlatformAutoApiKeyAuthorized(em, provisioned.record)).resolves.toBe(true)
    expect(mockFindNoliUserById).toHaveBeenCalledWith(userId)
    expect(mockIsEntitled).toHaveBeenCalledWith(userId, 'crm')
    expect(mockHasNoliOrgMembership).toHaveBeenCalledWith(userId, 'noli-org-1')

    mockIsEntitled.mockResolvedValue(false)
    await expect(findApiKeyBySecret(em, provisioned.secret)).resolves.toBeNull()
  })

  it('validates legacy keys through their exact local creator', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(DEFAULT_PLATFORM_AUTO_LEGACY_CUTOFF_MS - 1)
    const { em, users, organizations } = createMockEm()
    users.push(
      Object.assign(new User(), {
        id: localUserId,
        clerkUserId: 'clerk-user-1',
        tenantId,
        organizationId: orgId,
        isConfirmed: true,
        deletedAt: null,
      }),
    )
    organizations.push(
      Object.assign(new Organization(), {
        id: orgId,
        noliOrgId: 'noli-org-1',
        isActive: true,
        deletedAt: null,
      }),
    )
    const legacy = Object.assign(new ApiKey(), {
      name: 'platform-auto:cos',
      tenantId,
      organizationId: orgId,
      createdBy: localUserId,
    })

    await expect(isPlatformAutoApiKeyAuthorized(em, legacy)).resolves.toBe(true)
    expect(mockFindUserByClerkId).toHaveBeenCalledWith('clerk-user-1')

    mockHasNoliOrgMembership.mockResolvedValue(false)
    await expect(isPlatformAutoApiKeyAuthorized(em, legacy)).resolves.toBe(false)
  })

  it('fails closed for malformed v2 metadata instead of treating it as legacy', async () => {
    const { em, users, organizations } = createMockEm()
    users.push(
      Object.assign(new User(), {
        id: localUserId,
        clerkUserId: 'clerk-user-1',
        tenantId,
        organizationId: orgId,
        isConfirmed: true,
        deletedAt: null,
      }),
    )
    organizations.push(
      Object.assign(new Organization(), {
        id: orgId,
        noliOrgId: 'noli-org-1',
        isActive: true,
        deletedAt: null,
      }),
    )
    const malformed = Object.assign(new ApiKey(), {
      name: 'platform-auto:v2:not-valid',
      tenantId,
      organizationId: orgId,
      createdBy: localUserId,
    })

    await expect(isPlatformAutoApiKeyAuthorized(em, malformed)).resolves.toBe(false)
    expect(mockFindNoliUserById).not.toHaveBeenCalled()
    expect(mockFindUserByClerkId).not.toHaveBeenCalled()
  })

  it('hard-bounds legacy authentication even when configuration tries to extend it', () => {
    expect(getPlatformAutoLegacyCutoffMs(undefined)).toBe(
      DEFAULT_PLATFORM_AUTO_LEGACY_CUTOFF_MS,
    )
    expect(getPlatformAutoLegacyCutoffMs('2035-01-01T00:00:00.000Z')).toBe(
      ABSOLUTE_PLATFORM_AUTO_LEGACY_CUTOFF_MS,
    )
    expect(getPlatformAutoLegacyCutoffMs('not-a-date')).toBe(0)
    expect(isLegacyPlatformAutoKeyUsable(DEFAULT_PLATFORM_AUTO_LEGACY_CUTOFF_MS - 1)).toBe(true)
    expect(isLegacyPlatformAutoKeyUsable(DEFAULT_PLATFORM_AUTO_LEGACY_CUTOFF_MS)).toBe(false)
    expect(isLegacyPlatformAutoKeyUsable(Date.now(), 'not-a-date')).toBe(false)
  })
})
