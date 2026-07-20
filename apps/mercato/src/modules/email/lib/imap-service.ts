/**
 * IMAP Service
 * Fetch inbox and sent messages via IMAP using imapflow.
 * Works with any provider: Gmail, Outlook, Yahoo, iCloud, custom domains.
 */

import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'

export interface ImapConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
}

export interface FetchedEmail {
  messageId: string
  uid: number
  threadRef: string       // In-Reply-To or References chain root for thread grouping
  fromEmail: string
  fromName: string
  toAddress: string
  ccAddress: string
  subject: string
  bodyHtml: string
  bodyText: string
  receivedAt: Date
  isReply: boolean
  rawMessageId: string    // The email's own Message-ID header
  references: string      // Full References header for thread reconstruction
  inReplyTo: string
  // Selected raw headers (lower-cased keys) used for automated/bulk detection
  // downstream (Precedence, Auto-Submitted, List-Unsubscribe, List-Id, ...).
  headers: Record<string, string>
}

// Simple (single-string) headers we keep for automated/bulk-mail detection.
// NOTE: mailparser collapses all List-* headers under one structured `list` key
// (not list-unsubscribe / list-id), so those are handled separately below.
const KEEP_HEADERS = ['precedence', 'auto-submitted', 'feedback-id', 'x-autoreply', 'x-autorespond']

// Normalize mailparser's structured `list` header object into the flat
// list-unsubscribe / list-id / list-post keys our automated-mail detector reads.
function extractListHeaders(listVal: any, out: Record<string, string>) {
  if (!listVal || typeof listVal !== 'object') return
  for (const key of ['unsubscribe', 'id', 'post']) {
    const v = listVal[key]
    if (v == null) continue
    // mailparser shapes each as { url } | { value } | string; stringify safely.
    const s = typeof v === 'string' ? v : (v.url || v.value || JSON.stringify(v))
    if (s) out[`list-${key}`] = String(s)
  }
}

// Well-known IMAP/SMTP server presets keyed by domain suffix
const PROVIDER_PRESETS: Record<string, { imap: { host: string; port: number; secure: boolean }; smtp: { host: string; port: number } }> = {
  'gmail.com': {
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 587 },
  },
  'googlemail.com': {
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 587 },
  },
  'outlook.com': {
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587 },
  },
  'hotmail.com': {
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587 },
  },
  'live.com': {
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587 },
  },
  'yahoo.com': {
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 587 },
  },
  'icloud.com': {
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587 },
  },
  'me.com': {
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587 },
  },
  'mac.com': {
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587 },
  },
  'zoho.com': {
    imap: { host: 'imap.zoho.com', port: 993, secure: true },
    smtp: { host: 'smtp.zoho.com', port: 587 },
  },
  'fastmail.com': {
    imap: { host: 'imap.fastmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.fastmail.com', port: 587 },
  },
  'protonmail.com': {
    imap: { host: '127.0.0.1', port: 1143, secure: false },
    smtp: { host: '127.0.0.1', port: 1025 },
  },
  'pm.me': {
    imap: { host: '127.0.0.1', port: 1143, secure: false },
    smtp: { host: '127.0.0.1', port: 1025 },
  },
}

export function getProviderPreset(email: string) {
  const domain = email.split('@')[1]?.toLowerCase() || ''
  return PROVIDER_PRESETS[domain] || null
}

function buildClient(config: ImapConfig): ImapFlow {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    logger: false,
    tls: { rejectUnauthorized: false },
  })
}

