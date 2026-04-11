/**
 * Shared Gmail API helpers
 * Used by email-intelligence/sync and ai/learn-voice
 */

import { query, queryOne } from '@/lib/db'
import { refreshGmailToken } from './gmail-service'

export interface GmailTokenResult {
  accessToken: string
  emailAddress: string
  connectionId: string
}

export async function getGmailTokenRaw(orgId: string, userId: string): Promise<GmailTokenResult | null> {
  const conn = await queryOne(
    `SELECT * FROM email_connections
     WHERE organization_id = $1 AND user_id = $2 AND provider = 'gmail' AND is_active = true
     LIMIT 1`,
    [orgId, userId]
  )
  if (!conn) return null

  const expiry = new Date(conn.token_expiry)
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000)

  if (expiry > fiveMinutesFromNow) {
    return { accessToken: conn.access_token, emailAddress: conn.email_address, connectionId: conn.id }
  }

  if (!conn.refresh_token) {
    throw new Error('Gmail token expired and no refresh token available')
  }

  const refreshed = await refreshGmailToken(conn.refresh_token)
  const newExpiry = new Date(Date.now() + refreshed.expiresIn * 1000)

  await query(
    `UPDATE email_connections SET access_token = $1, token_expiry = $2, updated_at = now() WHERE id = $3`,
    [refreshed.accessToken, newExpiry.toISOString(), conn.id]
  )

  return { accessToken: refreshed.accessToken, emailAddress: conn.email_address, connectionId: conn.id }
}

export function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64, 'base64').toString('utf-8')
}

export function extractHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''
}

export function extractBody(payload: any): { html: string; text: string } {
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data)
    if (payload.mimeType === 'text/html') return { html: decoded, text: '' }
    return { html: '', text: decoded }
  }

  let html = ''
  let text = ''
  const parts = payload.parts || []
  for (const part of parts) {
    if (part.mimeType === 'text/html' && part.body?.data) {
      html = decodeBase64Url(part.body.data)
    } else if (part.mimeType === 'text/plain' && part.body?.data) {
      text = decodeBase64Url(part.body.data)
    } else if (part.parts) {
      const nested = extractBody(part)
      if (nested.html) html = nested.html
      if (nested.text) text = nested.text
    }
  }
  return { html, text }
}

export function parseEmailAddress(raw: string): { email: string; name: string } {
  const match = raw.match(/^(.+?)\s*<(.+?)>$/)
  if (match) return { name: match[1].replace(/^["']|["']$/g, '').trim(), email: match[2].trim().toLowerCase() }
  return { name: '', email: raw.trim().toLowerCase() }
}

/**
 * Fetch sent Gmail messages for voice analysis
 */
export async function fetchGmailSentMessages(
  accessToken: string, maxResults = 25
): Promise<{ subject: string; bodyText: string }[]> {
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent('in:sent')}&maxResults=${maxResults}`

  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!listRes.ok) {
    const err = await listRes.json().catch(() => ({}))
    throw new Error(`Gmail list failed (${listRes.status}): ${err?.error?.message || listRes.statusText}`)
  }

  const listData = await listRes.json()
  const stubs: Array<{ id: string }> = listData.messages || []
  const results: { subject: string; bodyText: string }[] = []

  for (const stub of stubs) {
    try {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${stub.id}?format=full`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
      if (!msgRes.ok) continue

      const msg = await msgRes.json()
      const headers = msg.payload?.headers || []
      const subject = extractHeader(headers, 'Subject')
      const { html, text } = extractBody(msg.payload)

      // Prefer plain text, fall back to stripped HTML
      let bodyText = text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      // Truncate to 500 chars per email to stay within AI context limits
      if (bodyText.length > 500) bodyText = bodyText.slice(0, 500)

      if (bodyText.length > 20) {
        results.push({ subject, bodyText })
      }
    } catch {
      // Skip individual message errors
    }
  }

  return results
}
