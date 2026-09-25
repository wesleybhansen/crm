import crypto from 'node:crypto'
import { isEncryptionDebugEnabled } from './toggles'

export type EncryptionPayload = {
  value: string | null
  raw: string
  version: string
}

export enum TenantDataEncryptionErrorCode {
  AUTH_FAILED = 'AUTH_FAILED',
  MALFORMED_PAYLOAD = 'MALFORMED_PAYLOAD',
  KMS_UNAVAILABLE = 'KMS_UNAVAILABLE',
  WRONG_KEY = 'WRONG_KEY',
  DECRYPT_INTERNAL = 'DECRYPT_INTERNAL',
}

export class TenantDataEncryptionError extends Error {
  code: TenantDataEncryptionErrorCode
  /** Key id stamped into the envelope (v2 only). Never the key itself. */
  stampedKeyId?: string | null
  /** Key id of the key the process is holding right now. Never the key itself. */
  activeKeyId?: string | null
  constructor(
    code: TenantDataEncryptionErrorCode,
    message: string,
    details?: { stampedKeyId?: string | null; activeKeyId?: string | null },
  ) {
    super(message)
    this.name = 'TenantDataEncryptionError'
    this.code = code
    this.stampedKeyId = details?.stampedKeyId ?? null
    this.activeKeyId = details?.activeKeyId ?? null
  }
}

export function generateDek(): string {
  return crypto.randomBytes(32).toString('base64')
}

function logDebug(event: string, payload: Record<string, unknown>) {
  if (!isEncryptionDebugEnabled()) return
  try {
    // eslint-disable-next-line no-console
    console.debug('[encryption]', event, payload)
  } catch {
    // ignore
  }
}

/* ---------------------------------------------------------------------------
 * Envelope format
 *
 *   v2 (written today): iv:ct:tag:v2:<keyId>   — five colon-separated parts
 *   v1 (read only)    : iv:ct:tag:v1           — no key id at all
 *                       iv:ct:tag:v1.<keyId>   — interim stamp, still read
 *
 * <keyId> is the first 8 hex characters of sha256 over the active key material.
 * The per-tenant DEK is already derived from the root secret AND the tenant
 * salt, so hashing the DEK fingerprints both without ever touching the secret.
 *
 * Why the id exists: without it a wrong key (Vault sealed, secret rotated)
 * surfaces only as "auth tag mismatch", which every caller used to treat as
 * "leave the ciphertext in place". A key swap then showed up as garbled names
 * in the UI instead of an error. With the id, a mismatch is detected before any
 * crypto runs and raises a typed WRONG_KEY error naming the two ids.
 * ------------------------------------------------------------------------- */

export const ENVELOPE_VERSION_V1 = 'v1'
export const ENVELOPE_VERSION_V2 = 'v2'
/** The version new envelopes are written with. */
export const CURRENT_ENVELOPE_VERSION = ENVELOPE_VERSION_V2

export type ParsedEnvelope = {
  ivB64: string
  ciphertextB64: string
  tagB64: string
  version: typeof ENVELOPE_VERSION_V1 | typeof ENVELOPE_VERSION_V2
  /** null for a bare `v1` envelope written before key ids existed. */
  keyId: string | null
}

export function keyIdForDek(dekBase64: string): string {
  return crypto.createHash('sha256').update(Buffer.from(dekBase64, 'base64')).digest('hex').slice(0, 8)
}

const KEY_ID_RE = /^[0-9a-f]{8}$/

/**
 * Parse a stored value into its envelope parts, or null when it is not one of
 * ours (legacy plaintext, a free-text field that happens to contain colons).
 */
export function parseEnvelope(value: unknown): ParsedEnvelope | null {
  if (typeof value !== 'string' || !value) return null
  const parts = value.split(':')
  if (parts.length === 5) {
    const [ivB64, ciphertextB64, tagB64, version, keyId] = parts
    if (version !== ENVELOPE_VERSION_V2 || !KEY_ID_RE.test(keyId)) return null
    return { ivB64, ciphertextB64, tagB64, version: ENVELOPE_VERSION_V2, keyId }
  }
  if (parts.length === 4) {
    const [ivB64, ciphertextB64, tagB64, version] = parts
    if (version === ENVELOPE_VERSION_V1) {
      return { ivB64, ciphertextB64, tagB64, version: ENVELOPE_VERSION_V1, keyId: null }
    }
    if (version.startsWith('v1.')) {
      const keyId = version.slice(3)
      if (!KEY_ID_RE.test(keyId)) return null
      return { ivB64, ciphertextB64, tagB64, version: ENVELOPE_VERSION_V1, keyId }
    }
    return null
  }
  return null
}

/** True when the stored value carries one of our envelopes (v1 or v2). */
export function isEncryptedEnvelope(value: unknown): value is string {
  return parseEnvelope(value) !== null
}

/** @deprecated Use isEncryptedEnvelope / parseEnvelope. Kept for callers that only see the version slot. */
export function isV1Version(version: string | undefined): boolean {
  return version === ENVELOPE_VERSION_V1 || (typeof version === 'string' && version.startsWith('v1.'))
}

