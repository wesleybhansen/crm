import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core'
import { GtmInboundEvent, GtmMailboxHealth, GtmSendAttempt } from '../../data/entities'
import type { GtmCtx } from '../campaign/build'
import type { Clock, ExecutionEm } from '../execute/schedule'

export const MAILBOX_HEALTH_POLICY_VERSION = 'mailbox-health-v1'
export const MAILBOX_HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const TEMPORARY_PAUSE_MS = 24 * 60 * 60 * 1000

export type MailboxHealthCounts = {
  accepted: number
  delivered: number
  softBounces: number
  hardBounces: number
  complaints: number
}

export type MailboxHealthDecision = {
  status: 'healthy' | 'warning' | 'paused'
  pauseReason: 'complaint' | 'hard_bounce_threshold' | 'soft_bounce_threshold' | null
  pauseUntil: Date | null
}

export function evaluateMailboxHealth(
  counts: MailboxHealthCounts,
  now: Date,
): MailboxHealthDecision {
  const denominator = Math.max(counts.accepted, 1)
  const hardRate = counts.hardBounces / denominator
  const softRate = counts.softBounces / denominator
  if (counts.complaints >= 1) {
    return { status: 'paused', pauseReason: 'complaint', pauseUntil: null }
  }
  if (counts.hardBounces >= 3 || (counts.accepted >= 20 && hardRate >= 0.05)) {
    return { status: 'paused', pauseReason: 'hard_bounce_threshold', pauseUntil: null }
  }
  if (counts.softBounces >= 5 || (counts.accepted >= 20 && softRate >= 0.15)) {
    return {
      status: 'paused',
      pauseReason: 'soft_bounce_threshold',
      pauseUntil: new Date(now.getTime() + TEMPORARY_PAUSE_MS),
    }
  }
  if (counts.hardBounces > 0 || counts.softBounces > 0) {
    return { status: 'warning', pauseReason: null, pauseUntil: null }
  }
  return { status: 'healthy', pauseReason: null, pauseUntil: null }
}

async function loadCounts(
  em: ExecutionEm,
  ctx: Pick<GtmCtx, 'organizationId' | 'tenantId'>,
  mailboxConnectionId: string,
  windowStart: Date,
): Promise<MailboxHealthCounts> {
  const attempts = await em.find(GtmSendAttempt, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    mailboxConnectionId,
    acceptedAt: { $gte: windowStart },
    deletedAt: null,
  })
  const events = await em.find(GtmInboundEvent, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    mailboxConnectionId,
    occurredAt: { $gte: windowStart },
    deletedAt: null,
  })
  return {
    accepted: attempts.length,
    delivered: attempts.filter((attempt) => Boolean(attempt.deliveredAt)).length,
    softBounces: events.filter((event) => event.eventKind === 'soft_bounce').length,
    hardBounces: events.filter((event) => event.eventKind === 'hard_bounce').length,
    complaints: events.filter((event) => event.eventKind === 'complaint').length,
  }
}

async function ensureHealthRow(
  em: ExecutionEm,
  ctx: Pick<GtmCtx, 'organizationId' | 'tenantId'>,
  mailboxConnectionId: string,
  now: Date,
): Promise<GtmMailboxHealth> {
  let row = await em.findOne(GtmMailboxHealth, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    mailboxConnectionId,
    deletedAt: null,
  })
  if (row) return row
  row = em.create(GtmMailboxHealth, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    mailboxConnectionId,
    policyVersion: MAILBOX_HEALTH_POLICY_VERSION,
    status: 'healthy',
    rollingWindowStartedAt: new Date(now.getTime() - MAILBOX_HEALTH_WINDOW_MS),
  })
  em.persist(row)
  try {
    await em.flush()
    return row
  } catch (error) {
    if (!(error instanceof UniqueConstraintViolationException)) throw error
    const winner = await em.findOne(GtmMailboxHealth, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      mailboxConnectionId,
      deletedAt: null,
    })
    if (!winner) throw error
    return winner
  }
}

export async function refreshMailboxHealth(
  em: ExecutionEm,
  ctx: Pick<GtmCtx, 'organizationId' | 'tenantId'>,
  mailboxConnectionId: string,
  deps: { clock?: Clock } = {},
): Promise<GtmMailboxHealth> {
  const now = deps.clock?.now() ?? new Date()
  const windowStart = new Date(now.getTime() - MAILBOX_HEALTH_WINDOW_MS)
  await ensureHealthRow(em, ctx, mailboxConnectionId, now)
  return em.transactional(async (tem) => {
    const row = await tem.findOne(
      GtmMailboxHealth,
      {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        mailboxConnectionId,
        deletedAt: null,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (!row) throw new Error('mailbox health row disappeared')
    const counts = await loadCounts(tem, ctx, mailboxConnectionId, windowStart)
    const decision = evaluateMailboxHealth(counts, now)
    const hasIndefiniteSafetyPause =
      row.status === 'paused'
      && row.pauseUntil == null
      && (row.pauseReason === 'complaint' || row.pauseReason === 'hard_bounce_threshold')
    row.policyVersion = MAILBOX_HEALTH_POLICY_VERSION
    row.rollingWindowStartedAt = windowStart
    row.acceptedCount = counts.accepted
    row.deliveredCount = counts.delivered
    row.softBounceCount = counts.softBounces
    row.hardBounceCount = counts.hardBounces
    row.complaintCount = counts.complaints
    row.status = hasIndefiniteSafetyPause ? 'paused' : decision.status
    row.pauseReason = hasIndefiniteSafetyPause ? row.pauseReason : decision.pauseReason
    row.pauseUntil = hasIndefiniteSafetyPause ? null : decision.pauseUntil
    row.lastEventAt = now
    row.fence += 1
    row.updatedAt = now
    tem.persist(row)
    await tem.flush()
    return row
  })
}

export async function readMailboxSendPermission(
  em: ExecutionEm,
  ctx: Pick<GtmCtx, 'organizationId' | 'tenantId'>,
  mailboxConnectionId: string,
  now: Date,
): Promise<{ allowed: true } | { allowed: false; pauseReason: string; pauseUntil: Date | null }> {
  const row = await em.findOne(
    GtmMailboxHealth,
    {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      mailboxConnectionId,
      deletedAt: null,
    },
    { lockMode: LockMode.PESSIMISTIC_READ },
  )
  if (!row || row.status !== 'paused') return { allowed: true }
  if (row.pauseUntil && row.pauseUntil.getTime() <= now.getTime()) return { allowed: true }
  return {
    allowed: false,
    pauseReason: row.pauseReason ?? 'mailbox_health_paused',
    pauseUntil: row.pauseUntil ?? null,
  }
}
