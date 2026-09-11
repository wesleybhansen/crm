/** @jest-environment node */
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals'
import crypto from 'crypto'
import { encryptWithAesGcm } from '../aes'
import {
  isSealedSecret,
  openSecretForTenant,
  openSecretsOnRow,
  openSecretsOnRows,
  sealSecretForTenant,
  type TenantEncryptionLike,
} from '../secretColumns'

const keyA = crypto.randomBytes(32).toString('base64')
const keyB = crypto.randomBytes(32).toString('base64')
const TENANT = '11111111-1111-4111-8111-111111111111'

function service(key: string | null, enabled = true): TenantEncryptionLike {
  return {
    isEnabled: () => enabled,
    getDek: async () => (key ? { key } : null),
  }
}

let errors: unknown[][] = []
const originalError = console.error

beforeEach(() => {
  errors = []
  console.error = (...args: unknown[]) => { errors.push(args) }
})

afterEach(() => {
  console.error = originalError
})

describe('sealSecretForTenant', () => {
  it('produces an envelope that opens back to the original', async () => {
    const svc = service(keyA)
    const sealed = await sealSecretForTenant(svc, TENANT, 'app-password')
    expect(sealed).not.toBe('app-password')
    expect(isSealedSecret(sealed)).toBe(true)
    expect(await openSecretForTenant(svc, TENANT, sealed)).toBe('app-password')
  })

  it('passes null through and keeps an empty string empty', async () => {
    const svc = service(keyA)
    expect(await sealSecretForTenant(svc, TENANT, null)).toBeNull()
    expect(await sealSecretForTenant(svc, TENANT, undefined)).toBeNull()
    // Some of these columns are NOT NULL, so '' is how they get scrubbed.
    expect(await sealSecretForTenant(svc, TENANT, '')).toBe('')
  })

  it('never double-wraps a value that is already sealed', async () => {
    const svc = service(keyA)
    const once = await sealSecretForTenant(svc, TENANT, 'token')
    const twice = await sealSecretForTenant(svc, TENANT, once)
    expect(twice).toBe(once)
  })

  it('stores plaintext rather than failing when no key is available', async () => {
    expect(await sealSecretForTenant(service(null), TENANT, 'token')).toBe('token')
    expect(await sealSecretForTenant(service(keyA, false), TENANT, 'token')).toBe('token')
    expect(await sealSecretForTenant(service(keyA), null, 'token')).toBe('token')
  })
})

describe('openSecretForTenant', () => {
  it('returns legacy plaintext unchanged', async () => {
    // Rows written before this helper existed hold a bare credential.
    expect(await openSecretForTenant(service(keyA), TENANT, 'legacy-plaintext')).toBe('legacy-plaintext')
    // A colon-bearing credential that is not our envelope is still plaintext.
    expect(await openSecretForTenant(service(keyA), TENANT, 'user:pass:region:us')).toBe('user:pass:region:us')
  })

  it('passes null and empty through', async () => {
    expect(await openSecretForTenant(service(keyA), TENANT, null)).toBeNull()
    expect(await openSecretForTenant(service(keyA), TENANT, undefined)).toBeNull()
    expect(await openSecretForTenant(service(keyA), TENANT, '')).toBe('')
  })

  it('returns null and logs, redacted, when the envelope was written by another key', async () => {
    const sealed = encryptWithAesGcm('token', keyA).value
    expect(await openSecretForTenant(service(keyB), TENANT, sealed)).toBeNull()
    const logged = JSON.stringify(errors)
    expect(logged).toContain('decrypt_key_mismatch')
    expect(logged).not.toContain('token')
  })

  it('returns null, never ciphertext, when no key is available', async () => {
    const sealed = encryptWithAesGcm('token', keyA).value
    expect(await openSecretForTenant(service(null), TENANT, sealed)).toBeNull()
    expect(JSON.stringify(errors)).toContain('secret_open_no_key')
  })
})

describe('openSecretsOnRow', () => {
  it('opens the named fields and leaves the stored row untouched', async () => {
    const svc = service(keyA)
    const row = {
      id: 'c1',
      tenant_id: TENANT,
      email_address: 'a@b.com',
      access_token: await sealSecretForTenant(svc, TENANT, 'access'),
      refresh_token: await sealSecretForTenant(svc, TENANT, 'refresh'),
      smtp_pass: 'legacy-plain',
    }
    const stored = { ...row }
    const opened = await openSecretsOnRow(svc, TENANT, row, ['access_token', 'refresh_token', 'smtp_pass'])
    expect(opened).toMatchObject({
      access_token: 'access',
      refresh_token: 'refresh',
      smtp_pass: 'legacy-plain',
      email_address: 'a@b.com',
    })
    expect(row).toEqual(stored)
  })

  it('ignores absent fields and null rows', async () => {
    expect(await openSecretsOnRow(service(keyA), TENANT, null, ['access_token'])).toBeNull()
    const opened = await openSecretsOnRow(service(keyA), TENANT, { id: 'x' }, ['access_token'])
    expect(opened).toEqual({ id: 'x' })
  })

  it('uses each row\'s own tenant when opening a list', async () => {
    const svc = service(keyA)
    const rows = [
      { tenant_id: TENANT, api_key: await sealSecretForTenant(svc, TENANT, 'k1') },
      { tenant_id: TENANT, api_key: 'legacy' },
    ]
    const opened = await openSecretsOnRows(svc, null, rows, ['api_key'])
    expect(opened.map((r) => r.api_key)).toEqual(['k1', 'legacy'])
  })
})
