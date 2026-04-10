export const metadata = { GET: { requireAuth: true }, POST: { requireAuth: true } }
export const openApi = { summary: 'Email intelligence sync', methods: {} }
/**
 * Inbox Intelligence Sync
 * POST: Trigger inbox scan for the authenticated user
 * GET: Return current sync status
 */
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { query, queryOne } from '@/app/api/funnels/db'
import { refreshGmailToken } from '@/modules/email/lib/gmail-service'
import { refreshOutlookToken } from '@/modules/email/lib/outlook-service'
import crypto from 'crypto'

const MAX_EMAILS_PER_SYNC = 100

// ---------- Token helpers (raw SQL replacements for Knex-based originals) ----------

interface TokenResult {
  accessToken: string
  emailAddress: string
  connectionId: string
}

async function getGmailTokenRaw(orgId: string, userId: string): Promise<TokenResult | null> {
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

async function getOutlookTokenRaw(orgId: string, userId: string): Promise<TokenResult | null> {
  const conn = await queryOne(
    `SELECT * FROM email_connections
     WHERE organization_id = $1 AND user_id = $2 AND provider = 'microsoft' AND is_active = true
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
    throw new Error('Outlook token expired and no refresh token available')
  }

  const refreshed = await refreshOutlookToken(conn.refresh_token)
  const newExpiry = new Date(Date.now() + refreshed.expiresIn * 1000)

  await query(
    `UPDATE email_connections SET access_token = $1, token_expiry = $2, updated_at = now() WHERE id = $3`,
    [refreshed.accessToken, newExpiry.toISOString(), conn.id]
  )

  return { accessToken: refreshed.accessToken, emailAddress: conn.email_address, connectionId: conn.id }
}

// ---------- Inline engagement tracking (raw SQL) ----------

const SCORE_POINTS: Record<string, number> = {
  email_opened: 1,
  email_clicked: 3,
  form_submitted: 5,
  booking_created: 5,
  invoice_paid: 10,
  deal_created: 3,
  course_enrolled: 5,
  sms_received: 2,
  email_unsubscribed: -5,
  no_activity_30d: -3,
  email_received: 2,
  email_replied: 4,
}

async function trackEngagementRaw(
  orgId: string, tenantId: string, contactId: string, eventType: string, metadata?: Record<string, any>
) {
  const points = SCORE_POINTS[eventType]
  if (points === undefined) return

  try {
    await query(
      `INSERT INTO engagement_events (id, contact_id, organization_id, event_type, points, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [crypto.randomUUID(), contactId, orgId, eventType, points, metadata ? JSON.stringify(metadata) : null]
    )

    const existing = await queryOne(
      `SELECT id, score FROM contact_engagement_scores WHERE contact_id = $1`,
      [contactId]
    )

    if (existing) {
      await query(
        `UPDATE contact_engagement_scores SET score = GREATEST(0, score + $1), last_activity_at = now(), updated_at = now() WHERE contact_id = $2`,
        [points, contactId]
      )
    } else {
      await query(
        `INSERT INTO contact_engagement_scores (id, tenant_id, organization_id, contact_id, score, last_activity_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now(), now())`,
        [crypto.randomUUID(), tenantId, orgId, contactId, Math.max(0, points)]
      )
    }
  } catch (err: any) {
    console.error('[email-intelligence] engagement tracking error:', err?.message)
  }
}

// ---------- Inline timeline logging (raw SQL) ----------

async function logTimelineRaw(params: {
  tenantId: string; organizationId: string; contactId: string;
  eventType: string; title: string; description?: string; metadata?: Record<string, any>
}) {
  try {
    await query(
      `INSERT INTO contact_timeline_events (id, tenant_id, organization_id, contact_id, event_type, title, description, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [
        crypto.randomUUID(), params.tenantId, params.organizationId, params.contactId,
        params.eventType, params.title, params.description || null,
        params.metadata ? JSON.stringify(params.metadata) : null,
      ]
    )
  } catch (err: any) {
    console.error('[email-intelligence] timeline log error:', err?.message)
  }
}

// ---------- Contact lookup / creation ----------

async function findOrCreateContact(
  orgId: string, tenantId: string, email: string, senderName: string, settings: any
): Promise<{ contactId: string; created: boolean }> {
  const existing = await queryOne(
    `SELECT id FROM customer_entities WHERE organization_id = $1 AND primary_email = $2 AND deleted_at IS NULL LIMIT 1`,
    [orgId, email.toLowerCase()]
  )

  if (existing) return { contactId: existing.id, created: false }

  if (!settings.auto_create_contacts) {
    return { contactId: '', created: false }
  }

  const entityId = crypto.randomUUID()
  const personId = crypto.randomUUID()

  const nameParts = senderName.trim().split(/\s+/)
  const firstName = nameParts[0] || email.split('@')[0]
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : ''
  const displayName = senderName.trim() || email.split('@')[0]

  await query(
    `INSERT INTO customer_entities (id, tenant_id, organization_id, kind, display_name, primary_email, source, source_details, status, lifecycle_stage, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, 'person', $4, $5, 'email_inbox', '{"note":"Inbox Intelligence auto-created"}'::jsonb, 'active', 'prospect', true, now(), now())`,
    [entityId, tenantId, orgId, displayName, email.toLowerCase()]
  )

  await query(
    `INSERT INTO customer_people (id, tenant_id, organization_id, entity_id, first_name, last_name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
    [personId, tenantId, orgId, entityId, firstName, lastName]
  )

  return { contactId: entityId, created: true }
}

// ---------- Lifecycle stage auto-advance ----------

async function maybeAdvanceStage(orgId: string, contactId: string) {
  try {
    const contact = await queryOne(
      `SELECT lifecycle_stage FROM customer_entities WHERE id = $1 AND organization_id = $2`,
      [contactId, orgId]
    )
    if (!contact) return

    const scoreRow = await queryOne(
      `SELECT score FROM contact_engagement_scores WHERE contact_id = $1`,
      [contactId]
    )
    const score = scoreRow?.score || 0

    if (contact.lifecycle_stage === 'prospect' && score > 10) {
      await query(
        `UPDATE customer_entities SET lifecycle_stage = 'lead', updated_at = now() WHERE id = $1`,
        [contactId]
      )
    } else if (contact.lifecycle_stage === 'lead') {
      const payment = await queryOne(
        `SELECT id FROM payment_records WHERE contact_id = $1 AND organization_id = $2 AND status = 'succeeded' LIMIT 1`,
        [contactId, orgId]
      )
      if (payment) {
        await query(
          `UPDATE customer_entities SET lifecycle_stage = 'customer', updated_at = now() WHERE id = $1`,
          [contactId]
        )
      }
    }
  } catch (err: any) {
    console.error('[email-intelligence] stage advance error:', err?.message)
  }
}

// ---------- Gmail fetch ----------

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64, 'base64').toString('utf-8')
}

function extractHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''
}

