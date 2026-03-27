import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = { GET: { requireAuth: false } }

// Stripe Connect OAuth callback — exchange code for connected account
export async function GET(req: Request) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state')
  const error = url.searchParams.get('error')
  const baseUrl = process.env.APP_URL || 'http://localhost:3000'
  const settingsUrl = `${baseUrl}/backend/settings-simple`

  if (error) {
    console.error('[stripe.connect-oauth] Authorization denied:', error)
    return NextResponse.redirect(`${settingsUrl}?stripe_error=${encodeURIComponent(error)}`)
  }

  if (!code || !stateParam) {
    return NextResponse.redirect(`${settingsUrl}?stripe_error=missing_params`)
  }

  let stateData: { userId: string; orgId: string; tenantId?: string }
  try {
    stateData = JSON.parse(Buffer.from(stateParam, 'base64').toString('utf-8'))
  } catch {
    return NextResponse.redirect(`${settingsUrl}?stripe_error=invalid_state`)
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (!stripeKey) {
    return NextResponse.redirect(`${settingsUrl}?stripe_error=not_configured`)
  }

  try {
    // Exchange authorization code for connected account credentials
    const tokenRes = await fetch('https://connect.stripe.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_secret: stripeKey,
      }),
    })

    const tokenData = await tokenRes.json()

    if (tokenData.error) {
      console.error('[stripe.connect-oauth] Token exchange failed:', tokenData)
      return NextResponse.redirect(`${settingsUrl}?stripe_error=${encodeURIComponent(tokenData.error_description || tokenData.error)}`)
    }

    const { stripe_user_id, access_token, refresh_token, livemode } = tokenData

    // Fetch the connected account details for display name
    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(stripeKey)
    const account = await stripe.accounts.retrieve(stripe_user_id)
    const businessName = account.business_profile?.name || account.settings?.dashboard?.display_name || null

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Upsert into stripe_connections
    const existing = await knex('stripe_connections')
      .where('organization_id', stateData.orgId)
      .first()

    if (existing) {
      await knex('stripe_connections').where('id', existing.id).update({
        stripe_account_id: stripe_user_id,
        access_token,
        refresh_token: refresh_token || null,
        business_name: businessName,
        is_active: true,
        updated_at: new Date(),
      })
    } else {
      await knex('stripe_connections').insert({
        id: require('crypto').randomUUID(),
        tenant_id: stateData.tenantId || null,
        organization_id: stateData.orgId,
        stripe_account_id: stripe_user_id,
        access_token,
        refresh_token: refresh_token || null,
        business_name: businessName,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      })
    }

    console.log(`[stripe.connect-oauth] Connected account ${stripe_user_id} for org ${stateData.orgId}`)
    return NextResponse.redirect(`${settingsUrl}?stripe_connected=true`)
  } catch (err) {
    console.error('[stripe.connect-oauth] Callback error:', err)
    return NextResponse.redirect(`${settingsUrl}?stripe_error=callback_failed`)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Stripe Connect',
  summary: 'Stripe Connect OAuth callback',
  methods: {
    GET: { summary: 'Handle Stripe Connect OAuth callback and store connected account', tags: ['Stripe Connect'] },
  },
}
