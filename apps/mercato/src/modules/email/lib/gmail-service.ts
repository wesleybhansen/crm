/**
 * Gmail Service
 * Send emails via Gmail API and manage OAuth token refresh.
 */

import type { Knex } from 'knex'

interface GmailSendResult {
  messageId: string
  threadId: string
}

interface GmailToken {
  accessToken: string
  emailAddress: string
}

/**
 * Build an RFC 2822 MIME email and send it via the Gmail API.
 */
export async function sendViaGmail(
  accessToken: string,
  from: string,
  to: string,
  subject: string,
  htmlBody: string,
  textBody?: string,
  cc?: string,
  bcc?: string,
): Promise<GmailSendResult> {
  console.log('[gmail] sendViaGmail called — from:', from, 'to:', to, 'subject:', subject)
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`

  const textContent = Buffer.from(textBody || htmlBody.replace(/<[^>]+>/g, '')).toString('base64')
  const htmlContent = Buffer.from(htmlBody).toString('base64')

  // Encode subject for UTF-8 support (RFC 2047)
  const encodedSubject = /[^\x20-\x7E]/.test(subject)
    ? `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`
    : subject

  const mimeLines = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    '',
    textContent,
    '',
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    '',
    htmlContent,
    '',
    `--${boundary}--`,
  ]

  const rawMessage = mimeLines.join('\r\n')

  // Base64url encode the message (Gmail API requirement)
  const encoded = Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: encoded }),
  })

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}))
    throw new Error(`Gmail send failed (${res.status}): ${errorData?.error?.message || res.statusText}`)
  }

  const data = await res.json()

  // NOTE: We previously called messages/{id}/modify here to remove the INBOX
  // label from sent messages. That requires gmail.modify (a restricted scope)
  // which we don't request. The call was likely 403'ing already. Removed
  // pending Tier 1 OAuth verification with sensitive scopes only.

  return {
    messageId: data.id || '',
    threadId: data.threadId || '',
  }
}

/**
 * Refresh a Gmail OAuth token using Google's token endpoint.
 */
export async function refreshGmailToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID

  if (!clientId) {
    throw new Error('Google OAuth not configured — missing client ID')
  }

  const body: Record<string, string> = {
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }

  // Include client_secret if available (optional with PKCE)
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (clientSecret) {
    body.client_secret = clientSecret
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })

  const tokens = await res.json()

  if (!tokens.access_token) {
    const errorDesc = tokens.error_description || tokens.error || 'unknown'
    // If the refresh token is revoked/expired, throw a specific error
    if (tokens.error === 'invalid_grant') {
      throw new Error(`Gmail refresh token expired or revoked. Please reconnect Gmail in Settings. (${errorDesc})`)
    }
    throw new Error(`Token refresh failed: ${errorDesc}`)
  }

  return {
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in || 3600,
  }
}

/**
 * Look up the user's Gmail email_connection, refresh token if expired,
 * and return a valid access_token + email_address.
 */
export async function getGmailToken(
  knex: Knex,
  orgId: string,
  userId: string,
): Promise<GmailToken | null> {
  const connection = await knex('email_connections')
    .where('organization_id', orgId)
    .where('user_id', userId)
    .where('provider', 'gmail')
    .where('is_active', true)
    .first()

  if (!connection) return null

  const expiry = new Date(connection.token_expiry)
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000)

  if (expiry > fiveMinutesFromNow) {
    // Token still valid
    return {
      accessToken: connection.access_token,
      emailAddress: connection.email_address,
    }
  }

  // Token expired or about to expire — refresh it
  if (!connection.refresh_token) {
    throw new Error('Gmail token expired and no refresh token available. Please reconnect Gmail in Settings.')
  }

  try {
    const refreshed = await refreshGmailToken(connection.refresh_token)
    const newExpiry = new Date(Date.now() + refreshed.expiresIn * 1000)

    await knex('email_connections').where('id', connection.id).update({
      access_token: refreshed.accessToken,
      token_expiry: newExpiry,
      updated_at: new Date(),
    })

    return {
      accessToken: refreshed.accessToken,
      emailAddress: connection.email_address,
    }
  } catch (refreshErr) {
    // If refresh token is revoked, deactivate the connection so we don't keep trying
    const msg = refreshErr instanceof Error ? refreshErr.message : ''
    if (msg.includes('expired or revoked') || msg.includes('invalid_grant')) {
      console.error('[gmail] Refresh token revoked — deactivating connection:', connection.id)
      await knex('email_connections').where('id', connection.id).update({
        is_active: false,
        updated_at: new Date(),
      })
    }
    throw refreshErr
  }
}
