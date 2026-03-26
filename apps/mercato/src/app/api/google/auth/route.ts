import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'

// Redirect user to Google OAuth consent screen
export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  if (!clientId) return NextResponse.json({ error: 'Google OAuth not configured' }, { status: 500 })

  const baseUrl = process.env.APP_URL || 'http://localhost:3000'
  const redirectUri = `${baseUrl}/api/google/callback`

  const scopes = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
  ].join(' ')

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    access_type: 'offline',
    prompt: 'consent',
    state: auth.sub, // Pass user ID in state
  })

  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
}
