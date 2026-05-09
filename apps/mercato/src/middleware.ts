import { NextResponse } from 'next/server'
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

/**
 * Mercato CRM auth middleware (CRM Phase 1.4 cutover).
 *
 * Strategy: clerkMiddleware annotates the request with Clerk session
 * info but does NOT auto-protect API routes — the existing dispatcher
 * (`/api/[...slug]/route.ts`) keeps owning the per-route requireAuth
 * metadata contract. This middleware only enforces redirect-to-sign-in
 * for top-level page navigations.
 *
 * Public allowlist (no Clerk redirect, no auth check at this layer):
 *   - public-token surfaces (quotes, messages) — already gated by token
 *   - all webhooks — gated by signing secret in the route
 *   - cron endpoints — gated by bearer secret in the route
 *   - the MCP HTTP edge at /mcp — API-key only, fronted by nginx
 *   - the legacy /api/auth/* routes — needed for sign-out + session
 *     refresh during cutover; deleted in Phase G
 *
 * The dispatcher continues to enforce `requireAuth` per route via
 * getAuthFromRequest (which now resolves Clerk first, falling back to
 * legacy JWT and API key).
 */
const isPublic = createRouteMatcher([
  // Public marketing surfaces
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/landing',
  '/terms',
  '/privacy',
  // Public-token surfaces (token validates inside the route)
  '/api/messages/token/(.*)',
  '/api/quotes/public/(.*)',
  '/api/quotes/accept',
  // Locale + session housekeeping
  '/api/auth/locale',
  '/api/auth/session/refresh',
  // Legacy auth routes (kept alive during cutover, deleted in Phase G)
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/logout',
  '/api/auth/google/(.*)',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  // Webhooks (signing-secret gated inside the route)
  '/api/stripe/webhook',
  '/api/shipping_carriers/webhook/(.*)',
  '/api/inbox_ops/webhook/(.*)',
  // Cron endpoints (bearer-secret gated inside the route)
  '/api/reminders/process',
  '/api/sequences/process',
  '/api/email-intelligence/cron',
  '/api/automation-rules/run-scheduled',
  // Public lookups
  '/api/directory/get/organizations/lookup',
  '/api/directory/get/tenants/lookup',
  // MCP edge (separate container; API-key gated at nginx + service)
  '/mcp/(.*)',
  // Health
  '/api/health',
])

const HUB_SIGN_IN_URL =
  process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL ?? 'https://app.noliai.com/sign-in'

export default clerkMiddleware(async (auth, req) => {
  if (isPublic(req)) return

  // For API routes, let the dispatcher's `requireAuth` metadata decide.
  // The dispatcher calls getAuthFromRequest which is now Clerk-aware.
  if (req.nextUrl.pathname.startsWith('/api/')) return

  // Page navigations: enforce sign-in here so unauthenticated visitors
  // hit the hub redirect instead of the app's chrome flickering.
  const { userId } = await auth()
  if (!userId) {
    const signInUrl = new URL(HUB_SIGN_IN_URL)
    signInUrl.searchParams.set('redirect_url', req.url)
    return NextResponse.redirect(signInUrl)
  }
})

export const config = {
  matcher: [
    // Skip Next internals and static assets.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
