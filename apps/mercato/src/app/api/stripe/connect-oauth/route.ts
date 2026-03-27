import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

// Redirect to Stripe Connect OAuth authorization
export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.userId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const clientId = process.env.STRIPE_CONNECT_CLIENT_ID
  if (!clientId) {
    return NextResponse.json(
      { ok: false, error: 'Stripe Connect not configured. Add STRIPE_CONNECT_CLIENT_ID to .env' },
      { status: 500 },
    )
  }

  const baseUrl = process.env.APP_URL || 'http://localhost:3000'
  const state = Buffer.from(JSON.stringify({ userId: auth.userId, orgId: auth.orgId, tenantId: auth.tenantId })).toString('base64')
  const redirectUri = `${baseUrl}/api/stripe/connect-oauth/callback`

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

export const openApi: OpenApiRouteDoc = {
  tag: 'Stripe Connect',
  summary: 'Stripe Connect OAuth flow',
  methods: {
    GET: { summary: 'Redirect to Stripe Connect OAuth authorization', tags: ['Stripe Connect'] },
  },
}
