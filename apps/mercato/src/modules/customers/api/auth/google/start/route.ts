export const metadata = { path: '/auth/google/start', GET: {} }

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'

// Starts the "Continue with Google" sign-in flow. The callback at
// /api/auth/google/callback validates the state + PKCE cookies set here.
export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const url = new URL(req.url)
  const base = process.env.APP_URL || `${url.protocol}//${url.host}`

  if (!clientId) {
    const login = new URL('/login', base)
    login.searchParams.set('error', 'Google sign-in is not configured')
    return NextResponse.redirect(login.toString())
  }

  const state = crypto.randomBytes(24).toString('base64url')
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${base}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  })

  const res = NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 600,
  }
  res.cookies.set('google_auth_state', state, cookieOpts)
  res.cookies.set('google_auth_verifier', verifier, cookieOpts)
  return res
}
