export const metadata = { GET: { requireAuth: true }, POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
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
  const state = Buffer.from(JSON.stringify({ userId: auth.sub, orgId: auth.orgId, tenantId: auth.tenantId })).toString('base64')
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

// Manual connection for dev/testing — accepts a Stripe account ID directly
export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.sub || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const stripeAccountId = body.stripeAccountId?.trim()

  if (!stripeAccountId) {
    return NextResponse.json({ ok: false, error: 'stripeAccountId is required' }, { status: 400 })
  }

  if (!stripeAccountId.startsWith('acct_')) {
    return NextResponse.json({ ok: false, error: 'Invalid Stripe account ID format. Must start with acct_' }, { status: 400 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const existing = await knex('stripe_connections')
      .where('organization_id', auth.orgId)
      .first()

    if (existing) {
      await knex('stripe_connections').where('id', existing.id).update({
        stripe_account_id: stripeAccountId,
        business_name: body.businessName || 'Manual Connection (Dev)',
        livemode: false,
        is_active: true,
        updated_at: new Date(),
      })
    } else {
      await knex('stripe_connections').insert({
        id: require('crypto').randomUUID(),
        tenant_id: auth.tenantId || null,
        organization_id: auth.orgId,
        stripe_account_id: stripeAccountId,
        business_name: body.businessName || 'Manual Connection (Dev)',
        livemode: false,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[stripe.connect-oauth] Manual connect error:', err)
    return NextResponse.json({ ok: false, error: 'Failed to save connection' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Stripe Connect',
  summary: 'Stripe Connect OAuth flow',
  methods: {
    GET: { summary: 'Redirect to Stripe Connect OAuth authorization', tags: ['Stripe Connect'] },
    POST: { summary: 'Manually connect a Stripe account (dev/testing)', tags: ['Stripe Connect'] },
  },
}
