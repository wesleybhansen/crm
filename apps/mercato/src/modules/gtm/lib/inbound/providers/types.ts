export type NormalizedMailboxMessage = {
  provider: 'gmail' | 'microsoft' | 'imap'
  providerMessageId: string
  providerEventId: string
  threadId: string | null
  rfcMessageId: string | null
  // Exactly one RFC 5322 addr-spec, or '' when the From header carried
  // anything else (a list, garbage): never a comma-joined set.
  fromAddress: string
  toAddress: string
  cc: string | null
  subject: string
  bodyHtml: string
  bodyText: string | null
  // Provider receive time (Gmail internalDate, Graph receivedDateTime, IMAP
  // INTERNALDATE), never the sender-controlled Date header.
  receivedAt: Date
  headers: Record<string, string>
  // Parsed multipart/report delivery-status fields when the message is a DSN.
  dsn?: DeliveryStatusInfo | null
}

export type DeliveryStatusInfo = {
  action: string | null
  status: string | null
}

/*
 * Only these headers are persisted (M9). Everything correlation, disposition
 * and authentication need is here; arbitrary sender-supplied headers (which
 * can number in the thousands per message) are dropped, and the map is
 * capped at MAX_STORED_HEADERS entries.
 */
export const STORED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'from',
  'to',
  'cc',
  'reply-to',
  'return-path',
  'subject',
  'date',
  'message-id',
  'in-reply-to',
  'references',
  'thread-index',
  'auto-submitted',
  'x-autoreply',
  'x-autorespond',
  'x-auto-response-suppress',
  'precedence',
  'feedback-type',
  'x-complaint-type',
  'authentication-results',
  'arc-authentication-results',
  'received-spf',
  'list-unsubscribe',
  'list-id',
  'content-type',
  'x-failed-recipients',
  'x-original-to',
  'delivered-to',
])
export const MAX_STORED_HEADERS = 64

/**
 * Parse the machine-readable part of a multipart/report; report-type=
 * delivery-status message (RFC 3464): the per-recipient Action and Status
 * fields. Returns null when neither is present.
 */
export function parseDeliveryStatus(text: string | null | undefined): DeliveryStatusInfo | null {
  if (!text) return null
  const source = text.slice(0, 20_000)
  const action = source.match(/^\s*Action:\s*([a-z-]+)/im)?.[1]?.toLowerCase() ?? null
  const status = source.match(/^\s*Status:\s*(\d\.\d{1,3}\.\d{1,3})/im)?.[1] ?? null
  if (!action && !status) return null
  return { action, status }
}

export type MailboxProviderPage = {
  messages: NormalizedMailboxMessage[]
  nextCursor: string
  hasMore: boolean
}

export class MailboxProviderCursorExpiredError extends Error {
  constructor(readonly reason: 'gmail_history_expired' | 'graph_delta_expired' | 'imap_uidvalidity_changed') {
    super(reason)
    this.name = 'MailboxProviderCursorExpiredError'
  }
}

export interface MailboxProviderReader {
  readPage(cursor: string | null): Promise<MailboxProviderPage>
}

export function normalizeHeaderMap(
  values: Array<{ name?: string | null; value?: string | null }>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of values) {
    const name = item.name?.trim().toLowerCase()
    const value = item.value?.trim()
    if (!name || !value || name.length > 200 || value.length > 4096) continue
    if (!STORED_HEADER_NAMES.has(name)) continue
    if (Object.keys(out).length >= MAX_STORED_HEADERS && !(name in out)) continue
    // Authentication-Results may legitimately repeat (one per hop); keep the
    // first, which is the receiving provider's own verdict.
    if (name in out && (name === 'authentication-results' || name === 'arc-authentication-results')) continue
    out[name] = value
  }
  return out
}

// One addr-spec: no whitespace, no separators, exactly one '@'.
const ADDR_SPEC = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/

/**
 * The single mailbox named by a From header, or '' when the header names
 * more than one (or none). A bracketed list such as `<a@x.com, b@y.com>`
 * is rejected rather than stored, so a reply can never be addressed to an
 * extra recipient the sender smuggled in (api-send-privacy M5).
 */
export function headerAddress(value: string | null | undefined): string {
  if (!value) return ''
  const groups = [...value.matchAll(/<([^>]*)>/g)].map((match) => match[1].trim())
  let candidate: string
  if (groups.length > 1) return ''
  if (groups.length === 1) {
    candidate = groups[0]
  } else {
    if (value.includes(',') || value.includes(';')) return ''
    candidate = value.trim()
  }
  candidate = candidate.toLowerCase().slice(0, 320)
  return ADDR_SPEC.test(candidate) ? candidate : ''
}

export function cleanMessageId(value: string | null | undefined): string | null {
  const clean = value?.replace(/[<>]/g, '').trim()
  return clean ? clean.slice(0, 998) : null
}

export function boundedText(value: string | null | undefined, max = 200_000): string {
  return (value ?? '').replace(/\0/g, '').slice(0, max)
}
