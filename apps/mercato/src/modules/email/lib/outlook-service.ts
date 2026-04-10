/**
 * Outlook Service
 * Send emails via Microsoft Graph API and manage OAuth token refresh.
 */

import type { Knex } from 'knex'

interface OutlookSendResult {
  messageId: string
}

interface OutlookToken {
  accessToken: string
  emailAddress: string
}

/**
 * Send an email via Microsoft Graph API.
 */
export async function sendViaOutlook(
  accessToken: string,
  from: string,
  to: string,
  subject: string,
  htmlBody: string,
  cc?: string,
  bcc?: string,
  fromName?: string,
): Promise<OutlookSendResult> {
  const ccRecipients = cc
    ? cc.split(',').map(addr => ({ emailAddress: { address: addr.trim() } })).filter(r => r.emailAddress.address)
    : []
  const bccRecipients = bcc
    ? bcc.split(',').map(addr => ({ emailAddress: { address: addr.trim() } })).filter(r => r.emailAddress.address)
    : []

  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject,
        body: {
          contentType: 'HTML',
          content: htmlBody,
        },
        from: {
          emailAddress: { address: from, ...(fromName ? { name: fromName } : {}) },
        },
        toRecipients: [
          { emailAddress: { address: to } },
        ],
        ...(ccRecipients.length ? { ccRecipients } : {}),
        ...(bccRecipients.length ? { bccRecipients } : {}),
      },
    }),
  })

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}))
    throw new Error(
      `Outlook send failed (${res.status}): ${errorData?.error?.message || res.statusText}`,
    )
  }

  // Microsoft Graph sendMail returns 202 with no body on success
  // The message ID is not returned directly; generate a tracking ID
  return {
    messageId: `outlook_${Date.now()}_${Math.random().toString(36).slice(2)}`,
  }
}

/**
 * Refresh a Microsoft OAuth token using the Microsoft token endpoint.
 */
export async function refreshOutlookToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const clientId = process.env.MICROSOFT_CLIENT_ID
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('Microsoft OAuth not configured — missing client ID or secret')
  }

  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: 'Mail.Send Mail.ReadWrite User.Read offline_access',
    }),
  })

  const tokens = await res.json()

  if (!tokens.access_token) {
    throw new Error(`Token refresh failed: ${tokens.error_description || tokens.error || 'unknown'}`)
  }

  return {
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in || 3600,
  }
}

/**
 * Look up the user's Microsoft email_connection, refresh token if expired,
 * and return a valid access_token + email_address.
 */
export async function getOutlookToken(
  knex: Knex,
  orgId: string,
  userId: string,
): Promise<OutlookToken | null> {
  const connection = await knex('email_connections')
    .where('organization_id', orgId)
    .where('user_id', userId)
    .where('provider', 'microsoft')
    .where('is_active', true)
    .first()

  if (!connection) return null

  const expiry = new Date(connection.token_expiry)
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000)

  if (expiry > fiveMinutesFromNow) {
    return {
      accessToken: connection.access_token,
      emailAddress: connection.email_address,
    }
  }

  // Token expired or about to expire — refresh it
  if (!connection.refresh_token) {
    throw new Error('Outlook token expired and no refresh token available. Please reconnect Outlook.')
  }

  const refreshed = await refreshOutlookToken(connection.refresh_token)
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
}
