import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { z } from 'zod'
import type { EmailConnection } from '../../../../email/data/schema'
import {
  boundedText,
  cleanMessageId,
  MailboxProviderCursorExpiredError,
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
      const lastUid = sorted.at(-1)?.uid ?? parsed?.lastUid ?? 0
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

export function createProductionImapPageSource(connection: EmailConnection): ImapPageSource {
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
      const searchResult = await client.search(
        afterUid == null ? { all: true } : { uid: `${afterUid + 1}:*` },
        { uid: true },
      )
      let uids = [...(searchResult === false ? [] : searchResult)].sort((a, b) => a - b)
      const selected = afterUid == null ? uids.slice(-limit) : uids.slice(0, limit)
      const messages: ImapSourcePage['messages'] = []
      if (selected.length === 0) return { uidValidity, messages }
      for await (const raw of client.fetch(
        selected,
        { envelope: true, source: { start: 0, maxLength: MAX_IMAP_SOURCE_BYTES } },
        { uid: true },
      )) {
        if (!raw.source) continue
        const parsed = await simpleParser(raw.source)
        const from = parsed.from?.value?.[0]?.address?.trim().toLowerCase() ?? ''
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
        for (const name of [
          'auto-submitted',
          'feedback-type',
          'in-reply-to',
          'references',
          'x-autoreply',
          'x-autorespond',
          'x-complaint-type',
        ]) {
          const value = textHeader(parsed.headers.get(name))
          if (value) headers[name] = value
        }
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
          receivedAt: parsed.date ?? new Date(),
          headers,
        })
      }
      return { uidValidity, messages }
    } finally {
      await client.logout().catch(() => {})
    }
  }
}
