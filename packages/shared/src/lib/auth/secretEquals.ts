import crypto from 'node:crypto'

/**
 * Constant-time comparison of two secrets (tokens, signatures, API keys).
 * Both sides are hashed first, so the compare takes the same time whatever
 * their lengths or contents, and it never throws on a length or encoding
 * mismatch (a plain timingSafeEqual on unequal lengths throws RangeError).
 * Missing or empty values never match.
 */
export function secretEquals(provided: unknown, expected: unknown): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false
  if (!provided || !expected) return false
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest()
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest()
  return crypto.timingSafeEqual(a, b)
}
