import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'

const MICROSOFT_SCOPES = [
  'Mail.Send',
  'Mail.ReadWrite',
  'User.Read',
  'offline_access',
]

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const clientId = process.env.MICROSOFT_CLIENT_ID
  if (!clientId) return NextResponse.json({ error: 'Microsoft OAuth not configured' }, { status: 500 })

  const baseUrl = process.env.APP_URL || 'http://localhost:3000'
  const redirectUri = `${baseUrl}/api/microsoft/callback`

  const state = JSON.stringify({ userId: auth.sub })

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: MICROSOFT_SCOPES.join(' '),
    response_mode: 'query',
    state,
  })

  return NextResponse.redirect(
    `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`,
  )
}
