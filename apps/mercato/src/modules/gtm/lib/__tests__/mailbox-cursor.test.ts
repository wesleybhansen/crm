import { FakeEm } from './support/fake-em'
import { GtmAuditEvent, GtmMailboxCursor } from '../../data/entities'
import {
  MailboxCursorError,
  acquireMailboxCursor,
  advanceMailboxCursor,
  commitMailboxPage,
  failMailboxCursor,
  hashCursor,
  readMailboxCursor,
  requireMailboxResync,
} from '../inbound/cursor'

const context = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000002',
  mailboxConnectionId: '00000000-0000-4000-8000-000000000003',
  provider: 'gmail',
  cursorKind: 'gmail_history_id',
}

const at = (iso: string) => ({ now: () => new Date(iso) })
const codec = {
  seal: async (value: string) => `sealed:${value}`,
  unseal: async (value: string) => value.replace(/^sealed:/, ''),
}

describe('durable mailbox cursor', () => {
  test('leases once, seals an opaque cursor, and advances monotonically', async () => {
    const em = new FakeEm()
    const lease = await acquireMailboxCursor(em, context, { clock: at('2026-08-17T12:00:00Z') })
    await expect(
      acquireMailboxCursor(em, context, { clock: at('2026-08-17T12:00:01Z') }),
    ).rejects.toMatchObject({ code: 'cursor_busy' })

    await advanceMailboxCursor(
      em,
      context,
      {
        cursorId: lease.cursor.id,
        leaseToken: lease.leaseToken,
        fence: lease.fence,
        expectedCursorHash: null,
      },
      {
        cursorValue: 'history-101',
        lastOccurredAt: new Date('2026-08-17T11:59:00Z'),
        lastMessageId: '00000000-0000-4000-8000-000000000004',
      },
      {
        clock: at('2026-08-17T12:00:02Z'),
        codec,
      },
    )

    const cursor = em.table(GtmMailboxCursor)[0]
    expect(cursor.cursorHash).toBe(hashCursor('history-101'))
    expect(cursor.sealedCursor).toBe('sealed:history-101')
    expect(cursor.status).toBe('idle')
    expect(cursor.leaseToken).toBeNull()
    await expect(readMailboxCursor(em, context, codec)).resolves.toMatchObject({
      cursorValue: 'history-101',
    })
  })

  test('rejects cursor regression, stale expected hashes, and plaintext persistence', async () => {
    const em = new FakeEm()
    const first = await acquireMailboxCursor(em, context, { clock: at('2026-08-17T12:00:00Z') })
    await advanceMailboxCursor(
      em,
      context,
      { cursorId: first.cursor.id, leaseToken: first.leaseToken, fence: first.fence },
      { cursorValue: '101', lastOccurredAt: new Date('2026-08-17T12:00:00Z') },
      { codec: { seal: async () => 'sealed', unseal: codec.unseal }, clock: at('2026-08-17T12:00:01Z') },
    )

    const second = await acquireMailboxCursor(em, context, { clock: at('2026-08-17T12:00:02Z') })
    await expect(
      advanceMailboxCursor(
        em,
        context,
        {
          cursorId: second.cursor.id,
          leaseToken: second.leaseToken,
          fence: second.fence,
          expectedCursorHash: 'stale',
        },
        { cursorValue: '102' },
        { codec: { seal: async () => 'sealed-102', unseal: codec.unseal } },
      ),
    ).rejects.toBeInstanceOf(MailboxCursorError)

    await expect(
      advanceMailboxCursor(
        em,
        context,
        {
          cursorId: second.cursor.id,
          leaseToken: second.leaseToken,
          fence: second.fence,
          expectedCursorHash: hashCursor('101'),
        },
        { cursorValue: '102' },
      ),
    ).rejects.toMatchObject({ code: 'cursor_codec_required' })
  })

  test('expires leases and fences an old worker', async () => {
    const em = new FakeEm()
    const oldLease = await acquireMailboxCursor(em, context, {
      clock: at('2026-08-17T12:00:00Z'),
      leaseMs: 10_000,
    })
    const newLease = await acquireMailboxCursor(em, context, {
      clock: at('2026-08-17T12:00:11Z'),
      leaseMs: 10_000,
    })
    await expect(
      advanceMailboxCursor(
        em,
        context,
        { cursorId: oldLease.cursor.id, leaseToken: oldLease.leaseToken, fence: oldLease.fence },
        { lastOccurredAt: new Date('2026-08-17T12:00:05Z') },
      ),
    ).rejects.toMatchObject({ code: 'cursor_conflict' })
    expect(
      await failMailboxCursor(
        em,
        context,
        { cursorId: newLease.cursor.id, leaseToken: newLease.leaseToken, fence: newLease.fence },
        'temporary_failure',
        { clock: at('2026-08-17T12:00:12Z') },
      ),
    ).toBe(true)
    expect(em.table(GtmMailboxCursor)[0].status).toBe('error')
  })

  test('an expired lease cannot advance even before another worker reclaims it', async () => {
    const em = new FakeEm()
    const lease = await acquireMailboxCursor(em, context, {
      clock: at('2026-08-17T12:00:00Z'),
      leaseMs: 10_000,
    })
    await expect(
      advanceMailboxCursor(
        em,
        context,
        { cursorId: lease.cursor.id, leaseToken: lease.leaseToken, fence: lease.fence },
        { cursorValue: 'late-history' },
        { codec, clock: at('2026-08-17T12:00:11Z') },
      ),
    ).rejects.toMatchObject({ code: 'cursor_conflict' })
    expect(em.table(GtmMailboxCursor)[0].cursorHash).toBeNull()
  })

  test('commits a page before cursor advancement and records explicit resync requirements', async () => {
    const em = new FakeEm()
    const lease = await acquireMailboxCursor(em, context, { clock: at('2026-08-17T12:00:00Z') })
    let pagePersisted = false
    await commitMailboxPage(
      em,
      context,
      { cursorId: lease.cursor.id, leaseToken: lease.leaseToken, fence: lease.fence },
      {
        persist: async () => {
          pagePersisted = true
        },
        cursorValue: 'history-202',
      },
      { codec, clock: at('2026-08-17T12:00:01Z') },
    )
    expect(pagePersisted).toBe(true)
    expect(em.table(GtmMailboxCursor)[0].cursorHash).toBe(hashCursor('history-202'))

    const next = await acquireMailboxCursor(em, context, { clock: at('2026-08-17T12:00:02Z') })
    await expect(
      requireMailboxResync(
        em,
        context,
        { cursorId: next.cursor.id, leaseToken: next.leaseToken, fence: next.fence },
        'gmail_history_expired',
        { clock: at('2026-08-17T12:00:03Z') },
      ),
    ).resolves.toBe(true)
    // H3: the expired anchor is discarded in the same fenced write so the
    // next job re-baselines from the provider, and the gap is audited.
    expect(em.table(GtmMailboxCursor)[0]).toMatchObject({
      status: 'resync_required',
      lastError: 'gmail_history_expired',
      cursorHash: null,
      sealedCursor: null,
      leaseToken: null,
    })
    const audits = em.table(GtmAuditEvent).filter((row) => row.action === 'gtm.mailbox.cursor_resync')
    expect(audits).toHaveLength(1)
    expect(audits[0].metadata).toMatchObject({
      reason: 'gmail_history_expired',
      mailbox_connection_id: context.mailboxConnectionId,
      gap_detected_at: '2026-08-17T12:00:03.000Z',
    })
    await expect(readMailboxCursor(em, context, codec)).resolves.toMatchObject({ cursorValue: null })

    // Recovery: a fresh lease is granted and a re-baselined cursor advances
    // from null exactly like a first connection.
    const recovered = await acquireMailboxCursor(em, context, { clock: at('2026-08-17T12:00:04Z') })
    await advanceMailboxCursor(
      em,
      context,
      { cursorId: recovered.cursor.id, leaseToken: recovered.leaseToken, fence: recovered.fence, expectedCursorHash: null },
      { cursorValue: 'history-303' },
      { codec, clock: at('2026-08-17T12:00:05Z') },
    )
    expect(em.table(GtmMailboxCursor)[0]).toMatchObject({ status: 'idle', cursorHash: hashCursor('history-303') })
  })
})
