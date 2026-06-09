import crypto from 'crypto'

/* Signed, expiring OAuth `state` for the Stripe Connect flow. The (authenticated)
 * `/connect-oauth` route mints it; the callback verifies the signature + expiry
 * before trusting any field. Without this, `state` was plain base64, so an
 * attacker could forge `state.orgId` to attach their own Stripe account to a
 * victim org (routing the victim's payouts to the attacker). */

const TTL_MS = 15 * 60 * 1000

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

export function signOAuthState(data: Record<string, unknown>): string {
  const key = signingKey()
  if (!key) throw new Error('oauth-state: no signing secret configured')
  const body = Buffer.from(JSON.stringify({ ...data, _ts: Date.now() })).toString('base64url')
  return `${body}.${hmac(body, key)}`
}

export function verifyOAuthState<T = Record<string, unknown>>(raw: string | null): T | null {
  if (!raw) return null
  const key = signingKey()
  if (!key) return null // fail closed
  const dot = raw.lastIndexOf('.')
  if (dot <= 0) return null
  const body = raw.slice(0, dot)
  const sig = raw.slice(dot + 1)
  const a = Buffer.from(sig)
  const b = Buffer.from(hmac(body, key))
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  let parsed: Record<string, unknown> & { _ts?: number }
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString())
  } catch {
    return null
  }
  if (typeof parsed._ts !== 'number' || Date.now() - parsed._ts > TTL_MS) return null
  return parsed as T
}
