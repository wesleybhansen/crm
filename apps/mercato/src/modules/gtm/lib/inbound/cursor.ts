import crypto from 'crypto'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import { GtmAuditEvent, GtmMailboxCursor } from '../../data/entities'
import type { Clock } from '../execute/schedule'

export type CursorContext = {
  organizationId: string
  tenantId: string
  mailboxConnectionId: string
  provider: string
  cursorKind: string
}

export type CursorCodec = {
  seal(value: string, context: CursorContext): Promise<string>
  unseal(value: string, context: CursorContext): Promise<string>
}

export type CursorEm = {
  findOne<T extends object>(Ctor: new () => T, where: Record<string, unknown>): Promise<T | null>
  create<T extends object>(Ctor: new () => T, data: object): T
  persist(entity: object): unknown
  flush(): Promise<void>
  nativeUpdate<T extends object>(
    Ctor: new () => T,
    where: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<number>
  transactional<T>(cb: (em: CursorEm) => Promise<T>): Promise<T>
}

export class MailboxCursorError extends Error {
  constructor(
    readonly code:
      | 'cursor_busy'
      | 'cursor_conflict'
      | 'cursor_not_found'
      | 'cursor_codec_required'
      | 'cursor_integrity',
    message: string,
  ) {
    super(message)
  }
}

export async function readMailboxCursor(
  em: CursorEm,
  context: CursorContext,
  codec: CursorCodec,
): Promise<{ cursor: GtmMailboxCursor; cursorValue: string | null }> {
  const cursor = await em.findOne(GtmMailboxCursor, { ...context, deletedAt: null })
  if (!cursor) throw new MailboxCursorError('cursor_not_found', 'Mailbox cursor not found')
  if (!cursor.sealedCursor) return { cursor, cursorValue: null }
  const cursorValue = await codec.unseal(cursor.sealedCursor, context)
  if (!cursor.cursorHash || hashCursor(cursorValue) !== cursor.cursorHash) {
    throw new MailboxCursorError('cursor_integrity', 'Mailbox cursor failed integrity verification')
  }
  return { cursor, cursorValue }
}

export function hashCursor(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

export async function acquireMailboxCursor(
  em: CursorEm,
  context: CursorContext,
  deps: { clock?: Clock; leaseMs?: number } = {},
): Promise<{ cursor: GtmMailboxCursor; leaseToken: string; fence: number }> {
  const now = deps.clock?.now() ?? new Date()
  const leaseMs = Math.max(10_000, Math.min(deps.leaseMs ?? 120_000, 15 * 60_000))
  let cursor = await em.findOne(GtmMailboxCursor, { ...context, deletedAt: null })
  if (!cursor) {
    cursor = em.create(GtmMailboxCursor, {
      ...context,
      status: 'idle',
      fence: 0,
      cursorHash: null,
      sealedCursor: null,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    em.persist(cursor)
    try {
      await em.flush()
    } catch (error) {
      if (!(error instanceof UniqueConstraintViolationException)) throw error
      cursor = await em.findOne(GtmMailboxCursor, { ...context, deletedAt: null })
      if (!cursor) throw error
    }
  }

  const leaseToken = crypto.randomUUID()
  const fence = cursor.fence + 1
  const updated = await em.nativeUpdate(
    GtmMailboxCursor,
    {
      id: cursor.id,
      organizationId: context.organizationId,
      tenantId: context.tenantId,
      fence: cursor.fence,
      $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }],
    },
    {
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      fence,
      status: 'running',
      lastError: null,
      updatedAt: now,
    },
  )
  if (updated !== 1) throw new MailboxCursorError('cursor_busy', 'Mailbox cursor is leased')
  Object.assign(cursor, {
    leaseToken,
    leaseExpiresAt: new Date(now.getTime() + leaseMs),
    fence,
    status: 'running',
    lastError: null,
    updatedAt: now,
  })
  return { cursor, leaseToken, fence }
}

export async function advanceMailboxCursor(
  em: CursorEm,
  context: CursorContext,
  lease: { cursorId: string; leaseToken: string; fence: number; expectedCursorHash?: string | null },
  next: {
    cursorValue?: string | null
    lastOccurredAt?: Date | null
    lastMessageId?: string | null
  },
  deps: { codec?: CursorCodec; clock?: Clock } = {},
): Promise<void> {
  const now = deps.clock?.now() ?? new Date()
  const cursor = await em.findOne(GtmMailboxCursor, {
    id: lease.cursorId,
    organizationId: context.organizationId,
    tenantId: context.tenantId,
    mailboxConnectionId: context.mailboxConnectionId,
    provider: context.provider,
    cursorKind: context.cursorKind,
    deletedAt: null,
  })
  if (!cursor) throw new MailboxCursorError('cursor_not_found', 'Mailbox cursor not found')
  if ((lease.expectedCursorHash ?? null) !== (cursor.cursorHash ?? null)) {
    throw new MailboxCursorError('cursor_conflict', 'Mailbox cursor changed before advancement')
  }
  if (
    next.lastOccurredAt &&
    cursor.lastOccurredAt &&
    next.lastOccurredAt.getTime() < cursor.lastOccurredAt.getTime()
  ) {
    throw new MailboxCursorError('cursor_conflict', 'Mailbox cursor cannot move backwards')
  }

  let cursorHash = cursor.cursorHash ?? null
  let sealedCursor = cursor.sealedCursor ?? null
  if (next.cursorValue != null) {
    if (!deps.codec) {
      throw new MailboxCursorError('cursor_codec_required', 'Provider cursors require a sealing codec')
    }
    cursorHash = hashCursor(next.cursorValue)
    sealedCursor = await deps.codec.seal(next.cursorValue, context)
  }

  const updated = await em.nativeUpdate(
    GtmMailboxCursor,
    {
      id: cursor.id,
      organizationId: context.organizationId,
      tenantId: context.tenantId,
      leaseToken: lease.leaseToken,
      fence: lease.fence,
      status: 'running',
      leaseExpiresAt: { $gt: now },
    },
    {
      cursorHash,
      sealedCursor,
      lastOccurredAt: next.lastOccurredAt ?? cursor.lastOccurredAt ?? null,
      lastMessageId: next.lastMessageId ?? cursor.lastMessageId ?? null,
      leaseToken: null,
      leaseExpiresAt: null,
      status: 'idle',
      lastSuccessAt: now,
      lastError: null,
      updatedAt: now,
    },
  )
  if (updated !== 1) throw new MailboxCursorError('cursor_conflict', 'Mailbox cursor lease was fenced')
}

export async function failMailboxCursor(
  em: CursorEm,
  context: Pick<CursorContext, 'organizationId' | 'tenantId'>,
  lease: { cursorId: string; leaseToken: string; fence: number },
  errorCode: string,
  deps: { clock?: Clock } = {},
): Promise<boolean> {
  const now = deps.clock?.now() ?? new Date()
  const updated = await em.nativeUpdate(
    GtmMailboxCursor,
    {
      id: lease.cursorId,
      organizationId: context.organizationId,
      tenantId: context.tenantId,
      leaseToken: lease.leaseToken,
      fence: lease.fence,
      status: 'running',
      leaseExpiresAt: { $gt: now },
    },
    {
      leaseToken: null,
      leaseExpiresAt: null,
      status: 'error',
      lastError: errorCode.slice(0, 200),
      updatedAt: now,
    },
  )
  return updated === 1
}

/**
 * The provider no longer honours the stored cursor (Gmail history expired,
 * Graph delta gone, IMAP UIDVALIDITY changed). Recovery is automatic (H3):
 * the sealed cursor and its hash are nulled in the SAME fenced update that
 * records the resync, so the next job re-baselines from the provider
 * exactly like a first connection (readMailboxCursor returns null,
 * readPage(null) fetches a fresh anchor). Nothing in between the expired
 * anchor and the new baseline is ever fetched; that gap is durable in an
 * audit event so an operator can see what the mailbox may have missed.
 */
export async function requireMailboxResync(
  em: CursorEm,
  context: Pick<CursorContext, 'organizationId' | 'tenantId'> & Partial<CursorContext>,
  lease: { cursorId: string; leaseToken: string; fence: number },
  reason: 'gmail_history_expired' | 'graph_delta_expired' | 'imap_uidvalidity_changed',
  deps: { clock?: Clock } = {},
): Promise<boolean> {
  const now = deps.clock?.now() ?? new Date()
  const before = await em.findOne(GtmMailboxCursor, {
    id: lease.cursorId,
    organizationId: context.organizationId,
    tenantId: context.tenantId,
    deletedAt: null,
  })
  const updated = await em.nativeUpdate(
    GtmMailboxCursor,
    {
      id: lease.cursorId,
      organizationId: context.organizationId,
      tenantId: context.tenantId,
      leaseToken: lease.leaseToken,
      fence: lease.fence,
      status: 'running',
      leaseExpiresAt: { $gt: now },
    },
    {
      leaseToken: null,
      leaseExpiresAt: null,
      status: 'resync_required',
      cursorHash: null,
      sealedCursor: null,
      lastError: reason,
      updatedAt: now,
    },
  )
  if (updated !== 1) return false
  em.persist(
    em.create(GtmAuditEvent, {
      organizationId: context.organizationId,
      tenantId: context.tenantId,
      actor: 'system',
      actorUserId: null,
      action: 'gtm.mailbox.cursor_resync',
      objectType: 'gtm_mailbox_cursor',
      objectId: lease.cursorId,
      requestId: null,
      metadata: {
        reason,
        mailbox_connection_id: context.mailboxConnectionId ?? before?.mailboxConnectionId ?? null,
        provider: context.provider ?? before?.provider ?? null,
        cursor_kind: context.cursorKind ?? before?.cursorKind ?? null,
        // The gap: nothing between the last successfully ingested message
        // and the new baseline will be fetched.
        gap_started_at: before?.lastOccurredAt?.toISOString() ?? null,
        gap_last_message_id: before?.lastMessageId ?? null,
        gap_detected_at: now.toISOString(),
        last_success_at: before?.lastSuccessAt?.toISOString() ?? null,
      },
    }),
  )
  await em.flush()
  return true
}

/**
 * Commits one provider page and its cursor advancement in the same database
 * transaction. The callback must only persist normalized, tenant-scoped page
 * rows; if it or the fenced advancement fails, the real ORM transaction rolls
 * both back and the provider page is safe to replay.
 */
export async function commitMailboxPage(
  em: CursorEm,
  context: CursorContext,
  lease: { cursorId: string; leaseToken: string; fence: number; expectedCursorHash?: string | null },
  page: {
    persist: (em: CursorEm) => Promise<void>
    cursorValue?: string | null
    lastOccurredAt?: Date | null
    lastMessageId?: string | null
  },
  deps: { codec?: CursorCodec; clock?: Clock } = {},
): Promise<void> {
  await em.transactional(async (tem) => {
    await page.persist(tem)
    await tem.flush()
    await advanceMailboxCursor(
      tem,
      context,
      lease,
      {
        cursorValue: page.cursorValue,
        lastOccurredAt: page.lastOccurredAt,
        lastMessageId: page.lastMessageId,
      },
      deps,
    )
  })
}
