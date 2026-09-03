/*
 * Meta "signed_request" handling for the Threads app's Uninstall and Data
 * Deletion callbacks. Meta POSTs `signed_request=<sig>.<payload>` as a form
 * field: both halves are base64url, the payload is JSON carrying `user_id`
 * (the Threads user id we store as provider_user_id) and `algorithm`
 * "HMAC-SHA256", and the signature is HMAC-SHA256 of the raw payload string
 * under the app secret. Anything that does not verify is rejected; nothing
 * about the request body is trusted before that.
 *
 * Pure helpers only (no framework, no ORM) so they are directly testable.
 */

import crypto from 'node:crypto'

export type ThreadsSignedRequest = {
  userId: string
  issuedAt: number | null
  algorithm: string
}

function base64UrlDecode(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4)
  try {
    return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  } catch {
    return null
  }
}

export function parseThreadsSignedRequest(
  signedRequest: unknown,
  appSecret: string,
): ThreadsSignedRequest | null {
  if (typeof signedRequest !== 'string' || !appSecret) return null
  const dot = signedRequest.indexOf('.')
  if (dot <= 0 || dot === signedRequest.length - 1) return null
  const signaturePart = signedRequest.slice(0, dot)
  const payloadPart = signedRequest.slice(dot + 1)
  const signature = base64UrlDecode(signaturePart)
  if (!signature) return null
  const expected = crypto.createHmac('sha256', appSecret).update(payloadPart).digest()
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) return null
  const payloadBytes = base64UrlDecode(payloadPart)
  if (!payloadBytes) return null
  let payload: Record<string, unknown>
  try {
    const parsed = JSON.parse(payloadBytes.toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    payload = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const algorithm = typeof payload.algorithm === 'string' ? payload.algorithm.toUpperCase() : ''
  if (algorithm !== 'HMAC-SHA256') return null
  const rawUserId = payload.user_id
  const userId = typeof rawUserId === 'string' || typeof rawUserId === 'number' ? String(rawUserId).trim() : ''
  if (!/^\d{1,60}$/.test(userId)) return null
  const issuedAt = Number(payload.issued_at)
  return { userId, issuedAt: Number.isFinite(issuedAt) ? issuedAt : null, algorithm }
}

/** Opaque, non-reversible code Meta shows the user; also what our status
 *  page looks up. Bound to the provider user id and the moment of receipt. */
export function threadsDeletionConfirmationCode(providerUserId: string, receivedAt: Date): string {
  return crypto
    .createHash('sha256')
    .update(`threads-deletion|${providerUserId}|${receivedAt.toISOString()}`)
    .digest('hex')
    .slice(0, 24)
}

export function isThreadsDeletionConfirmationCode(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{24}$/.test(value)
}
