// ORM-SKIP: complex multi-table logic or public/webhook endpoint

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { verifyOAuthState } from '@/lib/oauth-state'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { sealSecretForTenant, tenantEncryptionFromContainer } from '@open-mercato/shared/lib/encryption/secretColumns'

export const metadata = { path: '/microsoft/callback', GET: { requireAuth: false } }

export async function GET(req: Request) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const stateRaw = url.searchParams.get('state')
  const error = url.searchParams.get('error')
  const baseUrl = process.env.APP_URL || 'http://localhost:3000'

  if (error || !code) {
    return NextResponse.redirect(`${baseUrl}/backend/settings-simple?email_error=${error || 'no_code'}`)
  }

  // State must be one WE signed in /microsoft/auth (never trust a raw, attacker-
  // suppliable userId), and must match the active browser session — otherwise an
  // attacker could link their mailbox onto a victim's account.
  const stateData = verifyOAuthState<{ userId: string }>(stateRaw)
  const userId = stateData?.userId || null
  if (!userId) {
    return NextResponse.redirect(`${baseUrl}/backend/settings-simple?email_error=invalid_state`)
  }
  const sessionAuth = await getAuthFromCookies()
  if (!sessionAuth?.sub || sessionAuth.sub !== userId) {
    return NextResponse.redirect(`${baseUrl}/backend/settings-simple?email_error=invalid_state`)
  }

  const clientId = process.env.MICROSOFT_CLIENT_ID
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(`${baseUrl}/backend/settings-simple?email_error=not_configured`)
  }

  try {
    const redirectUri = `${baseUrl}/api/microsoft/callback`

    // Exchange code for tokens
    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
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
      console.error('[microsoft.callback] Token exchange failed:', tokens)
      return NextResponse.redirect(`${baseUrl}/backend/settings-simple?email_error=token_failed`)
    }

    // Get user's Microsoft email
    const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    const meData = await meRes.json()
    const emailAddress = meData.mail || meData.userPrincipalName || ''

    // Store the connection
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const crmUser = await knex('users').where('id', userId).first()
    if (!crmUser) {
      return NextResponse.redirect(`${baseUrl}/backend/settings-simple?email_error=user_not_found`)
    }

    const expiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000)
    const encryption = tenantEncryptionFromContainer(container)
    const tenantId = crmUser.tenant_id as string | null
    const sealedAccess = await sealSecretForTenant(encryption, tenantId, tokens.access_token)
    const sealedRefresh = await sealSecretForTenant(encryption, tenantId, tokens.refresh_token || null)

    const existingEmail = await knex('email_connections')
      .where('user_id', userId)
      .where('organization_id', crmUser.organization_id)
      .where('provider', 'microsoft')
      .first()

    const anyExisting = await knex('email_connections')
      .where('user_id', userId)
      .where('organization_id', crmUser.organization_id)
      .where('is_active', true)
      .first()

    if (existingEmail) {
      await knex('email_connections').where('id', existingEmail.id).update({
        email_address: emailAddress,
        access_token: sealedAccess,
        // Microsoft only returns a refresh token on the first consent; keep the
        // stored (already sealed) one when this exchange did not carry one.
        refresh_token: sealedRefresh || existingEmail.refresh_token,
        token_expiry: expiry,
        is_active: true,
        updated_at: new Date(),
      })
    } else {
      await knex('email_connections').insert({
        id: require('crypto').randomUUID(),
        tenant_id: crmUser.tenant_id,
        organization_id: crmUser.organization_id,
        user_id: userId,
        provider: 'microsoft',
        email_address: emailAddress,
        access_token: sealedAccess,
        refresh_token: sealedRefresh || '',
        token_expiry: expiry,
        is_primary: !anyExisting,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      })
    }

    return NextResponse.redirect(`${baseUrl}/backend/settings-simple?email_connected=true`)
  } catch (err) {
    console.error('[microsoft.callback]', err)
    return NextResponse.redirect(`${baseUrl}/backend/settings-simple?email_error=unknown`)
  }
}
