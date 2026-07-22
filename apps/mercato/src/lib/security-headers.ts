export type BrowserSecurityHeader = {
  key: string
  value: string
}

export type BrowserSecurityHeaderRule = {
  source: string
  headers: BrowserSecurityHeader[]
}

export const FRAMEABLE_PUBLIC_PATH_PATTERN = /^\/api\/(?:forms|surveys)\/public\/[a-z0-9-]+\/?$/
export const OWNED_BROWSER_APEX_DOMAINS = ['noliai.com', 'thelaunchpadincubator.com'] as const

// These two public HTML responses are explicitly advertised as iframe embeds.
// Keep every other route, including their submit endpoints and deeper lookalike
// paths, protected from framing.
export const FRAMEABLE_PUBLIC_HEADER_SOURCE =
  '/api/:surface(forms|surveys)/public/:slug([a-z0-9-]+)'
export const DEFAULT_BROWSER_HEADER_SOURCE =
  '/:path((?!api/(?:forms|surveys)/public/[a-z0-9-]+/?$).*)'

export const COMPANY_LEGAL_REDIRECTS: Readonly<Record<string, string>> = {
  '/privacy': 'https://noliai.com/privacy',
  '/terms': 'https://noliai.com/terms',
}

export const HSTS_HEADER: BrowserSecurityHeader = {
  key: 'Strict-Transport-Security',
  value: 'max-age=31536000',
}

export const SHARED_BROWSER_SECURITY_HEADERS: readonly BrowserSecurityHeader[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  },
]

export const FRAME_PROTECTION_HEADER: BrowserSecurityHeader = {
  key: 'X-Frame-Options',
  value: 'DENY',
}

export function isIntentionallyFrameablePublicPath(pathname: string): boolean {
  return FRAMEABLE_PUBLIC_PATH_PATTERN.test(pathname)
}

export function trailingSlashRedirectPath(pathname: string): string | null {
  if (pathname === '/' || !pathname.endsWith('/')) return null
  return pathname.slice(0, -1)
}

/** Prefer the RFC Host authority over a client-supplied forwarding hint.
 * Trusted reverse proxies also overwrite X-Forwarded-Host at the edge, but
 * direct runtimes must remain safe when a caller supplies that header. */
export function trustedRequestHost(headers: Pick<Headers, 'get'>, fallback: string): string {
  return headers.get('host') ?? fallback
}

export function applyBrowserSecurityHeaders(
  headers: Headers,
  pathname: string,
  options: { includeHsts: boolean },
): void {
  if (options.includeHsts) {
    headers.set(HSTS_HEADER.key, HSTS_HEADER.value)
  } else {
    // CRM can serve customer-owned landing-page domains. A long-lived HSTS
    // policy must not outlive their delegation or constrain unrelated hosting.
    headers.delete(HSTS_HEADER.key)
  }
  for (const header of SHARED_BROWSER_SECURITY_HEADERS) {
    headers.set(header.key, header.value)
  }
  if (isIntentionallyFrameablePublicPath(pathname)) {
    headers.delete(FRAME_PROTECTION_HEADER.key)
  } else {
    headers.set(FRAME_PROTECTION_HEADER.key, FRAME_PROTECTION_HEADER.value)
  }
}

export function browserSecurityHeaderRules(): BrowserSecurityHeaderRule[] {
  return [
    {
      source: '/',
      headers: [...SHARED_BROWSER_SECURITY_HEADERS, FRAME_PROTECTION_HEADER],
    },
    {
      source: DEFAULT_BROWSER_HEADER_SOURCE,
      headers: [...SHARED_BROWSER_SECURITY_HEADERS, FRAME_PROTECTION_HEADER],
    },
    {
      source: FRAMEABLE_PUBLIC_HEADER_SOURCE,
      headers: [...SHARED_BROWSER_SECURITY_HEADERS],
    },
  ]
}
