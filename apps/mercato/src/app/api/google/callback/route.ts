import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

// Handle Google OAuth callback — exchange code for tokens
export async function GET(req: Request) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const userId = url.searchParams.get('state')
  const error = url.searchParams.get('error')
  const baseUrl = process.env.APP_URL || 'http://localhost:3000'

  if (error || !code) {
    return NextResponse.redirect(`${baseUrl}/backend/settings-simple?google_error=${error || 'no_code'}`)
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(`${baseUrl}/backend/settings-simple?google_error=not_configured`)
  }

  try {
    const redirectUri = `${baseUrl}/api/google/callback`

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })
    const tokens = await tokenRes.json()

    if (!tokens.access_token) {
      console.error('[google.callback] Token exchange failed:', tokens)
      return NextResponse.redirect(`${baseUrl}/backend/settings-simple?google_error=token_failed`)
    }

    // Get user's Google email
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    const userInfo = await userInfoRes.json()

    // Store the connection
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Get user's tenant/org from their CRM user record
    const crmUser = await knex('users').where('id', userId).first()
    if (!crmUser) {
      return NextResponse.redirect(`${baseUrl}/backend/settings-simple?google_error=user_not_found`)
    }

    const expiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000)

    // Upsert the connection
    const existing = await knex('google_calendar_connections').where('user_id', userId).first()
    if (existing) {
      await knex('google_calendar_connections').where('id', existing.id).update({
        google_email: userInfo.email,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || existing.refresh_token,
        token_expiry: expiry,
        is_active: true,
        updated_at: new Date(),
      })
    } else {
      await knex('google_calendar_connections').insert({
        id: require('crypto').randomUUID(),
        tenant_id: crmUser.tenant_id,
        organization_id: crmUser.organization_id,
        user_id: userId,
        google_email: userInfo.email,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || '',
        token_expiry: expiry,
        calendar_id: 'primary',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      })
    }

    return NextResponse.redirect(`${baseUrl}/backend/settings-simple?google_connected=true`)
  } catch (error) {
    console.error('[google.callback]', error)
    return NextResponse.redirect(`${baseUrl}/backend/settings-simple?google_error=unknown`)
  }
}
