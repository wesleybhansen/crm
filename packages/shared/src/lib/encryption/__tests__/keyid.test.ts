import { describe, expect, it } from '@jest/globals'
import crypto from 'crypto'
import {
  CURRENT_ENVELOPE_VERSION,
  TenantDataEncryptionError,
  TenantDataEncryptionErrorCode,
  decryptWithAesGcm,
  decryptWithAesGcmStrict,
  encryptWithAesGcm,
  isEncryptedEnvelope,
  keyIdForDek,
  keyIdFromEnvelope,
} from '../aes'

const keyA = crypto.randomBytes(32).toString('base64')
const keyB = crypto.randomBytes(32).toString('base64')

/** Rewrite a v2 envelope as the bare `iv:ct:tag:v1` shape written before key ids existed. */
function asV1(envelope: string): string {
  const [iv, ct, tag] = envelope.split(':')
  return [iv, ct, tag, 'v1'].join(':')
}

describe('envelope v2 with key id', () => {
  it('round trips and stamps the writing key id', () => {
    const env = encryptWithAesGcm('hello', keyA).value as string
    const parts = env.split(':')
    expect(parts).toHaveLength(5)
    expect(parts[3]).toBe(CURRENT_ENVELOPE_VERSION)
    expect(parts[3]).toBe('v2')
    expect(parts[4]).toBe(keyIdForDek(keyA))
    expect(keyIdFromEnvelope(env)).toBe(keyIdForDek(keyA))
    expect(isEncryptedEnvelope(env)).toBe(true)
    expect(decryptWithAesGcm(env, keyA)).toBe('hello')
    expect(decryptWithAesGcmStrict(env, keyA)).toBe('hello')
  })

  it('derives a stable key id that differs per key', () => {
    expect(keyIdForDek(keyA)).toMatch(/^[0-9a-f]{8}$/)
    expect(keyIdForDek(keyA)).toBe(keyIdForDek(keyA))
    expect(keyIdForDek(keyA)).not.toBe(keyIdForDek(keyB))
  })

  it('keeps reading legacy v1 envelopes with the current key', () => {
    const legacy = asV1(encryptWithAesGcm('legacy', keyA).value as string)
    expect(legacy.split(':')).toHaveLength(4)
    expect(isEncryptedEnvelope(legacy)).toBe(true)
    expect(keyIdFromEnvelope(legacy)).toBeNull()
    expect(decryptWithAesGcm(legacy, keyA)).toBe('legacy')
    expect(decryptWithAesGcmStrict(legacy, keyA)).toBe('legacy')
  })

  it('keeps reading the interim v1.<keyId> stamp', () => {
    const env = encryptWithAesGcm('interim', keyA).value as string
    const [iv, ct, tag] = env.split(':')
    const interim = [iv, ct, tag, `v1.${keyIdForDek(keyA)}`].join(':')
    expect(isEncryptedEnvelope(interim)).toBe(true)
    expect(keyIdFromEnvelope(interim)).toBe(keyIdForDek(keyA))
    expect(decryptWithAesGcmStrict(interim, keyA)).toBe('interim')
  })

  it('fails a v2 envelope whose key id does not match, naming both ids and neither key', () => {
    const env = encryptWithAesGcm('secret-value', keyA).value as string
    let thrown: TenantDataEncryptionError | null = null
    try {
      decryptWithAesGcmStrict(env, keyB)
    } catch (err) {
      thrown = err as TenantDataEncryptionError
    }
    expect(thrown).toBeInstanceOf(TenantDataEncryptionError)
    expect(thrown!.code).toBe(TenantDataEncryptionErrorCode.WRONG_KEY)
    expect(thrown!.stampedKeyId).toBe(keyIdForDek(keyA))
    expect(thrown!.activeKeyId).toBe(keyIdForDek(keyB))
    expect(thrown!.message).toContain(keyIdForDek(keyA))
    expect(thrown!.message).toContain(keyIdForDek(keyB))
    // Never the key material, never the plaintext.
    expect(thrown!.message).not.toContain(keyA)
    expect(thrown!.message).not.toContain(keyB)
    expect(thrown!.message).not.toContain('secret-value')
  })

  it('reports the mismatch loudly on the tolerant path too', () => {
    const errors: unknown[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { errors.push(args) }
    try {
      const env = encryptWithAesGcm('hello', keyA).value as string
      expect(decryptWithAesGcm(env, keyB)).toBeNull()
      expect(JSON.stringify(errors)).toContain('decrypt_key_mismatch')
      expect(JSON.stringify(errors)).not.toContain(keyA)
    } finally {
      console.error = orig
    }
  })

  it('treats a legacy v1 envelope opened with the wrong key as an auth failure', () => {
    // v1 carries no key id, so the tag is the only defence and the error says so.
    const legacy = asV1(encryptWithAesGcm('hello', keyA).value as string)
    expect(() => decryptWithAesGcmStrict(legacy, keyB)).toThrow(TenantDataEncryptionError)
    try {
      decryptWithAesGcmStrict(legacy, keyB)
    } catch (err) {
      expect((err as TenantDataEncryptionError).code).toBe(TenantDataEncryptionErrorCode.AUTH_FAILED)
    }
  })

  it('does not mistake plaintext for an envelope', () => {
    for (const plain of ['', 'hello', 'a:b:c:d', 'a:b:c:v3', 'a:b:c:v2', 'a:b:c:v2:zzzzzzzz', 'a:b:c:v1.xy']) {
      expect(isEncryptedEnvelope(plain)).toBe(false)
    }
    expect(() => decryptWithAesGcmStrict('not-an-envelope', keyA)).toThrow(TenantDataEncryptionError)
  })

  it('reads back an encrypted empty string (zero-length ciphertext is valid AES-GCM)', () => {
    // The write path has always encrypted '' this way; rejecting it made every
    // contact saved with an empty field show "could not be decrypted".
    const env = encryptWithAesGcm('', keyA).value as string
    expect(env.split(':')[1]).toBe('')
    expect(isEncryptedEnvelope(env)).toBe(true)
    expect(decryptWithAesGcmStrict(env, keyA)).toBe('')
    expect(() => decryptWithAesGcmStrict(env, keyB)).toThrow(TenantDataEncryptionError)
  })
})
