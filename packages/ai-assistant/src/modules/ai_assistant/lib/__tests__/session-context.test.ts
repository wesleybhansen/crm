/**
 * MCP `_sessionToken` (MCP sweep 2026-09-25): the HTTP server must not swap
 * in a session from another tenant/organization than the calling API key.
 */
const mockFindSession = jest.fn()
jest.mock('@open-mercato/core/modules/api_keys/services/apiKeyService', () => ({
  findApiKeyBySecret: jest.fn(),
  findSessionApiKeyWithSecret: (...args: unknown[]) => mockFindSession(...args),
}))

jest.mock('../agent-guide-tool', () => ({ MCP_BOOTSTRAP_INSTRUCTIONS: '' }))
jest.mock('../tool-loader', () => ({ loadAllModuleTools: jest.fn(), indexToolsForSearch: jest.fn() }))

import { resolveSessionContext, type McpRequestContext } from '../http-server'

function baseContext(overrides: Partial<McpRequestContext> = {}): McpRequestContext {
  const rbacService = { loadAcl: jest.fn(async () => ({ features: ['customers.*'], isSuperAdmin: false })) }
  const container = { resolve: (name: string) => (name === 'rbacService' ? rbacService : {}) } as never
  return {
    tenantId: 'tenant-a',
    organizationId: 'org-a',
    userId: 'key-owner',
    container,
    userFeatures: [],
    isSuperAdmin: false,
    apiKeySecret: 'omk_a.secret',
    keyTenantId: 'tenant-a',
    keyOrganizationId: 'org-a',
    isTransportKey: false,
    ...overrides,
  }
}

function sessionIn(tenantId: string, organizationId: string) {
  return {
    key: { id: 'session-key', tenantId, organizationId, sessionUserId: 'session-user', createdBy: null },
    secret: 'omk_session.secret',
  }
}

describe('resolveSessionContext', () => {
  beforeEach(() => mockFindSession.mockReset())

  it("swaps in a session from the key's own tenant and organization", async () => {
    mockFindSession.mockResolvedValue(sessionIn('tenant-a', 'org-a'))
    const ctx = await resolveSessionContext('sess_ok', baseContext())
    expect(ctx).toMatchObject({ tenantId: 'tenant-a', organizationId: 'org-a', userId: 'session-user', apiKeySecret: 'omk_session.secret' })
  })

  it("refuses another tenant's session for a tenant-scoped API key", async () => {
    mockFindSession.mockResolvedValue(sessionIn('tenant-b', 'org-b'))
    expect(await resolveSessionContext('sess_other_tenant', baseContext())).toBe('wrong-scope')
  })

  it("refuses another organization's session in the same tenant", async () => {
    mockFindSession.mockResolvedValue(sessionIn('tenant-a', 'org-b'))
    expect(await resolveSessionContext('sess_other_org', baseContext())).toBe('wrong-scope')
  })

  it('lets the platform transport key serve any tenant session', async () => {
    mockFindSession.mockResolvedValue(sessionIn('tenant-b', 'org-b'))
    const ctx = await resolveSessionContext(
      'sess_transport',
      baseContext({ isTransportKey: true, keyTenantId: null, keyOrganizationId: null }),
    )
    expect(ctx).toMatchObject({ tenantId: 'tenant-b', organizationId: 'org-b', userId: 'session-user' })
  })

  it('returns null for an unknown or expired session token', async () => {
    mockFindSession.mockResolvedValue(null)
    expect(await resolveSessionContext('sess_gone', baseContext())).toBeNull()
  })
})
