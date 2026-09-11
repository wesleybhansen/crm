export const metadata = { GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { signOAuthState } from '@/lib/oauth-state'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

// Redirect to Stripe Connect OAuth authorization
export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.sub || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const clientId = process.env.STRIPE_CONNECT_CLIENT_ID || process.env.STRIPE_CLIENT_ID
  if (!clientId) {
    return NextResponse.json(
      { ok: false, error: 'Stripe Connect not configured. Set STRIPE_CONNECT_CLIENT_ID or STRIPE_CLIENT_ID in .env' },
      { status: 500 },
    )
  }

  const baseUrl = process.env.APP_URL || 'http://localhost:3000'
  const state = signOAuthState({ userId: auth.sub, orgId: auth.orgId, tenantId: auth.tenantId })
  const redirectUri = `${baseUrl}/api/payments/stripe/connect-oauth/callback`

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'read_write',
    state,
    redirect_uri: redirectUri,
  })

  const authorizeUrl = `https://connect.stripe.com/oauth/authorize?${params.toString()}`
  return NextResponse.redirect(authorizeUrl)
}

// The manual "connect by account id" handler that lived here let any
// signed-in user bind any Stripe account to their organisation, and the
// cancel and refund routes then acted on it with the platform key. Stripe
// Connect is OAuth-only.
