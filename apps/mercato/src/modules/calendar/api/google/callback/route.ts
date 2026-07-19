
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { verifyOAuthState } from '@/lib/oauth-state'
import type { EntityManager } from '@mikro-orm/postgresql'

export const metadata = { path: '/google/callback', GET: { requireAuth: false } }

// Handle Google OAuth callback — exchange code for tokens using PKCE
export async function GET(req: Request) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const stateRaw = url.searchParams.get('state')
  const error = url.searchParams.get('error')
  const baseUrl = process.env.APP_URL || 'http://localhost:3000'

  if (error || !code) {
    // redirectBase isn't computed until after state parsing below; this early
    // return ran before it existed (TDZ ReferenceError, masked by
    // ignoreBuildErrors) → 500 whenever a user clicks "Cancel" on Google consent.
    return NextResponse.redirect(`${baseUrl}/backend/settings-simple?google_error=${error || 'no_code'}`)
  }

  // Verify the signed state — this route is public, so state.userId can only be
  // trusted because the auth route HMAC-signed it (15-min TTL).
  const parsed = verifyOAuthState<{ userId?: string; type?: string; from?: string }>(stateRaw)
  const userId: string | null = parsed?.userId || null
  const connectType = parsed?.type || 'both'
  const fromPage = parsed?.from || 'settings'

  const redirectBase = fromPage === 'onboarding' ? `${baseUrl}/backend/welcome` : `${baseUrl}/backend/settings-simple`

  if (!userId) {
    return NextResponse.redirect(`${redirectBase}?google_error=invalid_state`)
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  if (!clientId) {
    return NextResponse.redirect(`${redirectBase}?google_error=not_configured`)
  }

  // Get PKCE verifier from cookie
  const cookieStore = await cookies()
  const codeVerifier = cookieStore.get('google_pkce_verifier')?.value

  if (!codeVerifier) {
    return NextResponse.redirect(`${redirectBase}?google_error=pkce_missing`)
  }

  try {
    const redirectUri = `${baseUrl}/api/google/callback`

    // Exchange code for tokens using PKCE (no client_secret needed)
    const tokenBody: Record<string, string> = {
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }

    // Include client_secret if available (some Google setups still need it)
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
    if (clientSecret) {
      tokenBody.client_secret = clientSecret
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tokenBody),
    })
    const tokens = await tokenRes.json()

    if (!tokens.access_token) {
      console.error('[google.callback] Token exchange failed:', JSON.stringify(tokens))
      const errorDetail = encodeURIComponent(tokens.error_description || tokens.error || 'unknown')
      return NextResponse.redirect(`${redirectBase}?google_error=token_failed&detail=${errorDetail}`)
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
      return NextResponse.redirect(`${redirectBase}?google_error=user_not_found`)
    }

    const expiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000)

    // Store calendar connection (existing behavior) for calendar or both
    if (connectType === 'calendar' || connectType === 'both') {
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
    }

    // Gmail-OAuth mailbox connections are intentionally NOT created here anymore:
    // mailboxes connect via the Noli dashboard with an app password (IMAP). This
    // callback now only links Google Calendar. (The `email`/`both` connectType is
    // never requested — the auth route is Calendar-only.)

    const redirectParams = new URLSearchParams()
    if (connectType === 'calendar' || connectType === 'both') {
      redirectParams.set('google_connected', 'true')
    }
    if (connectType === 'email' || connectType === 'both') {
      redirectParams.set('email_connected', 'true')
    }

    const response = NextResponse.redirect(`${redirectBase}?${redirectParams}`)
    response.cookies.delete('google_pkce_verifier')
    return response
  } catch (error) {
    console.error('[google.callback]', error)
    const response = NextResponse.redirect(`${redirectBase}?google_error=unknown`)
    response.cookies.delete('google_pkce_verifier')
    return response
  }
}