function extractBody(payload: any): { html: string; text: string } {
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

function parseEmailAddress(raw: string): { email: string; name: string } {
  const match = raw.match(/^(.+?)\s*<(.+?)>$/)
  if (match) return { name: match[1].replace(/^["']|["']$/g, '').trim(), email: match[2].trim().toLowerCase() }
  return { name: '', email: raw.trim().toLowerCase() }
}

interface ProcessedEmail {
  messageId: string
  threadId: string
  fromEmail: string
  fromName: string
  toAddress: string
  ccAddress: string
  subject: string
  bodyHtml: string
  bodyText: string
  receivedAt: Date
  isReply: boolean
}

async function fetchGmailMessages(
  accessToken: string, sinceDate: string
): Promise<ProcessedEmail[]> {
  const sinceEpoch = Math.floor(new Date(sinceDate).getTime() / 1000)
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(`in:inbox after:${sinceEpoch}`)}&maxResults=${MAX_EMAILS_PER_SYNC}`

  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!listRes.ok) {
    const err = await listRes.json().catch(() => ({}))
    throw new Error(`Gmail list failed (${listRes.status}): ${err?.error?.message || listRes.statusText}`)
  }

  const listData = await listRes.json()
  const messageStubs: Array<{ id: string; threadId: string }> = listData.messages || []

  const results: ProcessedEmail[] = []

  for (const stub of messageStubs) {
    try {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${stub.id}?format=full`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )

      if (!msgRes.ok) continue

      const msg = await msgRes.json()
      const headers = msg.payload?.headers || []
      const from = extractHeader(headers, 'From')
      const to = extractHeader(headers, 'To')
      const cc = extractHeader(headers, 'Cc')
      const subject = extractHeader(headers, 'Subject')
      const dateStr = extractHeader(headers, 'Date')
      const inReplyTo = extractHeader(headers, 'In-Reply-To')
      const references = extractHeader(headers, 'References')

      const { email: fromEmail, name: fromName } = parseEmailAddress(from)
      const { html, text } = extractBody(msg.payload)

      results.push({
        messageId: stub.id,
        threadId: stub.threadId,
        fromEmail,
        fromName,
        toAddress: to,
        ccAddress: cc,
        subject,
        bodyHtml: html,
        bodyText: text,
        receivedAt: dateStr ? new Date(dateStr) : new Date(),
        isReply: !!(inReplyTo || references),
      })
    } catch (err: any) {
      console.error(`[email-intelligence] Gmail message fetch error for ${stub.id}:`, err?.message)
    }
  }

  return results
}

