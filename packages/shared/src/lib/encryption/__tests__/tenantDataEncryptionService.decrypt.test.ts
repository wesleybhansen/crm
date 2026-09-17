import { afterEach, beforeEach, describe, expect, it } from '@jest/globals'
import crypto from 'crypto'
import { encryptWithAesGcm, keyIdForDek, TenantDataEncryptionErrorCode } from '../aes'
import {
  TenantDataEncryptionService,
  TenantDataDecryptError,
  UNDECRYPTABLE_DISPLAY_TEXT,
  isTenantDataDecryptError,
} from '../tenantDataEncryptionService'
import type { KmsService, TenantDek } from '../kms'

const TENANT = '11111111-2222-3333-4444-555555555555'
const ENTITY = 'customers:customer_entity'

const keyA = crypto.randomBytes(32).toString('base64')
const keyB = crypto.randomBytes(32).toString('base64')

function kmsFor(key: string): KmsService {
  return {
    isHealthy: () => true,
    async getTenantDek(tenantId: string): Promise<TenantDek | null> {
      return { tenantId, key, fetchedAt: Date.now() }
    },
    async createTenantDek(tenantId: string): Promise<TenantDek | null> {
      return { tenantId, key, fetchedAt: Date.now() }
    },
  }
}

/** Minimal EntityManager stand-in: the service only needs the encryption map row. */
function emWithMap() {
  return {
    getConnection: () => ({
      execute: async () => [
        {
          entity_id: ENTITY,
          fields_json: [{ field: 'display_name' }, { field: 'primary_email', hashField: 'primary_email_hash' }],
        },
      ],
    }),
  } as any
}

function serviceWith(key: string) {
  return new TenantDataEncryptionService(emWithMap(), { kms: kmsFor(key) })
}

describe('TenantDataEncryptionService decrypt faults', () => {
  let errors: unknown[]
  let originalError: typeof console.error

  beforeEach(() => {
    // The service caches DEKs and encryption maps on static class members.
    ;(TenantDataEncryptionService as any).globalDekCache.clear()
    ;(TenantDataEncryptionService as any).globalMemoryCache.clear()
    ;(TenantDataEncryptionService as any).globalMissCache.clear()
    ;(TenantDataEncryptionService as any).globalInflightMaps.clear()
    errors = []
    originalError = console.error
    console.error = ((...args: unknown[]) => { errors.push(args) }) as typeof console.error
  })

  afterEach(() => {
    console.error = originalError
  })

  it('round trips a payload through encrypt and decrypt', async () => {
    const svc = serviceWith(keyA)
    const encrypted = await svc.encryptEntityPayload(
      ENTITY,
      { display_name: 'Ada Lovelace', primary_email: 'ada@example.com' },
      TENANT,
      null,
    )
    expect(encrypted.display_name).not.toBe('Ada Lovelace')
    expect(String(encrypted.display_name).split(':')).toHaveLength(5)
    expect(encrypted.primary_email_hash).toEqual(expect.any(String))

    const decrypted = await svc.decryptEntityPayload(ENTITY, encrypted, TENANT, null)
    expect(decrypted.display_name).toBe('Ada Lovelace')
    expect(decrypted.primary_email).toBe('ada@example.com')
  })

  it('throws TenantDataDecryptError instead of returning ciphertext when the key is wrong', async () => {
    const written = encryptWithAesGcm('Ada Lovelace', keyA).value as string
    const svc = serviceWith(keyB)

    let thrown: TenantDataDecryptError | null = null
    try {
      await svc.decryptEntityPayload(ENTITY, { display_name: written }, TENANT, null)
    } catch (err) {
      thrown = err as TenantDataDecryptError
    }

    expect(thrown).toBeInstanceOf(TenantDataDecryptError)
    expect(isTenantDataDecryptError(thrown)).toBe(true)
    expect(thrown!.entityId).toBe(ENTITY)
    expect(thrown!.fields).toEqual(['display_name'])
    expect(thrown!.tenantId).toBe(TENANT)
    expect(thrown!.code).toBe(TenantDataEncryptionErrorCode.WRONG_KEY)
    expect(thrown!.stampedKeyId).toBe(keyIdForDek(keyA))
    expect(thrown!.activeKeyId).toBe(keyIdForDek(keyB))
    // Names and key ids only: never the value, never the ciphertext, never the key.
    expect(thrown!.message).toContain('display_name')
    expect(thrown!.message).not.toContain('Ada Lovelace')
    expect(thrown!.message).not.toContain(written)
    expect(thrown!.message).not.toContain(keyA)
    expect(thrown!.message).not.toContain(keyB)
  })

  it('logs the fault with names only', async () => {
    const written = encryptWithAesGcm('Ada Lovelace', keyA).value as string
    const svc = serviceWith(keyB)
    await expect(svc.decryptEntityPayload(ENTITY, { display_name: written }, TENANT, null)).rejects.toBeInstanceOf(
      TenantDataDecryptError,
    )
    const logged = JSON.stringify(errors)
    expect(logged).toContain('decrypt_failed')
    expect(logged).toContain('display_name')
    expect(logged).not.toContain('Ada Lovelace')
    expect(logged).not.toContain(keyA)
    expect(logged).not.toContain(keyB)
  })

  it('gives a list boundary the plain message rather than the ciphertext', async () => {
    const written = encryptWithAesGcm('Ada Lovelace', keyA).value as string
    const svc = serviceWith(keyB)
    const { payload, undecryptableFields } = await svc.decryptEntityPayloadForDisplay(
      ENTITY,
      { id: 'row-1', display_name: written },
      TENANT,
      null,
    )
    expect(undecryptableFields).toEqual(['display_name'])
    expect(payload.display_name).toBe(UNDECRYPTABLE_DISPLAY_TEXT)
    expect(payload.display_name).not.toBe(written)
    expect(payload.id).toBe('row-1')
  })

  it('leaves legacy plaintext alone instead of raising on it', async () => {
    const svc = serviceWith(keyA)
    const decrypted = await svc.decryptEntityPayload(
      ENTITY,
      { display_name: 'written before this field was mapped' },
      TENANT,
      null,
    )
    expect(decrypted.display_name).toBe('written before this field was mapped')
  })

  it('refuses to encrypt the placeholder back over an unreadable column', async () => {
    const svc = serviceWith(keyA)
    const encrypted = await svc.encryptEntityPayload(
      ENTITY,
      { display_name: UNDECRYPTABLE_DISPLAY_TEXT, primary_email: 'ada@example.com' },
      TENANT,
      null,
    )
    // The column is dropped from the write payload, so the stored ciphertext survives.
    expect('display_name' in encrypted).toBe(false)
    expect(encrypted.primary_email).not.toBe('ada@example.com')
    expect(JSON.stringify(errors)).toContain('refused_to_overwrite_undecryptable')
  })
})
