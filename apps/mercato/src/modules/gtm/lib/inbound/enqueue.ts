import type { Queue } from '@open-mercato/queue'
import { EmailConnection } from '../../../email/data/schema'
import type { GtmCtx } from '../campaign/build'
import type { ExecutionEm } from '../execute/schedule'
import { GtmMailboxControlError } from '../reputation/mailbox-control'
import type { GtmMailboxIngestJob } from './queue-contract'

export type MailboxIngestionQueue = Pick<Queue<GtmMailboxIngestJob>, 'enqueue' | 'close'>

export type MailboxIngestionEnqueueResult = {
  jobId: string
  mailboxConnectionId: string
  provider: 'gmail' | 'microsoft' | 'imap'
  organizationId: string
  tenantId: string
}

function normalizeProvider(value: string): 'gmail' | 'microsoft' | 'imap' | null {
  const provider = value.trim().toLowerCase()
  if (provider === 'gmail') return 'gmail'
  if (provider === 'microsoft' || provider === 'outlook') return 'microsoft'
  if (provider === 'imap' || provider === 'smtp') return 'imap'
  return null
}

export async function enqueueMailboxIngestion(
  em: ExecutionEm,
  ctx: Pick<GtmCtx, 'organizationId' | 'tenantId' | 'userId'>,
  input: { mailboxConnectionId: string },
  deps: {
    ingestionEnabled: boolean
    queueStrategy: string
    createQueue: () => MailboxIngestionQueue
  },
): Promise<MailboxIngestionEnqueueResult> {
  if (!deps.ingestionEnabled) {
    throw new GtmMailboxControlError('ingestion_disabled', 'Mailbox ingestion is disabled')
  }
  if (deps.queueStrategy !== 'async') {
    throw new GtmMailboxControlError('async_queue_required', 'Async queue strategy is required')
  }
  const mailbox = await em.findOne(EmailConnection, {
    id: input.mailboxConnectionId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    isActive: true,
    deletedAt: null,
  })
  if (!mailbox) {
    throw new GtmMailboxControlError('mailbox_not_found', 'Mailbox not found')
  }
  const provider = normalizeProvider(mailbox.provider)
  if (!provider) {
    throw new GtmMailboxControlError(
      'mailbox_not_supported',
      'Mailbox provider does not support GTM ingestion',
    )
  }
  let queue: MailboxIngestionQueue
  try {
    queue = deps.createQueue()
  } catch {
    throw new GtmMailboxControlError(
      'queue_unavailable',
      'Mailbox ingestion queue unavailable',
    )
  }
  let jobId: string
  try {
    jobId = await queue.enqueue({
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      mailboxConnectionId: mailbox.id,
      requestedByUserId: ctx.userId,
    })
  } catch {
    await queue.close().catch(() => {})
    throw new GtmMailboxControlError(
      'queue_unavailable',
      'Mailbox ingestion queue unavailable',
    )
  }
  // Once enqueue returns, the queue has acknowledged the job. A close error
  // cannot make that outcome unknown and must not invite a duplicate retry.
  await queue.close().catch(() => {})
  return {
    jobId,
    mailboxConnectionId: mailbox.id,
    provider,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
  }
}
