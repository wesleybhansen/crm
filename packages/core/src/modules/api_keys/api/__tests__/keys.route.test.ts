/** @jest-environment node */

import { features } from '../../acl'

const secretFixture = { secret: 'omk_test.secret', prefix: 'omk_testpref' }

type QueueEntry = { entity?: unknown }
type OrmEntityInput = { data: Record<string, unknown>; [key: string]: unknown }

interface MockEntityManager {
  findOne: jest.Mock<Promise<unknown>, [unknown, Record<string, unknown>?]>
  find: jest.Mock<Promise<unknown[]>, [unknown, Record<string, unknown>?]>
  fork: jest.Mock<MockEntityManager, []>
  createQueryBuilder: jest.Mock<MockQueryBuilder, [unknown, string]>
}

interface MockQueryBuilder {
  where: jest.Mock<MockQueryBuilder, [Record<string, unknown>]>
  andWhere: jest.Mock<MockQueryBuilder, [Record<string, unknown>]>
  orderBy: jest.Mock<MockQueryBuilder, [Record<string, unknown>]>
  limit: jest.Mock<MockQueryBuilder, [number]>
  offset: jest.Mock<MockQueryBuilder, [number]>
  getResultAndCount: jest.Mock<Promise<[unknown[], number]>, []>
}

interface MockDataEngine {
  __queue: QueueEntry[]
  createOrmEntity: jest.Mock<Promise<Record<string, unknown>>, [OrmEntityInput]>
  emitOrmEntityEvent: jest.Mock<Promise<void>, [QueueEntry | undefined]>
  markOrmEntityChange: jest.Mock<void, [QueueEntry | undefined]>
  flushOrmEntityChanges: jest.Mock<Promise<void>, []>
}

interface MockRbacService {
  invalidateUserCache: jest.Mock<Promise<void>, [string]>
  loadAcl: jest.Mock<Promise<{ isSuperAdmin: boolean } | null>, [string, { tenantId: string | null; organizationId: string | null }]>
}

interface MockContainer {
  resolve: jest.Mock<unknown, [string]>
}

const queue: QueueEntry[] = []

const mockGetAuthFromCookies = jest.fn()
const mockGetAuthFromRequest = jest.fn()
const mockResolveScope = jest.fn()
const mockQueryBuilder = {} as MockQueryBuilder
mockQueryBuilder.where = jest.fn(() => mockQueryBuilder)
mockQueryBuilder.andWhere = jest.fn(() => mockQueryBuilder)
mockQueryBuilder.orderBy = jest.fn(() => mockQueryBuilder)
mockQueryBuilder.limit = jest.fn(() => mockQueryBuilder)
mockQueryBuilder.offset = jest.fn(() => mockQueryBuilder)
mockQueryBuilder.getResultAndCount = jest.fn()
const mockEm: MockEntityManager = {
  findOne: jest.fn<Promise<unknown>, [unknown, Record<string, unknown>?]>(),
  find: jest.fn<Promise<unknown[]>, [unknown, Record<string, unknown>?]>(),
  fork: jest.fn<MockEntityManager, []>(),
  createQueryBuilder: jest.fn(() => mockQueryBuilder),
}
const mockDataEngine: MockDataEngine = {
  __queue: queue,
  createOrmEntity: jest.fn<Promise<Record<string, unknown>>, [OrmEntityInput]>(),
  emitOrmEntityEvent: jest.fn<Promise<void>, [QueueEntry | undefined]>(),
  markOrmEntityChange: jest.fn<void, [QueueEntry | undefined]>(),
  flushOrmEntityChanges: jest.fn<Promise<void>, []>(),
}
const mockRbac: MockRbacService = {
  invalidateUserCache: jest.fn<Promise<void>, [string]>(),
  loadAcl: jest.fn<Promise<{ isSuperAdmin: boolean } | null>, [string, { tenantId: string | null; organizationId: string | null }]>(),
}
const mockContainer: MockContainer = {
  resolve: jest.fn((token: string) => {
    if (token === 'em') return mockEm
    if (token === 'dataEngine') return mockDataEngine
    if (token === 'rbacService') return mockRbac
    return undefined
  }),
}
const mockHashApiKey = jest.fn<Promise<string>, [string]>((secret) => Promise.resolve(`hashed:${secret}`))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => mockContainer),
}))

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromCookies: jest.fn(() => mockGetAuthFromCookies()),
  getAuthFromRequest: jest.fn((request: Request) => mockGetAuthFromRequest(request)),
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: jest.fn((args) => mockResolveScope(args)),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(async () => ({
    translate: (_key: string, fallback: string) => fallback,
  })),
}))

