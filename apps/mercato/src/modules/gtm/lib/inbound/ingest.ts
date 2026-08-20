import crypto from 'node:crypto'
import { EmailMessage } from '../../../email/data/schema'
import type { GtmCtx } from '../campaign/build'
import type { Clock, ExecutionEm } from '../execute/schedule'
import { correlateReplies, type CorrelateResult } from '../replies/correlate'
import {
  acquireMailboxCursor,
  commitMailboxPage,
  failMailboxCursor,
  readMailboxCursor,
  requireMailboxResync,
  type CursorCodec,
  type CursorContext,
} from './cursor'
import {
  MailboxProviderCursorExpiredError,
  type MailboxProviderReader,
  type NormalizedMailboxMessage,
} from './providers/types'

function deterministicUuid(value: string): string {
  const hex = crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4]
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}

function emailMessageId(
  ctx: Pick<GtmCtx, 'organizationId' | 'tenantId'>,
  mailboxConnectionId: string,
  message: NormalizedMailboxMessage,
): string {
  return deterministicUuid(JSON.stringify({
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    mailboxConnectionId,
    provider: message.provider,
    providerEventId: message.providerEventId,
  }))
}

async function persistNormalizedMessages(
  em: ExecutionEm,
  ctx: Pick<GtmCtx, 'organizationId' | 'tenantId'>,
  mailboxConnectionId: string,
  messages: NormalizedMailboxMessage[],
): Promise<number> {
  let inserted = 0
  for (const message of messages) {
    const id = emailMessageId(ctx, mailboxConnectionId, message)
    const existing = await em.findOne(EmailMessage, {
      id,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      accountId: mailboxConnectionId,
      deletedAt: null,
    })
    if (existing) continue
    em.persist(em.create(EmailMessage, {
      id,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      accountId: mailboxConnectionId,
      direction: 'inbound',
      fromAddress: message.fromAddress,
      toAddress: message.toAddress,
      cc: message.cc,
      bcc: null,
      subject: message.subject,
      bodyHtml: message.bodyHtml,
      bodyText: message.bodyText,
      threadId: message.threadId,
      contactId: null,
      dealId: null,
      campaignId: null,
      status: 'delivered',
      metadata: {
        source: 'gtm_mailbox_cursor',
        provider: message.provider,
        provider_message_id: message.providerMessageId,
        provider_event_id: message.providerEventId,
        event_id: message.providerEventId,
        rfc_message_id: message.rfcMessageId,
        headers: message.headers,
      },
      createdAt: message.receivedAt,
      updatedAt: message.receivedAt,
      sentAt: message.receivedAt,
    }))
    inserted += 1
  }
  return inserted
}

export type MailboxIngestResult = {
  pages: number
  messages: number
  correlation: CorrelateResult
  resyncRequired: boolean
}

const EMPTY_CORRELATION: CorrelateResult = {
  scanned: 0,
  matched: [],
  systemEvents: 0,
  unmatched: 0,
  failed: 0,
}

function mergeCorrelation(left: CorrelateResult, right: CorrelateResult): CorrelateResult {
  return {
    scanned: left.scanned + right.scanned,
    matched: [...left.matched, ...right.matched],
    systemEvents: left.systemEvents + right.systemEvents,
    unmatched: left.unmatched + right.unmatched,
    failed: left.failed + right.failed,
  }
}

export async function ingestMailbox(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: {
    mailboxConnectionId: string
    provider: 'gmail' | 'microsoft' | 'imap'
    cursorKind: 'gmail_history_id' | 'graph_delta_link' | 'imap_uid'
    reader: MailboxProviderReader
    codec: CursorCodec
    maxPages?: number
  },
  deps: { clock?: Clock } = {},
): Promise<MailboxIngestResult> {
  const context: CursorContext = {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    mailboxConnectionId: input.mailboxConnectionId,
    provider: input.provider,
    cursorKind: input.cursorKind,
  }
  const maxPages = Math.max(1, Math.min(input.maxPages ?? 10, 20))
  let pages = 0
  let messages = 0
  let correlation = EMPTY_CORRELATION
  for (; pages < maxPages; pages += 1) {
    const lease = await acquireMailboxCursor(em, context, { clock: deps.clock })
    const readable = await readMailboxCursor(em, context, input.codec)
    const expectedCursorHash = readable.cursor.cursorHash ?? null
    try {
      const page = await input.reader.readPage(readable.cursorValue)
      let inserted = 0
      let pageCorrelation = EMPTY_CORRELATION
      await commitMailboxPage(
        em,
        context,
        {
          cursorId: lease.cursor.id,
          leaseToken: lease.leaseToken,
          fence: lease.fence,
          expectedCursorHash,
        },
        {
          persist: async (tem) => {
            inserted = await persistNormalizedMessages(
              tem as ExecutionEm,
              ctx,
              input.mailboxConnectionId,
              page.messages,
            )
            // The cursor may advance only with the durable GTM disposition.
            // Running correlation inside this transaction also recovers a
            // replay where the message row already exists but its prior
            // processing attempt never committed.
            if (page.messages.length > 0) {
              await tem.flush()
              pageCorrelation = await correlateReplies(
                tem as ExecutionEm,
                ctx,
                { sinceMinutes: 60 * 24 * 30, clock: deps.clock },
              )
              if (pageCorrelation.failed > 0) {
                throw new Error('mailbox_page_disposition_failed')
              }
            }
          },
          cursorValue: page.nextCursor,
          lastOccurredAt: page.messages.reduce<Date | null>(
            (latest, message) => !latest || message.receivedAt > latest ? message.receivedAt : latest,
            readable.cursor.lastOccurredAt ?? null,
          ),
          lastMessageId: page.messages.at(-1)
            ? emailMessageId(ctx, input.mailboxConnectionId, page.messages.at(-1) as NormalizedMailboxMessage)
            : readable.cursor.lastMessageId ?? null,
        },
        { codec: input.codec, clock: deps.clock },
      )
      messages += inserted
      correlation = mergeCorrelation(correlation, pageCorrelation)
      if (!page.hasMore) {
        return { pages: pages + 1, messages, correlation, resyncRequired: false }
      }
    } catch (error) {
      if (error instanceof MailboxProviderCursorExpiredError) {
        await requireMailboxResync(em, ctx, {
          cursorId: lease.cursor.id,
          leaseToken: lease.leaseToken,
          fence: lease.fence,
        }, error.reason, { clock: deps.clock })
        return { pages: pages + 1, messages, correlation: EMPTY_CORRELATION, resyncRequired: true }
      }
      await failMailboxCursor(em, ctx, {
        cursorId: lease.cursor.id,
        leaseToken: lease.leaseToken,
        fence: lease.fence,
      }, 'mailbox_ingest_failed', { clock: deps.clock })
      throw error
    }
  }
  return { pages, messages, correlation, resyncRequired: false }
}
