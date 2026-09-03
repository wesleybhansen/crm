/*
 * Pure helpers shared by the Threads connect-start op and the public OAuth
 * callback. Kept free of framework imports so they are directly testable.
 */

export const THREADS_OAUTH_STATE_KIND = 'gtm_threads_connect_v1'
export const THREADS_CALLBACK_PATH = '/api/gtm/threads/callback'
const OWNED_APEX_DOMAINS = ['noliai.com', 'thelaunchpadincubator.com'] as const

export function threadsCallbackUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.GTM_PUBLIC_BASE_URL || env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '')
  return `${base}${THREADS_CALLBACK_PATH}`
}

/** Only absolute https URLs on an owned Noli browser domain (or localhost in
 *  non-production) may receive the post-OAuth redirect. */
export function validatedReturnTo(value: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  const local = host === 'localhost' || host === '127.0.0.1'
  if (local) {
    if (env.NODE_ENV === 'production') return null
  } else {
    if (url.protocol !== 'https:') return null
    const owned = OWNED_APEX_DOMAINS.some((apex) => host === apex || host.endsWith(`.${apex}`))
    if (!owned) return null
  }
  // The hash is preserved: the hub deep-links screens as /dashboard/gtm#setup.
  return url.toString()
}

export type ThreadsOAuthState = {
  kind: string
  organizationId: string
  tenantId: string
  userId: string
  returnTo: string
  nonce: string
}

export function isThreadsOAuthState(value: unknown): value is ThreadsOAuthState {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  return Boolean(
    row
    && row.kind === THREADS_OAUTH_STATE_KIND
    && typeof row.organizationId === 'string' && row.organizationId
    && typeof row.tenantId === 'string' && row.tenantId
    && typeof row.userId === 'string' && row.userId
    && typeof row.returnTo === 'string' && row.returnTo
    && typeof row.nonce === 'string' && row.nonce,
  )
}

export function returnWithOutcome(returnTo: string, outcome: 'connected' | 'error', detail?: string): string {
  const url = new URL(returnTo)
  url.searchParams.set('threads', outcome)
  if (detail) url.searchParams.set('threads_detail', detail.slice(0, 80))
  return url.toString()
}
