import { LockMode } from '@mikro-orm/core'
import { EmailConnection } from '../../../email/data/schema'
import { GtmMailboxHealth } from '../../data/entities'
import type { GtmCtx } from '../campaign/build'
import type { Clock, ExecutionEm } from '../execute/schedule'

export type MailboxPauseClearReason =
  | 'false_positive'
  | 'sender_remediated'
  | 'provider_feedback_resolved'
  | 'manual_investigation_complete'

export class GtmMailboxControlError extends Error {
  constructor(
    public code:
      | 'mailbox_not_found'
      | 'mailbox_not_supported'
      | 'pause_not_found'
      | 'mailbox_not_paused'
      | 'stale_fence'
      | 'ingestion_disabled'
      | 'async_queue_required'
      | 'queue_unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'GtmMailboxControlError'
  }
}

export type ClearMailboxPauseResult = {
  health: GtmMailboxHealth
  reason: MailboxPauseClearReason
}

export async function clearMailboxPause(
  em: ExecutionEm,
  ctx: Pick<GtmCtx, 'organizationId' | 'tenantId'>,
  input: {
    mailboxConnectionId: string
    expectedFence: number
    reason: MailboxPauseClearReason
  },
  deps: { clock?: Clock } = {},
): Promise<ClearMailboxPauseResult> {
  const now = deps.clock?.now() ?? new Date()
  return em.transactional(async (tem) => {
    const mailbox = await tem.findOne(
      EmailConnection,
      {
        id: input.mailboxConnectionId,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        isActive: true,
        deletedAt: null,
      },
      { lockMode: LockMode.PESSIMISTIC_READ },
    )
    if (!mailbox) {
      throw new GtmMailboxControlError('mailbox_not_found', 'Mailbox not found')
    }
    const health = await tem.findOne(
      GtmMailboxHealth,
      {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        mailboxConnectionId: input.mailboxConnectionId,
        deletedAt: null,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (!health) {
      throw new GtmMailboxControlError('pause_not_found', 'Mailbox pause not found')
    }
    if (health.fence !== input.expectedFence) {
      throw new GtmMailboxControlError('stale_fence', 'Mailbox pause changed; refresh before clearing')
    }
    if (health.status !== 'paused') {
      throw new GtmMailboxControlError('mailbox_not_paused', 'Mailbox is not paused')
    }
    health.status = 'warning'
    health.pauseReason = null
    health.pauseUntil = null
    // A false positive means the evidence rows were wrong: exclude every
    // event at or before this instant from the next refresh (M2), otherwise
    // the same rows re-latch the pause immediately. Other clear reasons keep
    // the evidence in the window on purpose (the sender fixed something; a
    // fresh complaint should still pause).
    if (input.reason === 'false_positive') health.rollingWindowStartedAt = now
    health.fence += 1
    health.updatedAt = now
    tem.persist(health)
    await tem.flush()
    return { health, reason: input.reason }
  })
}
