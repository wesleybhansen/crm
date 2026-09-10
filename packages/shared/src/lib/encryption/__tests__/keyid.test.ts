import { describe, expect, it } from '@jest/globals'
import crypto from 'crypto'
import { decryptWithAesGcm, encryptWithAesGcm, isV1Version, keyIdForDek, keyIdFromVersion } from '../aes'

const keyA = crypto.randomBytes(32).toString('base64')
const keyB = crypto.randomBytes(32).toString('base64')

describe('envelope key id', () => {
  it('stamps the writing key id into the version slot and still reads as v1', () => {
    const env = encryptWithAesGcm('hello', keyA).value
    const version = env.split(':')[3]
    expect(isV1Version(version)).toBe(true)
    expect(keyIdFromVersion(version)).toBe(keyIdForDek(keyA))
    expect(decryptWithAesGcm(env, keyA)).toBe('hello')
  })

  it('refuses to open an envelope written by a different key, detectably', () => {
    const errors: unknown[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { errors.push(args) }
    try {
      const env = encryptWithAesGcm('hello', keyA).value
      expect(decryptWithAesGcm(env, keyB)).toBeNull()
      expect(JSON.stringify(errors)).toContain('decrypt_key_mismatch')
    } finally {
      console.error = orig
    }
  })

  it('keeps reading envelopes written before the stamp existed', () => {
    const stamped = encryptWithAesGcm('legacy', keyA).value
    const parts = stamped.split(':')
    parts[3] = 'v1'
    const legacy = parts.join(':')
    expect(isV1Version('v1')).toBe(true)
    expect(keyIdFromVersion('v1')).toBeNull()
    expect(decryptWithAesGcm(legacy, keyA)).toBe('legacy')
  })
})
