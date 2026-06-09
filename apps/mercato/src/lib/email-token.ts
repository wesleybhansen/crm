import crypto from 'crypto'

/* Signed token for public email-preference / unsubscribe links.
 *
 * Replaces the old plain `base64(contactId:orgId)`, which anyone could forge or
 * tamper with for any contact whose ids they knew (read/alter another contact's
 * email preferences). The token is HMAC-signed so only links WE generated are
 * trusted. No TTL — unsubscribe links must keep working indefinitely. */

function signingKey(): string | null {
  return (
    process.env.OAUTH_STATE_SECRET ||
    process.env.NOLI_INTERNAL_SERVICE_SECRET ||
    process.env.JWT_SECRET ||
    null
  )
}

function hmac(payload: string, key: string): string {
  return crypto.createHmac('sha256', key).update(payload).digest('base64url')
}

function decodeBody(body: string): { contactId: string; orgId: string } | null {
  try {
    const decoded = Buffer.from(body, 'base64url').toString('utf-8')
    const [contactId, orgId] = decoded.split(':')
    if (!contactId || !orgId) return null
    return { contactId, orgId }
  } catch {
    return null
  }
}

export function signEmailToken(contactId: string, orgId: string): string {
  const body = Buffer.from(`${contactId}:${orgId}`).toString('base64url')
  const key = signingKey()
  if (!key) return body // no secret in this env: degrade to legacy (still functional)
  return `${body}.${hmac(body, key)}`
}

export function verifyEmailToken(token: string): { contactId: string; orgId: string } | null {
  if (!token) return null
  const key = signingKey()
  const dot = token.lastIndexOf('.')
  if (dot > 0 && key) {
    const body = token.slice(0, dot)
    const sig = token.slice(dot + 1)
    const a = Buffer.from(sig)
    const b = Buffer.from(hmac(body, key))
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
    return decodeBody(body)
  }
  // Only when NO secret is configured anywhere do we accept an unsigned token
  // (keeps dev/keyless envs working). With a secret set, an unsigned token is
  // rejected — closing the forgery hole in production.
  if (!key) return decodeBody(token)
  return null
}
