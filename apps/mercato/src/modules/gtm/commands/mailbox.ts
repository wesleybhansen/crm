import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createQueue } from '@open-mercato/queue'
import { getRedisUrl } from '@open-mercato/shared/lib/redis/connection'
import type { GtmCtx } from '../lib/campaign/build'
import type { ExecutionEm } from '../lib/execute/schedule'
import {
  clearMailboxPause,
  type ClearMailboxPauseResult,
  type MailboxPauseClearReason,
} from '../lib/reputation/mailbox-control'
import {
  enqueueMailboxIngestion,
  type MailboxIngestionEnqueueResult,
} from '../lib/inbound/enqueue'
import {
  GTM_MAILBOX_INGEST_QUEUE,
  resolveGtmMailboxQueueStrategy,
  type GtmMailboxIngestJob,
} from '../lib/inbound/queue-contract'

export type ClearMailboxPauseCommandInput = {
  mailboxConnectionId: string
  expectedFence: number
  reason: MailboxPauseClearReason
}

export type EnqueueMailboxIngestionCommandInput = {
  mailboxConnectionId: string
}

function resolveGtmContext(ctx: CommandRuntimeContext): GtmCtx {
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  const tenantId = ctx.auth?.tenantId ?? null
  const userId = ctx.auth?.userId ?? ctx.auth?.sub ?? null
  if (!organizationId || !tenantId || !userId) {
    throw new Error('GTM mailbox command requires an exact user, organization, and tenant scope')
  }
  return {
    organizationId,
    tenantId,
    userId,
    requestId: ctx.request?.headers.get('x-request-id') ?? null,
  }
}

const clearPauseCommand: CommandHandler<ClearMailboxPauseCommandInput, ClearMailboxPauseResult> = {
  id: 'gtm.mailboxes.clear-pause',
  async execute(input, runtime) {
    const em = runtime.container.resolve('em') as EntityManager as unknown as ExecutionEm
    return clearMailboxPause(em, resolveGtmContext(runtime), input)
  },
  buildLog: ({ input, result }) => ({
    actionLabel: 'Clear GTM mailbox safety pause',
    resourceKind: 'gtm.mailbox_health',
    resourceId: result.health.id,
    organizationId: result.health.organizationId,
    tenantId: result.health.tenantId,
    snapshotAfter: {
      mailbox_connection_id: result.health.mailboxConnectionId,
      status: result.health.status,
      fence: result.health.fence,
      operator_reason: input.reason,
    },
  }),
}

const enqueueCommand: CommandHandler<
  EnqueueMailboxIngestionCommandInput,
  MailboxIngestionEnqueueResult
> = {
  id: 'gtm.mailboxes.enqueue-ingestion',
  async execute(input, runtime) {
    const em = runtime.container.resolve('em') as EntityManager as unknown as ExecutionEm
    return enqueueMailboxIngestion(em, resolveGtmContext(runtime), input, {
      ingestionEnabled: process.env.GTM_MAILBOX_INGESTION_ENABLED === 'true',
      queueStrategy: resolveGtmMailboxQueueStrategy(),
      createQueue: () => createQueue<GtmMailboxIngestJob>(GTM_MAILBOX_INGEST_QUEUE, 'async', {
        connection: { url: getRedisUrl('QUEUE') },
      }),
    })
  },
  buildLog: ({ result }) => ({
    actionLabel: 'Enqueue GTM mailbox ingestion',
    resourceKind: 'email.mailbox_connection',
    resourceId: result.mailboxConnectionId,
    organizationId: result.organizationId,
    tenantId: result.tenantId,
    snapshotAfter: {
      queue_job_id: result.jobId,
      provider: result.provider,
    },
  }),
}

registerCommand(clearPauseCommand)
registerCommand(enqueueCommand)
