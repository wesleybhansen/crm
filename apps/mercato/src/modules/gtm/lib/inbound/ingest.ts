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
  type MailboxProviderPage,
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
        dsn: message.dsn ?? null,
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
  quarantined: 0,
}

function mergeCorrelation(left: CorrelateResult, right: CorrelateResult): CorrelateResult {
  return {
    scanned: left.scanned + right.scanned,
    matched: [...left.matched, ...right.matched],
    systemEvents: left.systemEvents + right.systemEvents,
    unmatched: left.unmatched + right.unmatched,
    failed: left.failed + right.failed,
    quarantined: left.quarantined + right.quarantined,
  }
}

// Recovery sweep bound: this mailbox only, this many days back, this many
// rows. Picks up messages whose page committed but whose disposition never
// ran (crash between the two) or failed and is still re-claimable.
export const INGEST_SWEEP_DAYS = 7
export const INGEST_SWEEP_LIMIT = 200

/*
 * Page commit vs. disposition (review H4). The page's rows and the cursor
 * advancement commit together in one real transaction (cursor.ts). The GTM
 * disposition of those rows (correlation, atomic stops, suppressions, health)
 * runs AFTER that commit, bounded to exactly the page's message ids, with
 * per-event failure state persisted on gtm_inbound_events. Previously the
 * disposition ran inside the page transaction over the whole org's 30-day
 * inbound history and any single failing message rolled the page back,
 * wedged the cursor in 'error', and re-poisoned every mailbox of the org on
 * every retry. Now a failing message marks only ITS event 'failed'
 * (re-claimable, quarantined after MAX_EVENT_ATTEMPTS) and the cursor keeps
 * moving. The trade: a crash between page commit and disposition leaves
 * rows without an event, which the bounded per-mailbox sweep at the end of
 * every job recovers.
 */

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
  const sweep = async (): Promise<void> => {
    const now = deps.clock?.now() ?? new Date()
    const recovered = await correlateReplies(em, ctx, {
      mailboxConnectionId: input.mailboxConnectionId,
      sinceMinutes: INGEST_SWEEP_DAYS * 24 * 60,
      limit: INGEST_SWEEP_LIMIT,
      clock: deps.clock ?? { now: () => now },
    })
    correlation = mergeCorrelation(correlation, recovered)
  }
  for (; pages < maxPages; pages += 1) {
    const lease = await acquireMailboxCursor(em, context, { clock: deps.clock })
    const readable = await readMailboxCursor(em, context, input.codec)
    const expectedCursorHash = readable.cursor.cursorHash ?? null
    let page: MailboxProviderPage
    try {
      page = await input.reader.readPage(readable.cursorValue)
      let inserted = 0
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
    } catch (error) {
      if (error instanceof MailboxProviderCursorExpiredError) {
        await requireMailboxResync(em, context, {
          cursorId: lease.cursor.id,
          leaseToken: lease.leaseToken,
          fence: lease.fence,
        }, error.reason, { clock: deps.clock })
        return { pages: pages + 1, messages, correlation, resyncRequired: true }
      }
      await failMailboxCursor(em, ctx, {
        cursorId: lease.cursor.id,
        leaseToken: lease.leaseToken,
        fence: lease.fence,
      }, 'mailbox_ingest_failed', { clock: deps.clock })
      throw error
    }
    // Disposition of exactly this page, outside the page transaction: a
    // failing message marks its own event and never blocks the cursor.
    if (page.messages.length > 0) {
      const pageCorrelation = await correlateReplies(em, ctx, {
        messageIds: page.messages.map((message) => emailMessageId(ctx, input.mailboxConnectionId, message)),
        clock: deps.clock,
      })
      correlation = mergeCorrelation(correlation, pageCorrelation)
    }
    if (!page.hasMore) {
      await sweep()
      return { pages: pages + 1, messages, correlation, resyncRequired: false }
    }
  }
  await sweep()
  return { pages, messages, correlation, resyncRequired: false }
}
