/**
 * Thrown (only when a caller opts in) when the identity behind a request
 * could not be checked because a dependency failed: the CRM database, the
 * noli-core lookup, a timeout. It means "we don't know yet", never "signed
 * out". Callers must answer with a retry/reconnecting state, not a sign-in
 * redirect: a database blip must not sign people out.
 */
export class AuthUnavailableError extends Error {
  readonly code = 'AUTH_UNAVAILABLE'
  readonly cause?: unknown

  constructor(message = 'Sign-in check is temporarily unavailable', cause?: unknown) {
    super(message)
    this.name = 'AuthUnavailableError'
    this.cause = cause
  }
}

export function isAuthUnavailableError(error: unknown): error is AuthUnavailableError {
  if (error instanceof AuthUnavailableError) return true
  // Tolerate duplicate module instances (dynamic imports, separate bundles).
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'AUTH_UNAVAILABLE' &&
      (error as { name?: unknown }).name === 'AuthUnavailableError',
  )
}

/** Where Noli users sign in. The CRM has no sign-in page of its own. */
export const DEFAULT_HUB_SIGN_IN_URL = 'https://app.noliai.com/sign-in'

export function resolveHubSignInUrl(): string {
  const configured = (process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL || '').trim()
  return configured || DEFAULT_HUB_SIGN_IN_URL
}

/** True when this deployment signs users in through Clerk (the Noli hub). */
export function isHubSignInEnabled(): boolean {
  return Boolean((process.env.CLERK_SECRET_KEY || '').trim())
}

/**
 * The hub sign-in URL that returns the user to `returnTo` (an absolute URL)
 * after signing in.
 */
export function buildHubSignInUrl(returnTo: string | null | undefined): string {
  const url = new URL(resolveHubSignInUrl())
  if (returnTo) url.searchParams.set('redirect_url', returnTo)
  return url.toString()
}

/**
 * Where to send someone whose Clerk session is valid but who has no CRM
 * access (no entitlement, not provisioned). Sending them to sign-in again
 * would loop straight back here, so they go to the hub home instead.
 */
export function buildHubHomeUrl(): string {
  const url = new URL(resolveHubSignInUrl())
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}
