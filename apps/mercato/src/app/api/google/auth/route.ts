import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import crypto from 'crypto'

const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
]

const EMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
]

const USERINFO_SCOPE = 'https://www.googleapis.com/auth/userinfo.email'

// Generate PKCE code verifier and challenge
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// In-memory PKCE store (per-request). In production, use a short-lived DB/cache entry.
// We store it in the state param (encrypted or plain) since it's a server-side app.
// Actually, we'll store it in a cookie since state goes to Google and back.

// Redirect user to Google OAuth consent screen
// ?type=calendar | email | both (default: both)
export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  if (!clientId) return NextResponse.json({ error: 'Google OAuth not configured' }, { status: 500 })

  const url = new URL(req.url)
  const type = url.searchParams.get('type') || 'both'

  let scopeList: string[] = [USERINFO_SCOPE]
  if (type === 'calendar') {
    scopeList = [...scopeList, ...CALENDAR_SCOPES]
  } else if (type === 'email') {
    scopeList = [...scopeList, ...EMAIL_SCOPES]
  } else {
    scopeList = [...scopeList, ...CALENDAR_SCOPES, ...EMAIL_SCOPES]
  }

  const baseUrl = process.env.APP_URL || 'http://localhost:3000'
  const redirectUri = `${baseUrl}/api/google/callback`

  const from = url.searchParams.get('from') || 'settings'
  const state = JSON.stringify({ userId: auth.sub, type, from })

  // Generate PKCE challenge
  const { verifier, challenge } = generatePKCE()

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopeList.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })

  // Store the verifier in a cookie so callback can use it
  const response = NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
  response.cookies.set('google_pkce_verifier', verifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600, // 10 minutes
  })
  return response
}