/** Key id carried by an already-parsed version slot, or null. */
export function keyIdFromVersion(version: string | undefined): string | null {
  if (typeof version !== 'string') return null
  if (version.startsWith('v1.')) {
    const id = version.slice(3)
    return KEY_ID_RE.test(id) ? id : null
  }
  return null
}

/** Key id stamped into a stored envelope, or null when it carries none. */
export function keyIdFromEnvelope(value: unknown): string | null {
  return parseEnvelope(value)?.keyId ?? null
}

export function encryptWithAesGcm(value: string, dekBase64: string): EncryptionPayload {
  const dek = Buffer.from(dekBase64, 'base64')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const payload = [
    iv.toString('base64'),
    ciphertext.toString('base64'),
    tag.toString('base64'),
    CURRENT_ENVELOPE_VERSION,
    keyIdForDek(dekBase64),
  ].join(':')
  logDebug('encrypt', { length: ciphertext.length, version: CURRENT_ENVELOPE_VERSION })
  return { value: payload, raw: payload, version: CURRENT_ENVELOPE_VERSION }
}

function runAesGcmDecrypt(dek: Buffer, iv: Buffer, ciphertext: Buffer, tag: Buffer): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/**
 * Strict decrypt. Throws a typed TenantDataEncryptionError.
 * - Not one of our envelopes: AUTH_FAILED (caller may treat it as plaintext).
 * - v2 (or interim v1.<id>) whose key id is not the active key's: WRONG_KEY,
 *   naming both ids and never the key material.
 * - Bad base64 or impossible component sizes: MALFORMED_PAYLOAD.
 * - AES-GCM tag rejection: AUTH_FAILED.
 */
export function decryptWithAesGcmStrict(payload: string, dekBase64: string): string {
  const parsed = parseEnvelope(payload)
  if (!parsed) {
    throw new TenantDataEncryptionError(
      TenantDataEncryptionErrorCode.AUTH_FAILED,
      'Value is not an encrypted payload (format mismatch)',
    )
  }
  const activeKeyId = keyIdForDek(dekBase64)
  if (parsed.keyId && parsed.keyId !== activeKeyId) {
    throw new TenantDataEncryptionError(
      TenantDataEncryptionErrorCode.WRONG_KEY,
      `Envelope was written by key id ${parsed.keyId} but the active key id is ${activeKeyId}`,
      { stampedKeyId: parsed.keyId, activeKeyId },
    )
  }
  let dek: Buffer, iv: Buffer, ciphertext: Buffer, tag: Buffer
  try {
    dek = Buffer.from(dekBase64, 'base64')
    iv = Buffer.from(parsed.ivB64, 'base64')
    ciphertext = Buffer.from(parsed.ciphertextB64, 'base64')
    tag = Buffer.from(parsed.tagB64, 'base64')
  } catch {
    throw new TenantDataEncryptionError(
      TenantDataEncryptionErrorCode.MALFORMED_PAYLOAD,
      'Failed to decode base64 components',
    )
  }
  // A zero-length ciphertext is legitimate: it is how AES-GCM encrypts the
  // empty string, and the write path has always encrypted '' that way. The
  // 16-byte tag still authenticates it. Rejecting it here made every contact
  // saved with an empty field unreadable ("could not be decrypted").
  if (iv.length !== 12 || tag.length !== 16) {
    throw new TenantDataEncryptionError(
      TenantDataEncryptionErrorCode.MALFORMED_PAYLOAD,
      'Invalid AES-GCM payload: unexpected IV, tag, or ciphertext size',
    )
  }
  try {
    const result = runAesGcmDecrypt(dek, iv, ciphertext, tag)
    logDebug('decrypt', { version: parsed.version, keyId: parsed.keyId })
    return result
  } catch {
    throw new TenantDataEncryptionError(
      TenantDataEncryptionErrorCode.AUTH_FAILED,
      'AES-GCM authentication tag verification failed',
      { stampedKeyId: parsed.keyId, activeKeyId },
    )
  }
}

/**
 * Tolerant decrypt: null instead of a throw. A key-id mismatch is still logged
 * loudly, because a silent null is how a key swap used to hide for weeks.
 */
export function decryptWithAesGcm(payload: string, dekBase64: string): string | null {
  if (!payload) return null
  try {
    return decryptWithAesGcmStrict(payload, dekBase64)
  } catch (err) {
    const typed = err as TenantDataEncryptionError
    if (typed?.code === TenantDataEncryptionErrorCode.WRONG_KEY) {
      console.error('[encryption] decrypt_key_mismatch', {
        stampedKeyId: typed.stampedKeyId,
        activeKeyId: typed.activeKeyId,
      })
      return null
    }
    logDebug('decrypt_error', { code: typed?.code, message: typed?.message || String(err) })
    return null
  }
}

export function hashForLookup(value: string): string {
  return crypto.createHash('sha256').update(value.toLowerCase().trim()).digest('hex')
}
