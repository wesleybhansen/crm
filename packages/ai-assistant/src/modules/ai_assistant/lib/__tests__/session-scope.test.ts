import { isPlatformTransportKey, sessionAllowedForKey } from '../session-scope'

describe('MCP _sessionToken scope', () => {
  const key = { tenantId: 'tenant-a', organizationId: 'org-a' }

  it("accepts a session from the key's own tenant and organization", () => {
    expect(sessionAllowedForKey({ tenantId: 'tenant-a', organizationId: 'org-a' }, key, { transportKey: false })).toBe(true)
  })

  it("refuses a session from another tenant or another organization", () => {
    expect(sessionAllowedForKey({ tenantId: 'tenant-b', organizationId: 'org-b' }, key, { transportKey: false })).toBe(false)
    expect(sessionAllowedForKey({ tenantId: 'tenant-a', organizationId: 'org-b' }, key, { transportKey: false })).toBe(false)
    expect(sessionAllowedForKey({ tenantId: null, organizationId: null }, key, { transportKey: false })).toBe(false)
  })

  it('lets a tenant-wide key use sessions of any organization in its tenant, only', () => {
    const tenantKey = { tenantId: 'tenant-a', organizationId: null }
    expect(sessionAllowedForKey({ tenantId: 'tenant-a', organizationId: 'org-x' }, tenantKey, { transportKey: false })).toBe(true)
    expect(sessionAllowedForKey({ tenantId: 'tenant-b', organizationId: 'org-x' }, tenantKey, { transportKey: false })).toBe(false)
  })

  it('refuses tenant sessions for a tenant-less key unless it is the platform transport key', () => {
    const globalKey = { tenantId: null, organizationId: null }
    expect(sessionAllowedForKey({ tenantId: 'tenant-b', organizationId: 'org-b' }, globalKey, { transportKey: false })).toBe(false)
    expect(sessionAllowedForKey({ tenantId: 'tenant-b', organizationId: 'org-b' }, globalKey, { transportKey: true })).toBe(true)
  })

  it('recognises only the configured MCP_SERVER_API_KEY as the transport key', () => {
    const env = { MCP_SERVER_API_KEY: 'omk_server.secret' }
    expect(isPlatformTransportKey('omk_server.secret', env)).toBe(true)
    expect(isPlatformTransportKey('omk_other.secret', env)).toBe(false)
    expect(isPlatformTransportKey('omk_server.secret', {})).toBe(false)
    expect(isPlatformTransportKey(null, env)).toBe(false)
  })
})
