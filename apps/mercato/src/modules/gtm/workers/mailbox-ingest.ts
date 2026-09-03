import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { z } from 'zod'
import { EmailConnection } from '../../email/data/schema'
import type { ExecutionEm } from '../lib/execute/schedule'
import { createTokenPersister, resolveMailboxAccessToken } from '../lib/execute/transport'
import { createTenantCursorCodec } from '../lib/inbound/codec'
import { MailboxCursorError } from '../lib/inbound/cursor'
import { ingestMailbox } from '../lib/inbound/ingest'
import { createGmailMailboxReader } from '../lib/inbound/providers/gmail'
import { createImapMailboxReader, createProductionImapPageSource } from '../lib/inbound/providers/imap'
import { createOutlookMailboxReader } from '../lib/inbound/providers/outlook'
import {
  GTM_MAILBOX_INGEST_QUEUE,
  type GtmMailboxIngestJob,
} from '../lib/inbound/queue-contract'

export { GTM_MAILBOX_INGEST_QUEUE } from '../lib/inbound/queue-contract'

export const metadata: WorkerMeta = {
  queue: GTM_MAILBOX_INGEST_QUEUE,
  id: 'gtm:mailbox-ingest',
  concurrency: 5,
}

const payloadSchema: z.ZodType<GtmMailboxIngestJob> = z.object({
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
  mailboxConnectionId: z.string().uuid(),
  requestedByUserId: z.string().uuid(),
})

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

// A second job for the same mailbox (concurrency > 1, or a hub double
// enqueue) finds the cursor leased. Waiting a few times and then skipping
// is correct: the running job ingests the same pages, and the next enqueue
// picks up whatever is left. Dying (no retry policy on the queue) is not.
export const CURSOR_BUSY_RETRY_DELAYS_MS = [2_000, 5_000, 10_000]

export async function withCursorBusyRetry<T>(
  run: () => Promise<T>,
  options: { delaysMs?: number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T | 'cursor_busy'> {
  const delays = options.delaysMs ?? CURSOR_BUSY_RETRY_DELAYS_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      const busy = error instanceof MailboxCursorError && error.code === 'cursor_busy'
      if (!busy || attempt >= delays.length) {
        if (busy) return 'cursor_busy'
        throw error
      }
      await sleep(delays[attempt])
    }
  }
}

export default async function handle(
  job: QueuedJob<GtmMailboxIngestJob>,
  ctx: HandlerContext,
): Promise<void> {
  if (process.env.GTM_MAILBOX_INGESTION_ENABLED !== 'true') return
  const payload = payloadSchema.parse(job.payload)
  const rootEm = ctx.resolve<EntityManager>('em')
  const em = rootEm.fork()
  const encryption = ctx.resolve<TenantDataEncryptionService>('tenantEncryptionService')
  if (!encryption?.isEnabled()) throw new Error('tenant encryption is required for mailbox cursors')
  const dek = await encryption.getDek(payload.tenantId)
  if (!dek) throw new Error('tenant encryption key is unavailable for mailbox cursor')
  const connection = await findOneWithDecryption(
    em,
    EmailConnection,
    {
      id: payload.mailboxConnectionId,
      organizationId: payload.organizationId,
      tenantId: payload.tenantId,
      isActive: true,
      deletedAt: null,
    },
    undefined,
    { tenantId: payload.tenantId, organizationId: payload.organizationId },
  )
  if (!connection) return

  const provider = connection.provider.trim().toLowerCase()
  // Refreshed OAuth tokens are persisted on the connection row (M4).
  const persistToken = createTokenPersister(em, EmailConnection)
  let reader
  let cursorKind: 'gmail_history_id' | 'graph_delta_link' | 'imap_uid'
  if (provider === 'gmail') {
    const token = await resolveMailboxAccessToken(connection, 'gmail', fetch, new Date(), persistToken)
    reader = createGmailMailboxReader({ accessToken: token.accessToken })
    cursorKind = 'gmail_history_id'
  } else if (provider === 'microsoft' || provider === 'outlook') {
    const token = await resolveMailboxAccessToken(connection, 'microsoft', fetch, new Date(), persistToken)
    reader = createOutlookMailboxReader({ accessToken: token.accessToken })
    cursorKind = 'graph_delta_link'
  } else if (provider === 'imap' || provider === 'smtp') {
    reader = createImapMailboxReader(createProductionImapPageSource(connection))
    cursorKind = 'imap_uid'
  } else {
    throw new Error(`unsupported mailbox ingestion provider: ${provider || 'empty'}`)
  }

  await withCursorBusyRetry(() => ingestMailbox(
    em as unknown as ExecutionEm,
    {
      organizationId: payload.organizationId,
      tenantId: payload.tenantId,
      userId: payload.requestedByUserId,
      requestId: `queue:${ctx.jobId}`,
    },
    {
      mailboxConnectionId: payload.mailboxConnectionId,
      provider: provider === 'gmail' ? 'gmail' : provider === 'microsoft' || provider === 'outlook' ? 'microsoft' : 'imap',
      cursorKind,
      reader,
      codec: createTenantCursorCodec(dek.key),
    },
  ))
}