async function fetchMessagesFromFolder(
  config: ImapFlow,
  folder: string,
  sinceDate: Date,
  maxMessages: number,
): Promise<FetchedEmail[]> {
  const results: FetchedEmail[] = []

  try {
    await config.mailboxOpen(folder)
  } catch {
    return results
  }

  const since = new Date(sinceDate)
  since.setHours(0, 0, 0, 0)

  const uids = await config.search({ since }, { uid: true })
  if (!uids || uids.length === 0) return results

  const toFetch = uids.slice(-maxMessages)

  // Fetch in small chunks: Gmail IMAP throws "Command failed" when asked for the
  // full source of many messages at once, which aborts the entire sync. Skipping
  // a failing chunk lets the rest still come through.
  const CHUNK = 8
  for (let ci = 0; ci < toFetch.length; ci += CHUNK) {
   try {
    for await (const msg of config.fetch(toFetch.slice(ci, ci + CHUNK), { envelope: true, source: true }, { uid: true })) {
    try {
      const parsed = await simpleParser(msg.source)

      const fromAddr = parsed.from?.value?.[0]
      const fromEmail = fromAddr?.address?.toLowerCase() || ''
      const fromName = fromAddr?.name || ''

      const toAddresses = parsed.to
        ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to])
            .flatMap(a => a.value)
            .map(a => a.address)
            .filter(Boolean)
            .join(', ')
        : ''

      const ccAddresses = parsed.cc
        ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc])
            .flatMap(a => a.value)
            .map(a => a.address)
            .filter(Boolean)
            .join(', ')
        : ''

      const rawMessageId = (parsed.messageId || '').replace(/[<>]/g, '').trim()
      const inReplyTo = (parsed.inReplyTo || '').replace(/[<>]/g, '').trim()
      const references = parsed.references
        ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references])
            .join(' ')
            .replace(/[<>]/g, '')
            .trim()
        : ''

      // Thread root = first entry in References chain, or the message itself
      const refList = references.split(/\s+/).filter(Boolean)
      const threadRef = refList[0] || inReplyTo || rawMessageId

      // Pull the small allow-list of headers used for automated-mail detection.
      // mailparser exposes a case-insensitive headers Map.
      const headers: Record<string, string> = {}
      for (const h of KEEP_HEADERS) {
        const v = parsed.headers?.get(h)
        if (v == null) continue
        headers[h] = Array.isArray(v) ? v.map(String).join(', ') : String(v)
      }
      // mailparser exposes List-* headers as one structured `list` object.
      extractListHeaders(parsed.headers?.get('list'), headers)

      results.push({
        messageId: rawMessageId || String(msg.uid),
        uid: msg.uid,
        threadRef,
        fromEmail,
        fromName,
        toAddress: toAddresses,
        ccAddress: ccAddresses,
        subject: parsed.subject || '(no subject)',
        bodyHtml: parsed.html || '',
        bodyText: parsed.text || '',
        receivedAt: parsed.date || new Date(),
        isReply: !!(inReplyTo || references),
        rawMessageId,
        references,
        inReplyTo,
        headers,
      })
    } catch {
      // Skip malformed messages
    }
    }
   } catch {
     // A chunk failed (e.g. Gmail "Command failed") — keep going with the rest.
   }
  }

  return results
}

export async function testImapConnection(config: ImapConfig): Promise<{ ok: boolean; error?: string }> {
  const client = buildClient(config)
  try {
    await client.connect()
    await client.logout()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' }
  }
}

export async function fetchImapInbox(
  config: ImapConfig,
  sinceDate: Date,
  maxMessages = 100,
): Promise<FetchedEmail[]> {
  const client = buildClient(config)
  await client.connect()
  try {
    return await fetchMessagesFromFolder(client, 'INBOX', sinceDate, maxMessages)
  } finally {
    await client.logout().catch(() => {})
  }
}

/* List the Message-IDs of EVERY message currently in the INBOX since `sinceDate`
 * (envelope-only fetch — light). Used to reconcile the local mirror: any locally
 * stored message no longer in this set was deleted or archived in Gmail. Returns
 * null on any failure so the caller NEVER deletes on an incomplete/failed read. */
export async function listInboxMessageIds(config: ImapConfig, sinceDate: Date): Promise<Set<string> | null> {
  const client = buildClient(config)
  try {
    await client.connect()
  } catch {
    return null
  }
  const ids = new Set<string>()
  let ok = true
  try {
    await client.mailboxOpen('INBOX')
    const since = new Date(sinceDate)
    since.setHours(0, 0, 0, 0)
    const uids = await client.search({ since }, { uid: true })
    if (uids && uids.length) {
      const CHUNK = 300
      for (let ci = 0; ci < uids.length; ci += CHUNK) {
        try {
          for await (const msg of client.fetch(uids.slice(ci, ci + CHUNK), { envelope: true }, { uid: true })) {
            const mid = (msg.envelope?.messageId || '').replace(/[<>]/g, '').trim()
            // Fallback to the UID string, matching the ingest's messageId fallback.
            ids.add(mid || String(msg.uid))
          }
        } catch {
          // A chunk failed — we can no longer trust completeness, so bail out.
          ok = false
          break
        }
      }
    }
  } catch {
    ok = false
  } finally {
    await client.logout().catch(() => {})
  }
  return ok ? ids : null
}

export async function fetchImapSent(
  config: ImapConfig,
  sinceDate: Date,
  maxMessages = 50,
): Promise<FetchedEmail[]> {
  const client = buildClient(config)
  await client.connect()
  try {
    // Try common sent folder names across providers
    for (const folder of ['[Gmail]/Sent Mail', 'Sent', 'Sent Items', 'Sent Messages', 'INBOX.Sent']) {
      const msgs = await fetchMessagesFromFolder(client, folder, sinceDate, maxMessages)
      if (msgs.length >= 0) return msgs
    }
    return []
  } finally {
    await client.logout().catch(() => {})
  }
}
