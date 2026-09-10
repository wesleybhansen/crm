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

/* `full` is the token every outbound email carries (preference center with
 * the address shown and re-subscribe allowed). `unsubscribe` is minted for a
 * token-less legacy link: it may only opt the contact out, never show the
 * address or opt them back in, so a guessed contact id gains nothing. */
export type EmailTokenScope = 'full' | 'unsubscribe'
export type EmailTokenClaims = { contactId: string; orgId: string; scope: EmailTokenScope }

function decodeBody(body: string): EmailTokenClaims | null {
  try {
    const decoded = Buffer.from(body, 'base64url').toString('utf-8')
    const [contactId, orgId, scopeRaw] = decoded.split(':')
    if (!contactId || !orgId) return null
    const scope: EmailTokenScope = scopeRaw === 'unsubscribe' ? 'unsubscribe' : 'full'
    return { contactId, orgId, scope }
  } catch {
    return null
  }
}

export function signEmailToken(contactId: string, orgId: string, scope: EmailTokenScope = 'full'): string {
  const body = Buffer.from(scope === 'full' ? `${contactId}:${orgId}` : `${contactId}:${orgId}:${scope}`).toString('base64url')
  const key = signingKey()
  if (!key) return body // no secret in this env: degrade to legacy (still functional)
  return `${body}.${hmac(body, key)}`
}

export function verifyEmailToken(token: string): EmailTokenClaims | null {
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
