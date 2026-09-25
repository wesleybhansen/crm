/**
 * Dashboard "Needs attention" shaping (QA 2026-09-25 M7 / #16): the panel
 * showed the same internal ops alert ("Urgent: Hermes upgrade control alert"
 * from notifications@noliai.com) ten times. Automated and Noli system mail is
 * not a customer conversation, so it is left out, and repeats of one thread
 * from one sender collapse into a single row with a count.
 *
 * Pure, no imports: safe for any bundle.
 */
export type AttentionRow = {
  id: string
  subject: string | null
  from_address: string | null
  sentiment: string
  contact_id: string | null
  created_at: string | Date
  contact_name?: string | null
}

export type AttentionItem = {
  id: string
  type: string
  title: string
  description: string
  contactId: string | null
  timestamp: string | Date
  count: number
}

/** Domains whose system mailboxes send Noli's own notifications and alerts. */
const SYSTEM_DOMAINS = ['noliai.com']

/** Mailbox names that are machines, not people, on any domain. */
const AUTOMATED_LOCAL_PARTS = new Set([
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply', 'do_not_reply',
  'mailer-daemon', 'postmaster', 'bounce', 'bounces',
])

/** Extra mailbox names that are automated on Noli's own domains. */
const SYSTEM_LOCAL_PARTS = new Set([
  'notifications', 'notification', 'notify', 'alerts', 'alert', 'system', 'ops',
  'monitoring', 'hermes', 'automated', 'robot', 'bot',
])

/** The bare address from "Name <a@b.com>" or "a@b.com", lowercased. */
export function senderAddress(from: string | null | undefined): string {
  const raw = (from ?? '').trim()
  const angled = /<([^>]+)>/.exec(raw)
  return (angled ? angled[1] : raw).trim().toLowerCase()
}

export function isAutomatedOrSystemSender(from: string | null | undefined): boolean {
  const address = senderAddress(from)
  const at = address.lastIndexOf('@')
  if (at <= 0) return false
  const local = address.slice(0, at)
  const domain = address.slice(at + 1)
  const base = local.split('+')[0]
  if (AUTOMATED_LOCAL_PARTS.has(base)) return true
  const isSystemDomain = SYSTEM_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))
  return isSystemDomain && SYSTEM_LOCAL_PARTS.has(base)
}

function normalizeSubject(subject: string | null | undefined): string {
  return (subject ?? '')
    .replace(/^\s*((re|fw|fwd|aw)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Drop automated/system senders, then collapse rows with the same sentiment,
 * subject (ignoring Re:/Fwd:) and sender into one item, newest first.
 */
export function buildAttentionItems(rows: AttentionRow[], limit = 10): AttentionItem[] {
  const groups = new Map<string, { row: AttentionRow; count: number }>()
  for (const row of rows) {
    if (isAutomatedOrSystemSender(row.from_address)) continue
    const key = [row.sentiment, normalizeSubject(row.subject), senderAddress(row.from_address) || row.contact_id || ''].join('|')
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, { row, count: 1 })
      continue
    }
    existing.count += 1
    if (new Date(row.created_at).getTime() > new Date(existing.row.created_at).getTime()) existing.row = row
  }
  return Array.from(groups.values())
    .sort((a, b) => new Date(b.row.created_at).getTime() - new Date(a.row.created_at).getTime())
    .slice(0, limit)
    .map(({ row, count }) => ({
      id: row.id,
      type: row.sentiment,
      title: `${row.sentiment === 'urgent' ? 'Urgent' : 'Negative'}: ${row.subject || 'No subject'}`,
      description: `From ${row.contact_name || row.from_address || 'unknown sender'}${count > 1 ? ` · ${count} emails` : ''}`,
      contactId: row.contact_id,
      timestamp: row.created_at,
      count,
    }))
}