// ---------- Outlook fetch ----------

async function fetchOutlookMessages(
  accessToken: string, sinceDate: string
): Promise<ProcessedEmail[]> {
  const isoDate = new Date(sinceDate).toISOString()
  const url = `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ${isoDate}&$orderby=receivedDateTime desc&$top=${MAX_EMAILS_PER_SYNC}&$select=id,conversationId,from,toRecipients,ccRecipients,subject,body,receivedDateTime,isRead,internetMessageHeaders`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Outlook list failed (${res.status}): ${err?.error?.message || res.statusText}`)
  }

  const data = await res.json()
  const messages: any[] = data.value || []

  return messages.map(msg => {
    const fromEmail = msg.from?.emailAddress?.address?.toLowerCase() || ''
    const fromName = msg.from?.emailAddress?.name || ''
    const toAddress = (msg.toRecipients || []).map((r: any) => r.emailAddress?.address).filter(Boolean).join(', ')
    const ccAddress = (msg.ccRecipients || []).map((r: any) => r.emailAddress?.address).filter(Boolean).join(', ')

    const inReplyTo = (msg.internetMessageHeaders || []).find(
      (h: any) => h.name?.toLowerCase() === 'in-reply-to'
    )?.value

    return {
      messageId: msg.id,
      threadId: msg.conversationId || '',
      fromEmail,
      fromName,
      toAddress,
      ccAddress,
      subject: msg.subject || '',
      bodyHtml: msg.body?.contentType === 'HTML' ? msg.body.content || '' : '',
      bodyText: msg.body?.contentType === 'Text' ? msg.body.content || '' : '',
      receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : new Date(),
      isReply: !!inReplyTo,
    }
  })
}

// ---------- Check if email is a reply to our outbound ----------

async function isReplyToOurOutbound(orgId: string, threadId: string, fromEmail: string): Promise<boolean> {
  if (!threadId) return false
  const outbound = await queryOne(
    `SELECT id FROM email_messages
     WHERE organization_id = $1 AND thread_id = $2 AND direction = 'outbound' LIMIT 1`,
    [orgId, threadId]
  )
  return !!outbound
}

// ---------- Main sync logic ----------

async function runSync(
  tenantId: string, orgId: string, userId: string
): Promise<{ emailsProcessed: number; contactsCreated: number; errors: string[] }> {
  const settings = await queryOne(
    `SELECT * FROM email_intelligence_settings WHERE organization_id = $1 AND user_id = $2`,
    [orgId, userId]
  )

  if (!settings || !settings.is_enabled) {
    return { emailsProcessed: 0, contactsCreated: 0, errors: ['Inbox Intelligence is not enabled'] }
  }

  // Mark sync as running
  await query(
    `UPDATE email_intelligence_settings SET last_sync_status = 'running', updated_at = now()
     WHERE organization_id = $1 AND user_id = $2`,
    [orgId, userId]
  )

  const sinceDate = settings.last_sync_at
    ? new Date(settings.last_sync_at).toISOString()
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() // Default: last 7 days

  let allEmails: ProcessedEmail[] = []
  const errors: string[] = []
  let gmailToken: TokenResult | null = null
  let outlookToken: TokenResult | null = null

  // Gmail inbox sync is DISABLED pending Tier 1 OAuth verification.
  // gmail.readonly is a restricted scope that requires CASA security
  // assessment to verify. We're shipping with sensitive scopes only
  // (gmail.send + calendar.*). Inbox read will be re-added later via
  // the App Password / IMAP path. The Outlook path below remains
  // active for users connected via Microsoft Graph.
  //
  // To re-enable: uncomment the block below AND restore gmail.readonly
  // in apps/mercato/src/app/api/google/auth/route.ts EMAIL_SCOPES.
  //
  // try {
  //   gmailToken = await getGmailTokenRaw(orgId, userId)
  //   if (gmailToken) {
  //     const gmailEmails = await fetchGmailMessages(gmailToken.accessToken, sinceDate)
  //     allEmails = allEmails.concat(gmailEmails)
  //   }
  // } catch (err: any) {
  //   errors.push(`Gmail: ${err.message}`)
  // }

  // Fetch Outlook
  try {
    outlookToken = await getOutlookTokenRaw(orgId, userId)
    if (outlookToken) {
      const outlookEmails = await fetchOutlookMessages(outlookToken.accessToken, sinceDate)
      allEmails = allEmails.concat(outlookEmails)
    }
  } catch (err: any) {
    errors.push(`Outlook: ${err.message}`)
  }

  if (!outlookToken) {
    await query(
      `UPDATE email_intelligence_settings SET last_sync_status = 'error', last_sync_error = $1, updated_at = now()
       WHERE organization_id = $2 AND user_id = $3`,
      ['No active email connection found (Gmail inbox sync temporarily disabled pending OAuth verification)', orgId, userId]
    )
    return { emailsProcessed: 0, contactsCreated: 0, errors: ['No active email connection found'] }
  }

  let emailsProcessed = 0
  let contactsCreated = 0

  // Get connected email addresses to skip self-sent
  const ownEmails = new Set<string>()
  const connections = await query(
    `SELECT email_address FROM email_connections WHERE organization_id = $1 AND is_active = true`,
    [orgId]
  )
  for (const conn of connections) {
    if (conn.email_address) ownEmails.add(conn.email_address.toLowerCase())
  }

  // Patterns that indicate automated/marketing/junk emails — not real people
  const NOREPLY_PATTERNS = ['noreply@', 'no-reply@', 'donotreply@', 'do-not-reply@', 'mailer-daemon@', 'postmaster@', 'bounce@', 'notifications@', 'notification@', 'alert@', 'alerts@', 'updates@', 'news@', 'newsletter@', 'marketing@', 'promo@', 'promotions@', 'info@', 'support@', 'hello@', 'team@', 'help@', 'billing@', 'accounts@', 'service@', 'feedback@', 'digest@', 'weekly@', 'daily@']
  const NOREPLY_DOMAINS = ['googleusercontent.com', 'facebookmail.com', 'linkedin.com', 'twitter.com', 'x.com', 'github.com', 'notion.so', 'slack.com', 'stripe.com', 'intercom.io', 'mailchimp.com', 'sendgrid.net', 'amazonses.com', 'postmarkapp.com', 'mandrillapp.com', 'mailgun.org', 'hubspot.com', 'salesforce.com', 'zendesk.com', 'freshdesk.com', 'calendly.com', 'zoom.us', 'figma.com', 'canva.com', 'notion.so', 'airtable.com', 'shopify.com', 'squarespace.com', 'wix.com', 'godaddy.com', 'namecheap.com', 'cloudflare.com', 'vercel.com', 'netlify.com', 'heroku.com', 'digitalocean.com', 'hetzner.com', 'google.com', 'apple.com', 'microsoft.com']

  function isAutomatedEmail(fromEmail: string, subject: string): boolean {
    const email = fromEmail.toLowerCase()
    const sub = (subject || '').toLowerCase()
    // Check noreply patterns
    if (NOREPLY_PATTERNS.some(p => email.startsWith(p))) return true
    // Check automated domains
    const domain = email.split('@')[1] || ''
    if (NOREPLY_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) return true
    // Check subject patterns for newsletters/automated
    if (sub.includes('unsubscribe') || sub.includes('verify your email') || sub.includes('confirm your') || sub.includes('password reset') || sub.includes('security alert') || sub.includes('sign-in') || sub.includes('your receipt') || sub.includes('order confirmation') || sub.includes('shipping notification') || sub.includes('delivery notification')) return true
    return false
  }

  for (const email of allEmails) {
    try {
      // Skip emails from ourselves
      if (ownEmails.has(email.fromEmail)) continue

      // Skip automated/marketing/noreply emails
      if (isAutomatedEmail(email.fromEmail, email.subject)) continue

      // Dedup: check if already stored by provider message ID
      const existingMsg = await queryOne(
        `SELECT id FROM email_messages WHERE organization_id = $1 AND metadata->>'provider_message_id' = $2`,
        [orgId, email.messageId]
      )
      if (existingMsg) continue

      // Find or create contact
      const { contactId, created } = await findOrCreateContact(
        orgId, tenantId, email.fromEmail, email.fromName, settings
      )

      if (created) contactsCreated++
      if (!contactId) continue // auto_create_contacts is off and contact not found

      // Determine the account_id (email connection used)
      const accountId = gmailToken?.connectionId || outlookToken?.connectionId || null

      // Store email message — sanitize strings to remove null bytes that break PostgreSQL
      const sanitize = (s: string | null) => s ? s.replace(/\0/g, '') : null
      const msgId = crypto.randomUUID()
      const safeContactId = contactId && contactId.length > 0 ? contactId : null
      const safeAccountId = accountId && accountId.length > 0 ? accountId : null
      const safeSub = sanitize(email.subject) || '(no subject)'
      const safeHtml = sanitize(email.bodyHtml) || ''
      const safeText = sanitize(email.bodyText) || null
      const safeFrom = sanitize(email.fromEmail) || 'unknown'
      const safeTo = sanitize(email.toAddress) || 'unknown'
      const safeCc = sanitize(email.ccAddress) || null
      const sentAt = email.receivedAt?.toISOString() || new Date().toISOString()

      await query(
        `INSERT INTO email_messages (id, tenant_id, organization_id, account_id, direction, from_address, to_address, cc, subject, body_html, body_text, thread_id, contact_id, status, metadata, created_at, sent_at)
         VALUES ($1, $2, $3, $4, 'inbound', $5, $6, $7, $8, $9, $10, $11, $12, 'received', jsonb_build_object('provider_message_id', $13::text, 'source', 'email_intelligence'), now(), $14)
         ON CONFLICT DO NOTHING`,
        [msgId, tenantId, orgId, safeAccountId, safeFrom, safeTo, safeCc, safeSub, safeHtml, safeText, email.threadId || null, safeContactId, String(email.messageId || ''), sentAt]
      )

      // Log timeline event
      if (settings.auto_update_timeline) {
        await logTimelineRaw({
          tenantId,
          organizationId: orgId,
          contactId,
          eventType: 'email_received',
          title: `Received email: ${email.subject || '(no subject)'}`,
          description: `From ${email.fromName || email.fromEmail}`,
          metadata: { email_message_id: msgId, subject: email.subject, from: email.fromEmail },
        })
      }

      // Track engagement
      if (settings.auto_update_engagement) {
        const isReplyToUs = await isReplyToOurOutbound(orgId, email.threadId, email.fromEmail)
        const engagementType = isReplyToUs ? 'email_replied' : 'email_received'

        await trackEngagementRaw(orgId, tenantId, contactId, engagementType, {
          email_message_id: msgId,
          subject: email.subject,
        })
      }

      // Auto-advance lifecycle stage
      if (settings.auto_advance_stage) {
        await maybeAdvanceStage(orgId, contactId)
      }

      emailsProcessed++
    } catch (err: any) {
      const errMsg = err?.message || 'unknown'
      errors.push(`Email ${email.messageId}: ${errMsg}`)
      console.error(`[email-intelligence] Error processing email ${email.messageId}:`, errMsg, `from: ${email.fromEmail}, subject: ${email.subject?.substring(0, 50)}`)
    }
  }

  // Update settings with sync results
  // Only advance last_sync_at if we actually processed emails successfully
  const syncAtClause = emailsProcessed > 0 ? 'last_sync_at = now(),' : ''
  await query(
    `UPDATE email_intelligence_settings SET
      ${syncAtClause}
      last_sync_status = $1,
      last_sync_error = $2,
      emails_processed_total = emails_processed_total + $3,
      contacts_created_total = contacts_created_total + $4,
      updated_at = now()
    WHERE organization_id = $5 AND user_id = $6`,
    [
      errors.length > 0 ? (emailsProcessed > 0 ? 'partial' : 'error') : 'success',
      errors.length > 0 ? errors.join('; ') : null,
      emailsProcessed,
      contactsCreated,
      orgId,
      userId,
    ]
  )

  return { emailsProcessed, contactsCreated, errors }
}

// ---------- Route handlers ----------

export async function GET() {
  const auth = await getAuthFromCookies()
  const userId = auth?.sub || (auth as any)?.userId
  if (!auth?.tenantId || !auth?.orgId || !userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const settings = await queryOne(
    `SELECT last_sync_at, last_sync_status, last_sync_error, emails_processed_total, contacts_created_total
     FROM email_intelligence_settings WHERE organization_id = $1 AND user_id = $2`,
    [auth.orgId, userId]
  )

  return NextResponse.json({
    ok: true,
    data: settings || {
      last_sync_at: null,
      last_sync_status: null,
      last_sync_error: null,
      emails_processed_total: 0,
      contacts_created_total: 0,
    },
  })
}

export async function POST() {
  const auth = await getAuthFromCookies()
  const userId = auth?.sub || (auth as any)?.userId
  if (!auth?.tenantId || !auth?.orgId || !userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await runSync(auth.tenantId, auth.orgId, userId)
    return NextResponse.json({ ok: true, data: result })
  } catch (err: any) {
    console.error('[email-intelligence] Sync failed:', err)
    return NextResponse.json({ ok: false, error: err.message || 'Sync failed' }, { status: 500 })
  }
}

// Export for use by cron route
export { runSync }
