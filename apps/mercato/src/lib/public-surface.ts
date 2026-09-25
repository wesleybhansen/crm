/**
 * Customer-authored pages served on the CRM origin, and the public endpoints
 * those pages call.
 *
 * Landing pages, funnels, surveys, forms, booking pages, event pages, course
 * pages, chat pages and uploaded attachments are HTML (or SVG/XML) written by
 * a CRM customer, served from crm.noliai.com. Served as a normal document, a
 * customer's <script> would run as crm.noliai.com: it could read the signed-in
 * visitor's session cookie and call the CRM API as them (security sweep
 * 2026-09-25, critical finding 1).
 *
 * The control: every such response carries
 *   Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups
 *     allow-popups-to-escape-sandbox allow-modals
 * with NO allow-same-origin. The page still runs its own scripts, submits
 * forms, opens links and shows alert() messages, but it runs in an opaque
 * ("null") origin: document.cookie, localStorage and sessionStorage throw, and
 * a fetch to crm.noliai.com is cross-origin, so the browser sends no cookies
 * and cannot read the answer unless the endpoint opts in with CORS. We do not
 * strip <script> from what customers publish: customers may legitimately
 * embed scripts (analytics, widgets). The sandbox is the control.
 * `allow-modals` is added to the minimum set because the published form
 * scripts report errors with alert(); it grants no origin access.
 *
 * Because the page's origin is opaque, its calls to the public CRM endpoints
 * arrive with `Origin: null` and no cookies. PUBLIC_SANDBOX_ENDPOINTS lists
 * exactly those endpoints: the dispatcher answers their CORS preflight and
 * adds `Access-Control-Allow-Origin: *` (never with credentials) to their
 * responses. They are unauthenticated endpoints, so a cookie-less
 * cross-origin call can do nothing a plain HTTP client could not already do.
 *
 * LONGER-TERM FIX (not implemented here): serve customer pages from a separate
 * registrable domain (for example noli.page, with customer custom domains
 * pointing there), never a noliai.com subdomain. A separate site gets its own
 * cookie jar and SameSite boundary, so even a sandbox escape could not reach
 * CRM sessions, and the sandbox could then be relaxed to allow storage for
 * embeds that need it (video players, payment widgets). Until that move,
 * nested iframes in a customer page inherit the sandbox too, so third-party
 * embeds that need their own storage may degrade.
 *
 * Pure and Edge-safe: imported by the proxy and the API dispatcher.
 */

export const PUBLIC_SANDBOX_CSP =
  'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals'

const SANDBOXED_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
]

/** True for a response body a browser would render as an active document. */
export function isActiveDocumentContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false
  const base = contentType.split(';')[0].trim().toLowerCase()
  return SANDBOXED_CONTENT_TYPES.includes(base)
}

type PublicEndpoint = {
  /** Path under the CRM origin, including the /api prefix. */
  pattern: RegExp
  methods: readonly string[]
  /** What calls it, for reviewers. */
  caller: string
  /**
   * The route also has a cookie-authenticated branch (agent side), so it keeps
   * the CSRF origin check; the sandboxed page's calls carry no cookie anyway.
   */
  usesSession?: boolean
}

/**
 * The public, unauthenticated endpoints that sandboxed customer pages call.
 * Keep this list exact: a path lands here only when a page served under the
 * sandbox calls it and the route's metadata is `requireAuth: false` for the
 * listed methods (a unit test checks the second half).
 */
export const PUBLIC_SANDBOX_ENDPOINTS: readonly PublicEndpoint[] = [
  { pattern: /^\/api\/landing_pages\/public\/[^/]+\/submit$/, methods: ['POST'], caller: 'landing page forms' },
  { pattern: /^\/api\/landing_pages\/public\/[^/]+\/checkout$/, methods: ['POST'], caller: 'landing page buy buttons (Stripe Checkout on the business account)' },
  { pattern: /^\/api\/payments\/public\/offers\/[^/]+\/checkout$/, methods: ['POST'], caller: 'marketing page buy buttons for an offer (Stripe Checkout on the business account)' },
  { pattern: /^\/api\/landing_pages\/funnels\/public\/[^/]+\/(?:advance|upsell|checkout)$/, methods: ['POST'], caller: 'funnel steps' },
  { pattern: /^\/api\/forms\/public\/[^/]+\/submit$/, methods: ['POST'], caller: 'hosted and embedded forms' },
  { pattern: /^\/api\/surveys\/public\/[^/]+\/submit$/, methods: ['POST'], caller: 'surveys' },
  { pattern: /^\/api\/calendar\/bookings$/, methods: ['POST'], caller: 'booking pages' },
  { pattern: /^\/api\/crm-events\/public\/[^/]+\/(?:register|checkout)$/, methods: ['POST'], caller: 'event pages' },
  { pattern: /^\/api\/crm-events\/kiosk\/[^/]+$/, methods: ['POST'], caller: 'event check-in kiosk' },
  { pattern: /^\/api\/chat\/public$/, methods: ['GET', 'POST'], caller: 'hosted chat page and chat widget' },
  { pattern: /^\/api\/chat\/typing$/, methods: ['POST'], caller: 'hosted chat page', usesSession: true },
  { pattern: /^\/api\/affiliates\/signup$/, methods: ['POST'], caller: 'affiliate sign-up page' },
  { pattern: /^\/api\/courses\/enrollments$/, methods: ['POST'], caller: 'free course enrolment' },
  { pattern: /^\/api\/courses\/student\/magic-link$/, methods: ['POST'], caller: 'course sign-in page' },
  { pattern: /^\/api\/email\/preferences\/update$/, methods: ['POST'], caller: 'email preference centre' },
]

export function matchPublicSandboxEndpoint(pathname: string): PublicEndpoint | null {
  for (const endpoint of PUBLIC_SANDBOX_ENDPOINTS) {
    if (endpoint.pattern.test(pathname)) return endpoint
  }
  return null
}

export function isPublicSandboxEndpoint(pathname: string, method: string): boolean {
  const endpoint = matchPublicSandboxEndpoint(pathname)
  return !!endpoint && endpoint.methods.includes(method.toUpperCase())
}

export function publicCorsHeaders(methods: readonly string[]): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': [...methods, 'OPTIONS'].join(', '),
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  }
}

/**
 * Return a response whose headers can be changed. Responses built with
 * Response.redirect() or Response.error() have immutable headers.
 */
function mutable(response: Response): Response {
  try {
    const probe = 'x-om-probe'
    response.headers.set(probe, '1')
    response.headers.delete(probe)
    return response
  } catch {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    })
  }
}

/**
 * Apply the public-surface headers to a dispatcher response:
 *  - any active document (HTML/SVG/XML) gets the sandbox CSP;
 *  - a listed public endpoint gets `Access-Control-Allow-Origin: *`.
 */
export function applyPublicSurfaceHeaders(response: Response, pathname: string, method: string): Response {
  const sandbox = isActiveDocumentContentType(response.headers.get('content-type'))
  const cors = isPublicSandboxEndpoint(pathname, method)
  if (!sandbox && !cors) return response
  const out = mutable(response)
  if (sandbox) out.headers.set('Content-Security-Policy', PUBLIC_SANDBOX_CSP)
  if (cors) {
    out.headers.set('Access-Control-Allow-Origin', '*')
    out.headers.delete('Access-Control-Allow-Credentials')
  }
  return out
}
