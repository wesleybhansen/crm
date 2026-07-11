export const metadata = { path: '/auth/google/callback', GET: {} }

import { NextRequest, NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { AuthService } from '@open-mercato/core/modules/auth/services/authService'
import { setupInitialTenant } from '@open-mercato/core/modules/auth/lib/setup-app'
import { getModules } from '@open-mercato/shared/lib/modules/registry'
import { signJwt } from '@open-mercato/shared/lib/auth/jwt'
import { User } from '@open-mercato/core/modules/auth/data/entities'

type GoogleIdPayload = {
  sub: string
  email: string
  email_verified?: boolean
  name?: string
  given_name?: string
  family_name?: string
  picture?: string
}

function decodeIdTokenPayload(idToken: string): GoogleIdPayload | null {
  try {
    const parts = idToken.split('.')
    if (parts.length !== 3) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (typeof payload?.sub !== 'string' || typeof payload?.email !== 'string') return null
    return payload as GoogleIdPayload
  } catch {
    return null
  }
}

function errorRedirect(base: string, msg: string) {
  const url = new URL(`${base}/login`)
  url.searchParams.set('error', msg)
  return NextResponse.redirect(url.toString())
}

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  const url = new URL(req.url)
  const base = process.env.APP_URL || `${url.protocol}//${url.host}`

  if (!clientId || !clientSecret) {
    return errorRedirect(base, 'Google sign-in is not configured')
  }

  const error = url.searchParams.get('error')
  if (error) {
    const friendly = error === 'access_denied' ? 'Google sign-in was cancelled' : 'Google sign-in failed'
    return errorRedirect(base, friendly)
  }

  const code = url.searchParams.get('code') || ''
  const state = url.searchParams.get('state') || ''
  const cookieState = req.cookies.get('google_auth_state')?.value || ''
  const codeVerifier = req.cookies.get('google_auth_verifier')?.value || ''

  if (!code || !state || !cookieState || state !== cookieState || !codeVerifier) {
    return errorRedirect(base, 'Invalid Google sign-in request')
  }

  // Exchange code for tokens
  const redirectUri = `${base}/api/auth/google/callback`
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  })

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '')
    console.error('[auth/google/callback] token exchange failed', tokenRes.status, body.slice(0, 300))
    return errorRedirect(base, 'Google sign-in failed')
  }

  const tokens = (await tokenRes.json().catch(() => null)) as { id_token?: string } | null
  const idToken = tokens?.id_token
  if (!idToken) return errorRedirect(base, 'Google sign-in failed')

  const payload = decodeIdTokenPayload(idToken)
  if (!payload) return errorRedirect(base, 'Google sign-in failed')
  if (payload.email_verified === false) return errorRedirect(base, 'Google account email is not verified')

  const email = payload.email.toLowerCase().trim()
  const googleSub = payload.sub
  const name = payload.name?.trim() || [payload.given_name, payload.family_name].filter(Boolean).join(' ') || email

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const auth = container.resolve('authService') as AuthService

  let user: User | null = await em.findOne(User, { googleSub } as any)

  let redirectPath = '/backend'

  if (!user) {
    user = await auth.findUserByEmail(email)
    if (user) {
      user.googleSub = googleSub
      if (!user.isConfirmed) user.isConfirmed = true
      await em.persistAndFlush(user)
    }
  }

  if (!user) {
    const nameParts = name.split(/\s+/)
    const firstName = nameParts[0]
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined

    const result = await setupInitialTenant(em, {
      orgName: `${firstName}'s Workspace`,
      primaryUser: {
        email,
        firstName,
        lastName,
        displayName: name,
        confirm: true,
      },
      primaryUserRoles: ['admin'],
      includeDerivedUsers: false,
      includeSuperadminRole: true,
      modules: getModules(),
    })

    const primary = result.users.find((u) => u.roles.includes('admin'))
    if (!primary) return errorRedirect(base, 'Failed to create account')
    user = primary.user
    user.googleSub = googleSub
    await em.persistAndFlush(user)
    redirectPath = '/backend/welcome'
  }

  if (!user) return errorRedirect(base, 'Google sign-in failed')

  const resolvedTenantId = user.tenantId ? String(user.tenantId) : null
  const resolvedOrgId = user.organizationId ? String(user.organizationId) : null
  const roleNames = await auth.getUserRoles(user, resolvedTenantId)

  const token = signJwt({
    sub: String(user.id),
    tenantId: resolvedTenantId,
    orgId: resolvedOrgId,
    email,
    roles: roleNames,
  })

  await auth.updateLastLoginAt(user).catch(() => undefined)

  const res = NextResponse.redirect(`${base}${redirectPath}`)
  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 60 * 60 * 8,
  }
  res.cookies.set('auth_token', token, cookieOpts)
  res.cookies.set('session_token', token, cookieOpts)
  // Clear one-shot OAuth cookies
  res.cookies.set('google_auth_state', '', { path: '/', maxAge: 0 })
  res.cookies.set('google_auth_verifier', '', { path: '/', maxAge: 0 })
  return res
}
