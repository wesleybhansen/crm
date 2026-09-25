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

/**
 * The CRM Content-Security-Policy. nginx sends it (report-only for now) at
 * the TLS edge on crm.noliai.com, so nginx.conf must carry exactly this
 * string; a unit test enforces that. Each source is something the app really
 * loads, so the policy can be switched to enforcing without breaking sign-in,
 * fonts, payments or analytics, and so a normal page load posts no reports.
 *
 * - Clerk: clerk-js and its API live on the custom Frontend API domain
 *   clerk.noliai.com (covered in connect-src by *.noliai.com); bot checks use
 *   Cloudflare Turnstile; avatars come from img.clerk.com (img-src https:).
 * - Fontshare: the Satoshi stylesheet is on api.fontshare.com and its font
 *   files on cdn.fontshare.com. Google Fonts serves landing pages and courses.
 * - Stripe.js, PostHog (ingest plus lazily loaded recorder scripts), and
 *   YouTube, Vimeo and Loom embeds in course lessons.
 */
export const CRM_CSP_DIRECTIVES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['default-src', ["'self'"]],
  ['script-src', [
    "'self'", "'unsafe-inline'", "'unsafe-eval'", 'blob:',
    'https://clerk.noliai.com',
    'https://js.stripe.com', 'https://*.js.stripe.com',
    'https://challenges.cloudflare.com',
    'https://*.posthog.com',
  ]],
  ['style-src', ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://api.fontshare.com']],
  ['img-src', ["'self'", 'data:', 'blob:', 'https:']],
  ['font-src', ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdn.fontshare.com', 'https://api.fontshare.com']],
  ['connect-src', [
    "'self'",
    'https://*.noliai.com', 'wss://crm.noliai.com',
    'https://api.stripe.com',
    'https://*.posthog.com',
    'https://clerk-telemetry.com',
  ]],
  ['frame-src', [
    "'self'",
    'https://js.stripe.com', 'https://*.js.stripe.com', 'https://hooks.stripe.com',
    'https://challenges.cloudflare.com',
    'https://www.youtube.com', 'https://www.youtube-nocookie.com',
    'https://player.vimeo.com', 'https://www.loom.com',
  ]],
  ['media-src', ["'self'", 'blob:', 'https:']],
  ['worker-src', ["'self'", 'blob:']],
  ['object-src', ["'none'"]],
  ['base-uri', ["'self'"]],
  ['report-uri', ['https://app.noliai.com/api/csp-report']],
]

export function crmContentSecurityPolicy(): string {
  return CRM_CSP_DIRECTIVES.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ')
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
