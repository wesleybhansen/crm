import { z } from 'zod'
import type { FetchLike } from '../../execute/transport'
import {
  boundedText,
  cleanMessageId,
  headerAddress,
  MailboxProviderCursorExpiredError,
  normalizeHeaderMap,
  parseDeliveryStatus,
  type DeliveryStatusInfo,
  type MailboxProviderReader,
  type NormalizedMailboxMessage,
} from './types'

const gmailCursorSchema = z.object({
  startHistoryId: z.string().min(1).max(200),
  pageToken: z.string().min(1).max(2000).optional(),
})

const historySchema = z.object({
  history: z.array(z.object({
    id: z.string().optional(),
    messagesAdded: z.array(z.object({
      message: z.object({ id: z.string(), threadId: z.string().optional() }),
    })).optional(),
  })).optional(),
  nextPageToken: z.string().optional(),
  historyId: z.string(),
})

const profileSchema = z.object({ historyId: z.string() })
const messagePartSchema: z.ZodType<{
  mimeType?: string
  body?: { data?: string }
  parts?: Array<unknown>
}> = z.lazy(() => z.object({
  mimeType: z.string().optional(),
  body: z.object({ data: z.string().optional() }).optional(),
  parts: z.array(messagePartSchema).optional(),
}))
const messageSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  internalDate: z.string().optional(),
  payload: messagePartSchema.and(z.object({
    headers: z.array(z.object({ name: z.string().optional(), value: z.string().optional() })).optional(),
  })).optional(),
})

function decodeBase64Url(value: string): string {
  try {
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  } catch {
    return ''
  }
}

function readBodies(part: z.infer<typeof messagePartSchema> | undefined): {
  html: string
  text: string
  dsn: DeliveryStatusInfo | null
} {
  let html = ''
  let text = ''
  let dsn: DeliveryStatusInfo | null = null
  const visit = (node: z.infer<typeof messagePartSchema> | undefined): void => {
    if (!node) return
    const mime = node.mimeType?.toLowerCase()
    if (!html && mime === 'text/html' && node.body?.data) html = decodeBase64Url(node.body.data)
    if (!text && mime === 'text/plain' && node.body?.data) text = decodeBase64Url(node.body.data)
    // RFC 3464 machine-readable bounce part (H2).
    if (!dsn && mime === 'message/delivery-status' && node.body?.data) {
      dsn = parseDeliveryStatus(decodeBase64Url(node.body.data))
    }
    for (const child of node.parts ?? []) visit(messagePartSchema.safeParse(child).data)
  }
  visit(part)
  return { html: boundedText(html), text: boundedText(text), dsn }
}

function encodeCursor(value: z.infer<typeof gmailCursorSchema>): string {
  return JSON.stringify(value)
}

export function createGmailMailboxReader(input: {
  accessToken: string
  fetch?: FetchLike
}): MailboxProviderReader {
  const fetchImpl = input.fetch ?? fetch
  const getJson = async (url: string): Promise<{ response: Response; body: unknown }> => {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
      signal: AbortSignal.timeout(60_000),
    })
    return { response, body: await response.json().catch(() => null) }
  }
  return {
    async readPage(cursor) {
      if (!cursor) {
        const profile = await getJson('https://gmail.googleapis.com/gmail/v1/users/me/profile')
        if (!profile.response.ok) throw new Error(`gmail profile failed (${profile.response.status})`)
        const parsed = profileSchema.parse(profile.body)
        return {
          messages: [],
          nextCursor: encodeCursor({ startHistoryId: parsed.historyId }),
          hasMore: false,
        }
      }
      const parsedCursor = gmailCursorSchema.parse(JSON.parse(cursor) as unknown)
      const params = new URLSearchParams({
        startHistoryId: parsedCursor.startHistoryId,
        historyTypes: 'messageAdded',
        maxResults: '100',
      })
      if (parsedCursor.pageToken) params.set('pageToken', parsedCursor.pageToken)
      const history = await getJson(
        `https://gmail.googleapis.com/gmail/v1/users/me/history?${params.toString()}`,
      )
      if (history.response.status === 404) {
        throw new MailboxProviderCursorExpiredError('gmail_history_expired')
      }
      if (!history.response.ok) throw new Error(`gmail history failed (${history.response.status})`)
      const page = historySchema.parse(history.body)
      const ids = [...new Set(
        (page.history ?? []).flatMap((entry) =>
          (entry.messagesAdded ?? []).map((added) => added.message.id),
        ),
      )]
      const messages: NormalizedMailboxMessage[] = []
      for (const id of ids) {
        const result = await getJson(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
        )
        if (!result.response.ok) throw new Error(`gmail message failed (${result.response.status})`)
        const message = messageSchema.parse(result.body)
        const headers = normalizeHeaderMap(message.payload?.headers ?? [])
        const bodies = readBodies(message.payload)
        messages.push({
          provider: 'gmail',
          providerMessageId: message.id,
          providerEventId: `messageAdded:${message.id}`,
          threadId: message.threadId ?? null,
          rfcMessageId: cleanMessageId(headers['message-id']),
          fromAddress: headerAddress(headers.from),
          toAddress: boundedText(headers.to, 2000),
          cc: boundedText(headers.cc, 2000) || null,
          subject: boundedText(headers.subject || '(no subject)', 998),
          bodyHtml: bodies.html,
          bodyText: bodies.text || null,
          receivedAt: message.internalDate && /^\d+$/.test(message.internalDate)
            ? new Date(Number(message.internalDate))
            : new Date(),
          headers,
          dsn: bodies.dsn,
        })
      }
      const nextCursor = page.nextPageToken
        ? encodeCursor({
            startHistoryId: parsedCursor.startHistoryId,
            pageToken: page.nextPageToken,
          })
        : encodeCursor({ startHistoryId: page.historyId })
      return { messages, nextCursor, hasMore: Boolean(page.nextPageToken) }
    },
  }
}
