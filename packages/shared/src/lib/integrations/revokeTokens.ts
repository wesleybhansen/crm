/**
 * Provider-side revocation for third-party credentials.
 *
 * Scrubbing our copy of a token is half the job: until the provider is told,
 * the credential keeps working for anyone who kept a copy (a database backup, a
 * log line, a leaked dump). These helpers tell the provider.
 *
 * Every one of them is BEST EFFORT. A disconnect must complete even when the
 * provider is down, the token is already dead, or the platform is missing the
 * credentials needed to make the call. They never throw.
 */

const REVOKE_TIMEOUT_MS = 10_000

async function postForm(
  url: string,
  body: URLSearchParams,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; status: number | null; error?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body,
      signal: controller.signal,
    })
    return { ok: res.ok, status: res.status }
  } catch (err) {
    return { ok: false, status: null, error: (err as Error)?.message || String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Revoke a Google OAuth grant. Revoking a refresh token kills the whole grant
 * (every access token minted from it); revoking an access token only kills that
 * one token, so the refresh token is tried first.
 */
export async function revokeGoogleOAuthToken(
  tokens: { refreshToken?: string | null; accessToken?: string | null },
  label = 'google',
): Promise<boolean> {
  const token = tokens.refreshToken || tokens.accessToken
  if (!token) return false
  const result = await postForm('https://oauth2.googleapis.com/revoke', new URLSearchParams({ token }))
  if (!result.ok) {
    // Redacted on purpose: never log the token itself.
    console.warn(`[${label}.revoke] Google token revocation did not succeed`, {
      status: result.status,
      error: result.error,
      usedRefreshToken: Boolean(tokens.refreshToken),
    })
  }
  return result.ok
}

/**
 * Deauthorize a Stripe Connect account from the platform.
 *
 * `clientId` is the platform's Connect client id (STRIPE_CONNECT_CLIENT_ID, or
 * the legacy STRIPE_CLIENT_ID the OAuth start route also accepts) and the call
 * is authenticated with the platform secret key (STRIPE_SECRET_KEY), not the
 * connected account's token.
 */
export async function deauthorizeStripeConnect(
  args: { stripeUserId?: string | null; clientId?: string | null; secretKey?: string | null },
  label = 'stripe',
): Promise<boolean> {
  const { stripeUserId, clientId, secretKey } = args
  if (!stripeUserId || !clientId || !secretKey) {
    console.warn(`[${label}.revoke] Stripe deauthorize skipped`, {
      hasAccount: Boolean(stripeUserId),
      hasClientId: Boolean(clientId),
      hasSecretKey: Boolean(secretKey),
    })
    return false
  }
  const result = await postForm(
    'https://connect.stripe.com/oauth/deauthorize',
    new URLSearchParams({ client_id: clientId, stripe_user_id: stripeUserId }),
    { Authorization: `Bearer ${secretKey}` },
  )
  if (!result.ok) {
    console.warn(`[${label}.revoke] Stripe deauthorize did not succeed`, {
      status: result.status,
      error: result.error,
    })
  }
  return result.ok
}

/** Env names the Stripe deauthorize call reads, kept next to the caller. */
export function stripeConnectPlatformCredentials(env: NodeJS.ProcessEnv = process.env) {
  return {
    clientId: env.STRIPE_CONNECT_CLIENT_ID || env.STRIPE_CLIENT_ID || null,
    secretKey: env.STRIPE_SECRET_KEY || null,
  }
}
