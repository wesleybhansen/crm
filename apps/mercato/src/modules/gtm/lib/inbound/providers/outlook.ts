import { z } from 'zod'
import type { FetchLike } from '../../execute/transport'
import {
  boundedText,
  cleanMessageId,
  MailboxProviderCursorExpiredError,
  normalizeHeaderMap,
  type MailboxProviderReader,
  type NormalizedMailboxMessage,
} from './types'

const graphMessageSchema = z.object({
  id: z.string(),
  internetMessageId: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  receivedDateTime: z.string().optional(),
  body: z.object({ contentType: z.string().optional(), content: z.string().optional() }).optional(),
  bodyPreview: z.string().optional(),
  from: z.object({ emailAddress: z.object({ address: z.string().optional() }) }).nullable().optional(),
  toRecipients: z.array(z.object({ emailAddress: z.object({ address: z.string().optional() }) })).optional(),
  ccRecipients: z.array(z.object({ emailAddress: z.object({ address: z.string().optional() }) })).optional(),
  internetMessageHeaders: z.array(z.object({ name: z.string().optional(), value: z.string().optional() })).optional(),
})
const graphPageSchema = z.object({
  value: z.array(graphMessageSchema),
  '@odata.nextLink': z.string().url().optional(),
  '@odata.deltaLink': z.string().url().optional(),
})

const INITIAL_DELTA_URL =
  'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta'
  + '?$select=id,internetMessageId,conversationId,subject,receivedDateTime,body,bodyPreview,from,toRecipients,ccRecipients,internetMessageHeaders'
  + '&$top=100'

function requireGraphCursorUrl(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'graph.microsoft.com'
    || url.pathname !== '/v1.0/me/mailFolders/inbox/messages/delta'
    || url.username
    || url.password
  ) {
    throw new Error('invalid graph delta cursor')
  }
  return url.toString()
}

export function createOutlookMailboxReader(input: {
  accessToken: string
  fetch?: FetchLike
}): MailboxProviderReader {
  const fetchImpl = input.fetch ?? fetch
  return {
    async readPage(cursor) {
      const url = cursor ? requireGraphCursorUrl(cursor) : INITIAL_DELTA_URL
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${input.accessToken}` },
        signal: AbortSignal.timeout(60_000),
      })
      if (response.status === 404 || response.status === 410) {
        throw new MailboxProviderCursorExpiredError('graph_delta_expired')
      }
      if (!response.ok) throw new Error(`graph delta failed (${response.status})`)
      const page = graphPageSchema.parse(await response.json().catch(() => null))
      const messages: NormalizedMailboxMessage[] = page.value.map((message) => {
        const headers = normalizeHeaderMap(message.internetMessageHeaders ?? [])
        const body = boundedText(message.body?.content)
        const isHtml = message.body?.contentType?.toLowerCase() === 'html'
        return {
          provider: 'microsoft',
          providerMessageId: message.id,
          providerEventId: `messageDelta:${message.id}`,
          threadId: message.conversationId ?? null,
          rfcMessageId: cleanMessageId(message.internetMessageId),
          fromAddress: (message.from?.emailAddress.address ?? '').trim().toLowerCase().slice(0, 320),
          toAddress: boundedText(
            (message.toRecipients ?? []).map((item) => item.emailAddress.address ?? '').filter(Boolean).join(', '),
            2000,
          ),
          cc: boundedText(
            (message.ccRecipients ?? []).map((item) => item.emailAddress.address ?? '').filter(Boolean).join(', '),
            2000,
          ) || null,
          subject: boundedText(message.subject || '(no subject)', 998),
          bodyHtml: isHtml ? body : '',
          bodyText: isHtml ? boundedText(message.bodyPreview) || null : body || null,
          receivedAt: message.receivedDateTime ? new Date(message.receivedDateTime) : new Date(),
          headers,
          // Graph's message resource carries no MIME parts; a DSN from
          // Exchange is recognised by subject/From in correlate.ts.
          dsn: null,
        }
      })
      const next = page['@odata.nextLink'] ?? page['@odata.deltaLink']
      if (!next) throw new Error('graph delta response omitted next/delta link')
      return {
        messages,
        nextCursor: requireGraphCursorUrl(next),
        hasMore: Boolean(page['@odata.nextLink']),
      }
    },
  }
}
