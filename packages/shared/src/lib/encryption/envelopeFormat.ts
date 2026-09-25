/**
 * The stored-envelope format, with no crypto and no Node imports, so browser
 * code and lightweight guards can recognise ciphertext with the SAME parser
 * the server uses (v1, interim v1.<keyId>, v2). Private regexes that knew only
 * `...:v1` kept drifting from this one; import this instead.
 */
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

export const KEY_ID_RE = /^[0-9a-f]{8}$/

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