jest.mock('../../services/apiKeyService', () => {
  const actual = jest.requireActual('../../services/apiKeyService')
  return {
    ...actual,
    generateApiKeySecret: jest.fn(() => secretFixture),
    hashApiKey: jest.fn((secret: string) => mockHashApiKey(secret)),
  }
})

type RouteModule = typeof import('../keys/route')
let routeMetadata: RouteModule['metadata']
let getHandler: RouteModule['GET']
let postHandler: RouteModule['POST']
let deleteHandler: RouteModule['DELETE']

beforeAll(async () => {
  const routeModule = await import('../keys/route')
  routeMetadata = routeModule.metadata
  getHandler = routeModule.GET
  postHandler = routeModule.POST
  deleteHandler = routeModule.DELETE
})

describe('API Keys route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockDataEngine.__queue.length = 0
    mockEm.fork.mockReturnValue(mockEm)
    mockGetAuthFromCookies.mockResolvedValue({
      sub: 'user-1',
      tenantId: '123e4567-e89b-12d3-a456-426614174000',
      orgId: null,
    })
    mockGetAuthFromRequest.mockResolvedValue({
      sub: 'user-1',
      tenantId: '123e4567-e89b-12d3-a456-426614174000',
      orgId: null,
    })
    mockResolveScope.mockResolvedValue({
      selectedId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      filterIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      allowedIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    })
    mockEm.findOne.mockResolvedValue(null)
    mockQueryBuilder.getResultAndCount.mockResolvedValue([[], 0])
    mockEm.find.mockImplementation(async (_entity: unknown, criteria: Record<string, unknown> = {}) => {
      const nameValue = typeof criteria.name === 'string' ? criteria.name : null
      if (nameValue && nameValue.toLowerCase() === 'manager') {
        return [
          {
            id: 'role-123',
            name: 'Manager',
            tenantId: '123e4567-e89b-12d3-a456-426614174000',
          },
        ]
      }
      if (criteria && typeof criteria === 'object' && 'id' in criteria) {
        const idCandidate = (criteria as { id?: unknown }).id
        if (idCandidate && typeof idCandidate === 'object' && '$in' in idCandidate) {
          const ids = (idCandidate as { $in?: unknown }).$in
          if (Array.isArray(ids)) {
            return ids.map((id) => ({
              id: String(id),
              name: id === 'role-123' ? 'Manager' : null,
              tenantId: '123e4567-e89b-12d3-a456-426614174000',
            }))
          }
        }
      }
      return []
    })
    mockDataEngine.createOrmEntity.mockImplementation(async ({ data }: OrmEntityInput) => ({
      id: 'key-1',
      ...data,
    }))
    mockDataEngine.emitOrmEntityEvent.mockResolvedValue(undefined)
    mockDataEngine.markOrmEntityChange.mockImplementation((entry: QueueEntry | undefined) => {
      if (!entry?.entity) return
      mockDataEngine.__queue.push(entry)
    })
    mockDataEngine.flushOrmEntityChanges.mockImplementation(async () => {
      while (mockDataEngine.__queue.length > 0) {
        const next = mockDataEngine.__queue.shift()
        await mockDataEngine.emitOrmEntityEvent(next)
      }
    })
    mockRbac.invalidateUserCache.mockResolvedValue(undefined)
    mockRbac.loadAcl.mockResolvedValue({ isSuperAdmin: false })
    mockHashApiKey.mockClear()
  })

  it('exports the expected ACL features', () => {
    const featureIds = features.map((entry) => entry.id)
    expect(featureIds).toEqual(expect.arrayContaining(['api_keys.view', 'api_keys.create', 'api_keys.delete']))
  })

  it('declares authorization metadata for GET/POST/DELETE', () => {
    expect(routeMetadata.GET?.requireAuth).toBe(true)
    expect(routeMetadata.GET?.requireFeatures).toEqual(['api_keys.view'])
    expect(routeMetadata.POST?.requireAuth).toBe(true)
    expect(routeMetadata.POST?.requireFeatures).toEqual(['api_keys.create'])
    expect(routeMetadata.DELETE?.requireAuth).toBe(true)
    expect(routeMetadata.DELETE?.requireFeatures).toEqual(['api_keys.delete'])
  })

  it('creates API keys with organization scope, hashed secret, and role mapping', async () => {
    const body = {
      name: 'Integration key',
      description: 'Machine access',
      roles: ['manager'],
    }
    const res = await postHandler(
      new Request('http://localhost/api/api_keys/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    expect(res.status).toBe(201)
    const payload = await res.json()
    expect(payload).toMatchObject({
      id: 'key-1',
      name: 'Integration key',
      keyPrefix: secretFixture.prefix,
      secret: secretFixture.secret,
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tenantId: '123e4567-e89b-12d3-a456-426614174000',
    })
    expect(payload.roles).toEqual([{ id: 'role-123', name: 'Manager' }])
    expect(mockDataEngine.createOrmEntity).toHaveBeenCalledTimes(1)
    const createArgs = mockDataEngine.createOrmEntity.mock.calls[0][0]
    expect(createArgs.data).toMatchObject({
      name: 'Integration key',
      description: 'Machine access',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tenantId: '123e4567-e89b-12d3-a456-426614174000',
      createdBy: 'user-1',
      rolesJson: ['role-123'],
      keyPrefix: secretFixture.prefix,
      keyHash: `hashed:${secretFixture.secret}`,
    })
    expect(mockHashApiKey).toHaveBeenCalledWith(secretFixture.secret)
    expect(mockRbac.invalidateUserCache).toHaveBeenCalledWith('api_key:key-1')
  })

  it('rejects creation when organization is outside the allowed scope', async () => {
    mockResolveScope.mockResolvedValueOnce({
      selectedId: null,
      filterIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      allowedIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    })
    const res = await postHandler(
      new Request('http://localhost/api/api_keys/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Forbidden key',
          organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        }),
      }),
    )
    expect(res.status).toBe(403)
    const payload = await res.json()
    expect(payload.error).toBe('Organization out of scope')
    expect(mockDataEngine.createOrmEntity).not.toHaveBeenCalled()
  })

  it('rejects reserved platform-auto names on the ordinary creation surface', async () => {
    const res = await postHandler(
      new Request('http://localhost/api/api_keys/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'platform-auto:cos' }),
      }),
    )

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({
      error: 'platform-auto is a reserved key name',
    })
    expect(mockDataEngine.createOrmEntity).not.toHaveBeenCalled()
  })

  it('excludes managed platform-auto rows from the ordinary list query', async () => {
    const res = await getHandler(
      new Request('http://localhost/api/api_keys/keys', { method: 'GET' }),
    )

    expect(res.status).toBe(200)
    expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith({
      $not: { name: { $like: 'platform-auto:%' } },
    })
  })

  it('rejects deletion of managed platform-auto rows', async () => {
    mockEm.findOne.mockResolvedValueOnce({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'platform-auto:v2:dXNlcg:0123456789abcdef01234567:1',
      tenantId: '123e4567-e89b-12d3-a456-426614174000',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      deletedAt: null,
    })

    const res = await deleteHandler(
      new Request('http://localhost/api/api_keys/keys?id=cccccccc-cccc-4ccc-8ccc-cccccccccccc', {
        method: 'DELETE',
      }),
    )

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({
      error: 'Managed platform keys cannot be deleted here',
    })
  })
})
