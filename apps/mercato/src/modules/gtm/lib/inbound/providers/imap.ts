import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { z } from 'zod'
import type { EmailConnection } from '../../../../email/data/schema'
import {
  boundedText,
  cleanMessageId,
  headerAddress,
  MailboxProviderCursorExpiredError,
  parseDeliveryStatus,
  STORED_HEADER_NAMES,
  type MailboxProviderReader,
  type NormalizedMailboxMessage,
} from './types'

const cursorSchema = z.object({
  folder: z.literal('INBOX'),
  uidValidity: z.string().min(1).max(200),
  lastUid: z.number().int().min(0),
})

type ImapSourcePage = {
  uidValidity: string
  messages: Array<NormalizedMailboxMessage & { uid: number }>
  baselineUid?: number
}

const MAX_IMAP_SOURCE_BYTES = 512 * 1024

export type ImapPageSource = (input: {
  afterUid: number | null
  limit: number
}) => Promise<ImapSourcePage>

function encodeCursor(value: z.infer<typeof cursorSchema>): string {
  return JSON.stringify(value)
}

export function createImapMailboxReader(source: ImapPageSource): MailboxProviderReader {
  return {
    async readPage(cursor) {
      const parsed = cursor ? cursorSchema.parse(JSON.parse(cursor) as unknown) : null
      const page = await source({ afterUid: parsed?.lastUid ?? null, limit: 100 })
      if (parsed && parsed.uidValidity !== page.uidValidity) {
        throw new MailboxProviderCursorExpiredError('imap_uidvalidity_changed')
      }
      const sorted = [...page.messages].sort((a, b) => a.uid - b.uid)
      const lastUid = sorted.at(-1)?.uid ?? page.baselineUid ?? parsed?.lastUid ?? 0
      return {
        messages: sorted.map(({ uid: _uid, ...message }) => message),
        nextCursor: encodeCursor({ folder: 'INBOX', uidValidity: page.uidValidity, lastUid }),
        hasMore: sorted.length === 100,
      }
    },
  }
}

function textHeader(value: unknown): string | null {
  if (value == null) return null
  if (Array.isArray(value)) return value.map(String).join(', ').slice(0, 4096)
  if (typeof value === 'string') return value.slice(0, 4096)
  return String(value).slice(0, 4096)
}

export function imapIncrementalSearch(
  afterUid: number,
  inReplyTo?: string | null,
): { uid: string; header?: Record<string, string> } {
  return {
    uid: `${afterUid + 1}:*`,
    ...(inReplyTo ? { header: { 'In-Reply-To': inReplyTo } } : {}),
  }
}

/**
 * RFC 3501 quirk: a `N:*` UID range ALWAYS includes the highest existing
 * UID even when it is below N, so every poll would re-fetch the last message
 * (and, once it is expunged, resurrect an older pre-baseline one). Drop
 * everything at or below the cursor before selecting a page (M6).
 */
export function selectIncrementalUids(uids: Iterable<number>, afterUid: number, limit: number): number[] {
  return [...uids]
    .filter((uid) => Number.isSafeInteger(uid) && uid > afterUid)
    .sort((a, b) => a - b)
    .slice(0, Math.max(0, limit))
}

export function createProductionImapPageSource(
  connection: EmailConnection,
  options: { inReplyTo?: string | null } = {},
): ImapPageSource {
  return async ({ afterUid, limit }) => {
    const host = connection.imapHost
    const user = connection.smtpUser || connection.emailAddress
    const pass = connection.smtpPass
    if (!host || !user || !pass) throw new Error('imap mailbox requires reconnection')
    const client = new ImapFlow({
      host,
      port: connection.imapPort ?? 993,
      secure: connection.imapSecure ?? true,
      auth: { user, pass },
      logger: false,
      tls: { rejectUnauthorized: true },
    })
    await client.connect()
    try {
      const mailbox = await client.mailboxOpen('INBOX')
      const uidValidity = String(mailbox.uidValidity)
      if (afterUid == null) {
        // Align IMAP with the Gmail history contract: connecting a mailbox is
        // a metadata-only baseline, never an implicit import of personal mail.
        // UIDNEXT is the next UID the server will assign, so one less is the
        // highest UID allocated at the baseline boundary.
        const uidNext = Number(mailbox.uidNext)
        const baselineUid = Number.isSafeInteger(uidNext) && uidNext > 0 ? uidNext - 1 : 0
        return { uidValidity, baselineUid, messages: [] }
      }
      const searchResult = await client.search(
        imapIncrementalSearch(afterUid, options.inReplyTo),
        { uid: true },
      )
      const selected = selectIncrementalUids(searchResult === false ? [] : searchResult, afterUid, limit)
      const messages: ImapSourcePage['messages'] = []
      if (selected.length === 0) return { uidValidity, messages }
      for await (const raw of client.fetch(
        selected,
        { envelope: true, internalDate: true, source: { start: 0, maxLength: MAX_IMAP_SOURCE_BYTES } },
        { uid: true },
      )) {
        if (!raw.source) continue
        if (raw.uid <= afterUid) continue
        const parsed = await simpleParser(raw.source)
        // mailparser already picks the first mailbox; the single-address
        // guard rejects a From that still is not one plain addr-spec.
        const fromValues = parsed.from?.value ?? []
        const from = fromValues.length === 1 ? headerAddress(fromValues[0]?.address ?? '') : ''
        const to = parsed.to
          ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to])
              .flatMap((address) => address.value)
              .map((address) => address.address ?? '')
              .filter(Boolean)
              .join(', ')
          : ''
        const cc = parsed.cc
          ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc])
              .flatMap((address) => address.value)
              .map((address) => address.address ?? '')
              .filter(Boolean)
              .join(', ')
          : ''
        const headers: Record<string, string> = {}
        for (const name of STORED_HEADER_NAMES) {
          const value = textHeader(parsed.headers.get(name))
          if (value) headers[name] = value
        }
        // RFC 3464 delivery-status part: mailparser exposes it as an
        // attachment with its own content type (H2).
        const dsnPart = (parsed.attachments ?? []).find(
          (attachment) => attachment.contentType?.toLowerCase() === 'message/delivery-status',
        )
        const dsn = dsnPart?.content ? parseDeliveryStatus(dsnPart.content.toString('utf8')) : null
        const providerMessageId = cleanMessageId(parsed.messageId) ?? `uid:${raw.uid}`
        messages.push({
          uid: raw.uid,
          provider: 'imap',
          providerMessageId,
          providerEventId: `${uidValidity}:${raw.uid}`,
          threadId: cleanMessageId(parsed.inReplyTo) ?? cleanMessageId(parsed.messageId),
          rfcMessageId: cleanMessageId(parsed.messageId),
          fromAddress: from.slice(0, 320),
          toAddress: boundedText(to, 2000),
          cc: boundedText(cc, 2000) || null,
          subject: boundedText(parsed.subject || '(no subject)', 998),
          bodyHtml: boundedText(typeof parsed.html === 'string' ? parsed.html : ''),
          bodyText: boundedText(parsed.text) || null,
          // Server receive time, never the sender-controlled Date header
          // (which could park the message outside every scan window).
          receivedAt: raw.internalDate instanceof Date ? raw.internalDate : new Date(),
          headers,
          dsn,
        })
      }
      return { uidValidity, messages }
    } finally {
      await client.logout().catch(() => {})
    }
  }
}
