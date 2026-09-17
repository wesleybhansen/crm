import { afterEach, beforeEach, describe, expect, it } from '@jest/globals'

const KEYS = [
  'TENANT_KMS_PROVIDER',
  'TENANT_DATA_KMS',
  'TENANT_DATA_ENCRYPTION',
  'TENANT_DATA_ENCRYPTION_KEY',
  'TENANT_DATA_ENCRYPTION_FALLBACK_KEY',
  'AUTH_SECRET',
  'NEXTAUTH_SECRET',
  'VAULT_ADDR',
  'VAULT_TOKEN',
] as const

describe('tenant KMS provider selection', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
    jest.resetModules()
  })

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  const load = async () => await import('../kms')

  it('defaults to the derived scheme, never Vault', async () => {
    const { resolveTenantKmsProvider, DEFAULT_TENANT_KMS_PROVIDER } = await load()
    expect(DEFAULT_TENANT_KMS_PROVIDER).toBe('derived')
    expect(resolveTenantKmsProvider()).toBe('derived')
    // A configured, reachable Vault does not take over on its own.
    process.env.VAULT_ADDR = 'http://127.0.0.1:8200'
    process.env.VAULT_TOKEN = 'unused-in-this-test'
    expect(resolveTenantKmsProvider()).toBe('derived')
  })

  it('opts in to Vault only through TENANT_KMS_PROVIDER=vault (or the legacy name)', async () => {
    const { resolveTenantKmsProvider } = await load()
    process.env.TENANT_KMS_PROVIDER = 'vault'
    expect(resolveTenantKmsProvider()).toBe('vault')
    delete process.env.TENANT_KMS_PROVIDER
    process.env.TENANT_DATA_KMS = 'vault'
    expect(resolveTenantKmsProvider()).toBe('vault')
    process.env.TENANT_DATA_KMS = 'derived'
    expect(resolveTenantKmsProvider()).toBe('derived')
  })

  it('prefers TENANT_DATA_ENCRYPTION_KEY over the fallback variable', async () => {
    process.env.TENANT_DATA_ENCRYPTION_KEY = 'dedicated-data-key-value-32-chars-long'
    process.env.TENANT_DATA_ENCRYPTION_FALLBACK_KEY = 'legacy-fallback-key-value-32-chars-ok'
    const { createKmsService } = await load()
    const dedicated = await createKmsService().getTenantDek('tenant-1')

    jest.resetModules()
    delete process.env.TENANT_DATA_ENCRYPTION_KEY
    const { createKmsService: create2 } = await import('../kms')
    const fallbackOnly = await create2().getTenantDek('tenant-1')

    expect(dedicated?.key).toBeTruthy()
    expect(fallbackOnly?.key).toBeTruthy()
    // Different secrets must derive different keys, which proves the dedicated
    // variable was the one being read in the first case.
    expect(dedicated?.key).not.toBe(fallbackOnly?.key)
  })

  it('never derives the data key from AUTH_SECRET or NEXTAUTH_SECRET', async () => {
    process.env.NODE_ENV = 'production'
    process.env.AUTH_SECRET = 'session-secret-that-must-not-be-a-data-key'
    process.env.NEXTAUTH_SECRET = 'also-a-session-secret'
    const { createKmsService } = await load()
    expect(() => createKmsService()).toThrow(/TENANT_DATA_ENCRYPTION_KEY/)
  })

  it('fails closed in production when neither key variable is set', async () => {
    process.env.NODE_ENV = 'production'
    const { createKmsService } = await load()
    expect(() => createKmsService()).toThrow(/refusing to run/)
  })

  it('stays a noop when tenant data encryption is switched off', async () => {
    process.env.TENANT_DATA_ENCRYPTION = 'no'
    const { createKmsService } = await load()
    const svc = createKmsService()
    expect(svc.isHealthy()).toBe(true)
    expect(await svc.getTenantDek('tenant-1')).toBeNull()
  })
})
