import crypto from 'crypto'
import { getGmailToken } from '@/modules/email/lib/gmail-service'
import { ingestImapConnection } from '@/modules/email/lib/inbox-ingest'

/* Dedicated personal-mailbox sync for the Unified Inbox. Fetches NEW incoming
 * mail from a user's active personal connections (purpose null) into
 * email_messages so the inbox shows current mail. Gmail = OAuth (Gmail API),
 * everything with IMAP creds = ingestImapConnection. Deliberately independent of
 * the half-built email-intelligence pipeline (which is broken on a missing
 * email_intelligence_settings table). Dedupes by provider_message_id. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Knex = any

const MAX = 40

function extractHeader(headers: Array<{ name?: string; value?: string }>, name: string): string {
  const h = headers.find((x) => (x.name || '').toLowerCase() === name.toLowerCase())
  return h?.value || ''
}
function parseAddr(raw: string): { email: string; name: string } {
  const m = raw.match(/<([^>]+)>/)
  const email = (m ? m[1] : raw).trim().toLowerCase()
  const name = m ? raw.replace(/<[^>]+>/, '').replace(/"/g, '').trim() : ''
  return { email, name }
}
function b64url(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  } catch {
    return ''
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBody(payload: any): { html: string; text: string } {
  let html = ''
  let text = ''
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (p: any) => {
    if (!p) return
    const mt = p.mimeType || ''
    if (mt === 'text/html' && p.body?.data && !html) html = b64url(p.body.data)
    else if (mt === 'text/plain' && p.body?.data && !text) text = b64url(p.body.data)
    for (const part of p.parts || []) walk(part)
  }
  walk(payload)
  return { html, text }
}

type FetchedMsg = {
  messageId: string
  threadId: string
  fromEmail: string
  toAddress: string
  cc: string
  subject: string
  bodyHtml: string
  bodyText: string
  receivedAt: Date
}

async function fetchGmail(accessToken: string, sinceEpoch: number): Promise<FetchedMsg[]> {
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(
    `in:inbox after:${sinceEpoch}`,
  )}&maxResults=${MAX}`
  const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!listRes.ok) throw new Error(`gmail list ${listRes.status}`)
  const listData = await listRes.json()
  const stubs: Array<{ id: string; threadId: string }> = listData.messages || []
  const out: FetchedMsg[] = []
  for (const stub of stubs) {
    try {
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${stub.id}?format=full`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!r.ok) continue
      const msg = await r.json()
      const headers = msg.payload?.headers || []
      const { email: fromEmail } = parseAddr(extractHeader(headers, 'From'))
      const { html, text } = extractBody(msg.payload)
      const dateStr = extractHeader(headers, 'Date')
      out.push({
        messageId: stub.id,
        threadId: stub.threadId,
        fromEmail,
        toAddress: extractHeader(headers, 'To'),
        cc: extractHeader(headers, 'Cc'),
        subject: extractHeader(headers, 'Subject'),
        bodyHtml: html,
        bodyText: text,
        receivedAt: dateStr ? new Date(dateStr) : new Date(),
      })
    } catch {
      /* skip one bad message */
    }
  }
  return out
}

async function writeInbound(
  knex: Knex,
  orgId: string,
  tenantId: string,
  accountId: string,
  mailboxAddr: string,
  msgs: FetchedMsg[],
  mine: Set<string>,
): Promise<number> {
  let n = 0
  for (const m of msgs) {
    if (!m.fromEmail || mine.has(m.fromEmail.toLowerCase())) continue // skip self-sent
    const dup = await knex('email_messages')
      .where('organization_id', orgId)
      .whereRaw("metadata->>'provider_message_id' = ?", [m.messageId])
      .first()
    if (dup) continue
    const at = m.receivedAt || new Date()
    await knex('email_messages').insert({
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      organization_id: orgId,
      account_id: accountId,
      direction: 'inbound',
      from_address: m.fromEmail,
      to_address: m.toAddress || mailboxAddr,
      cc: m.cc || null,
      subject: m.subject || '(no subject)',
      body_html: m.bodyHtml || '',
      body_text: m.bodyText || null,
      thread_id: m.threadId || null,
      contact_id: null,
      status: 'delivered',
      tracking_id: crypto.randomUUID(),
      metadata: JSON.stringify({ source: 'personal_inbox', provider_message_id: m.messageId }),
      created_at: at,
      updated_at: new Date(),
      sent_at: at,
    })
    n++
  }
  return n
}

/** Sync all of a user's active personal mailboxes. Returns how many NEW messages landed. */
export async function syncPersonalInbox(
  knex: Knex,
  orgId: string,
  tenantId: string,
  userId: string,
  days = 14,
): Promise<{ synced: number; mailboxes: number; errors: string[] }> {
  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const conns = (await knex('email_connections')
    .where('organization_id', orgId)
    .where('user_id', userId)
    .where('is_active', true)
    .whereNull('purpose')
    .select('id', 'provider', 'email_address', 'imap_host', 'imap_port', 'imap_secure', 'smtp_user', 'smtp_pass', 'purpose')) as Array<
    Record<string, unknown>
  >
  const mine = new Set(conns.map((c) => String(c.email_address || '').toLowerCase()).filter(Boolean))
  let synced = 0
  const errors: string[] = []

  for (const conn of conns) {
    try {
      if (conn.provider === 'gmail') {
        const token = await getGmailToken(knex, orgId, userId)
        if (!token) {
          errors.push('gmail: not authorized (reconnect)')
          continue
        }
        const msgs = await fetchGmail(token.accessToken, Math.floor(sinceDate.getTime() / 1000))
        synced += await writeInbound(knex, orgId, tenantId, String(conn.id), token.emailAddress, msgs, mine)
      } else if (conn.imap_host && conn.smtp_pass) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await ingestImapConnection(knex, orgId, tenantId, conn as any, {
          sinceDate,
          maxMessages: MAX,
          autoCreateContacts: false,
          source: 'personal_inbox',
          ownEmails: mine,
        })
        synced += res.emailsProcessed
        if (res.errors.length) errors.push(...res.errors.slice(0, 2))
      } else {
        errors.push(`${conn.provider}: no inbox access (reconnect with an app password)`)
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : 'sync failed')
    }
  }
  return { synced, mailboxes: conns.length, errors: errors.slice(0, 4) }
}
