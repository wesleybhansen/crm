export const metadata = { path: '/auth/google/start', GET: {} }

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'

const AUTH_SCOPES = ['openid', 'email', 'profile']

function generatePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  if (!clientId) {
    return NextResponse.json({ error: 'Google sign-in not configured' }, { status: 500 })
  }

  const url = new URL(req.url)
  const base = process.env.APP_URL || `${url.protocol}//${url.host}`
  const redirectUri = `${base}/api/auth/google/callback`

  const state = crypto.randomBytes(24).toString('hex')
  const { verifier, challenge } = generatePkce()

  const authorizeUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('scope', AUTH_SCOPES.join(' '))
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('code_challenge', challenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')
  authorizeUrl.searchParams.set('access_type', 'online')
  authorizeUrl.searchParams.set('prompt', 'select_account')

  const res = NextResponse.redirect(authorizeUrl.toString())
  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 10 * 60, // 10 minutes
  }
  res.cookies.set('google_auth_state', state, cookieOpts)
  res.cookies.set('google_auth_verifier', verifier, cookieOpts)
  return res
}
