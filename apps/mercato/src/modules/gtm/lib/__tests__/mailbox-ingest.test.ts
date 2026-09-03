import { EmailMessage } from '../../../email/data/schema'
import { GtmAuditEvent, GtmInboundEvent, GtmMailboxCursor, GtmReply } from '../../data/entities'
import type { CursorCodec } from '../inbound/cursor'
import { ingestMailbox } from '../inbound/ingest'
import {
  MailboxProviderCursorExpiredError,
  type MailboxProviderReader,
  type NormalizedMailboxMessage,
} from '../inbound/providers/types'
import * as classify from '../replies/classify'
import { FakeEm } from './support/fake-em'
import { ctx as fixtureCtx } from './support/campaign-fixtures'
import { FakeTransport, LAUNCH_ISO, MAILBOX as FIXTURE_MAILBOX, fixedClock, seedLaunchedCampaign } from './support/execution-fixtures'
import { claimDueAttempts } from '../execute/claim'
import { executeClaimedAttempt } from '../execute/send'

const ORG = '00000000-0000-4000-8000-000000000001'
const TENANT = '00000000-0000-4000-8000-000000000002'
const USER = '00000000-0000-4000-8000-000000000003'
const MAILBOX = '00000000-0000-4000-8000-000000000004'
const NOW = new Date('2026-08-17T20:00:00.000Z')

const codec: CursorCodec = {
  async seal(value, context) {
    return Buffer.from(`${context.tenantId}:${value}`).toString('base64url')
  },
  async unseal(value, context) {
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    const prefix = `${context.tenantId}:`
    if (!decoded.startsWith(prefix)) throw new Error('scope mismatch')
    return decoded.slice(prefix.length)
  },
}

describe('durable mailbox ingestion', () => {
  it('commits normalized messages before advancing a sealed cursor and replays idempotently', async () => {
    const em = new FakeEm()
    const reader: MailboxProviderReader = {
      readPage: jest.fn(async () => ({
        messages: [{
          provider: 'gmail' as const,
          providerMessageId: 'message-1',
          providerEventId: 'event-1',
          threadId: 'thread-1',
          rfcMessageId: 'inbound@example.com',
          fromAddress: 'person@example.com',
          toAddress: 'sender@example.com',
          cc: null,
          subject: 'Hello',
          bodyHtml: '',
          bodyText: 'Interested',
          receivedAt: NOW,
          headers: { 'in-reply-to': '<sent@noli.test>' },
        }],
        nextCursor: JSON.stringify({ startHistoryId: '101' }),
        hasMore: false,
      })),
    }
    const ctx = { organizationId: ORG, tenantId: TENANT, userId: USER, requestId: 'test' }
    const input = {
      mailboxConnectionId: MAILBOX,
      provider: 'gmail' as const,
      cursorKind: 'gmail_history_id' as const,
      reader,
      codec,
    }
    const first = await ingestMailbox(em, ctx, input, { clock: { now: () => NOW } })
    expect(first).toMatchObject({ pages: 1, messages: 1, resyncRequired: false })
    expect(em.table(EmailMessage)).toHaveLength(1)
    expect(em.table(GtmInboundEvent)).toHaveLength(1)
    const cursor = em.table(GtmMailboxCursor)[0]
    expect(cursor.status).toBe('idle')
    expect(cursor.cursorHash).toMatch(/^[a-f0-9]{64}$/)
    expect(cursor.sealedCursor).not.toContain('101')

    const replay = await ingestMailbox(em, ctx, input, { clock: { now: () => NOW } })
    expect(replay.messages).toBe(0)
    expect(em.table(EmailMessage)).toHaveLength(1)
    expect(em.table(GtmInboundEvent)).toHaveLength(1)
  })

  function normalized(overrides: Partial<NormalizedMailboxMessage> & { providerEventId: string }): NormalizedMailboxMessage {
    return {
      provider: 'gmail',
      providerMessageId: overrides.providerEventId,
      threadId: null,
      rfcMessageId: null,
      fromAddress: 'person@example.com',
      toAddress: 'sender@fixture.example',
      cc: null,
      subject: 'Re: Quick question',
      bodyHtml: '',
      bodyText: 'Interested, tell me more.',
      receivedAt: NOW,
      headers: {},
      ...overrides,
    }
  }

  it('isolates one failing disposition: the page commits, the cursor advances, only that event is failed, and a later sweep recovers it (H4)', async () => {
    process.env.GTM_UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret'
    process.env.GTM_PUBLIC_BASE_URL = 'https://crm.fixture.example'
    const em = new FakeEm()
    const fixture = await seedLaunchedCampaign(em, { clock: fixedClock(LAUNCH_ISO), recipients: 2, emails: 2 })
    const clock = fixedClock('2026-07-22T16:30:00.000Z')
    const claim = await claimDueAttempts(em, fixtureCtx, { clock })
    for (const claimed of claim.claimed) {
      await executeClaimedAttempt(em, fixtureCtx, claimed.attempt, { transport: new FakeTransport(), clock })
    }
    const [first, second] = claim.claimed.map((c) => c.attempt)
    const addressOf = (attemptId: string) =>
      fixture.addressFor(fixture.enrollments.find((e) => e.id === fixture.attempts.find((a) => a.id === attemptId)!.enrollmentId)!)
    clock.set('2026-07-22T18:00:00.000Z')

    const reader: MailboxProviderReader = {
      readPage: jest.fn(async () => ({
        messages: [
          normalized({
            providerEventId: 'poison',
            fromAddress: addressOf(first.id),
            headers: { 'in-reply-to': first.rfcMessageId! },
            receivedAt: clock.now(),
          }),
          normalized({
            providerEventId: 'fine',
            fromAddress: addressOf(second.id),
            headers: { 'in-reply-to': second.rfcMessageId! },
            receivedAt: clock.now(),
          }),
        ],
        nextCursor: JSON.stringify({ startHistoryId: '200' }),
        hasMore: false,
      })),
    }
    // The 'poison' message's disposition blows up AFTER the atomic stop (a
    // classifier bug); the 'fine' message must still be processed.
    const original = classify.classifyReply
    const spy = jest.spyOn(classify, 'classifyReply').mockImplementation(async (tem, tctx, input, deps) => {
      const reply = await tem.findOne(GtmReply, { id: input.replyId })
      const message = reply?.emailMessageId
        ? await tem.findOne(EmailMessage, { id: reply.emailMessageId })
        : null
      if ((message?.metadata as Record<string, unknown> | null)?.provider_event_id === 'poison') {
        throw new Error('classifier exploded')
      }
      return original(tem, tctx, input, deps)
    })
    try {
      const input = {
        mailboxConnectionId: FIXTURE_MAILBOX,
        provider: 'gmail' as const,
        cursorKind: 'gmail_history_id' as const,
        reader,
        codec,
      }
      const result = await ingestMailbox(em, fixtureCtx, input, { clock })
      expect(result).toMatchObject({ pages: 1, messages: 2, resyncRequired: false })
      // The page pass failed exactly one event; the job's own bounded sweep
      // then re-claimed it (the stop + reply were already durable, so no
      // second classification runs) and finished it.
      expect(result.correlation.failed).toBe(1)
      expect(result.correlation.matched).toHaveLength(2)
      // Page + cursor committed despite the failure; nothing wedged.
      const cursor = em.table(GtmMailboxCursor)[0]
      expect(cursor.status).toBe('idle')
      expect(cursor.cursorHash).toMatch(/^[a-f0-9]{64}$/)
      const events = em.table(GtmInboundEvent)
      expect(events.map((e) => e.processingState)).toEqual(['processed', 'processed'])
      const poison = events.find((e) => e.emailMessageId === em.table(EmailMessage)
        .find((m) => (m.metadata as Record<string, unknown>).provider_event_id === 'poison')!.id)!
      expect(poison.processingFence).toBe(2)
      expect(poison.processingClaimToken).toBeNull()
      expect(poison.lastError).toBeNull()
      // Both enrollments stopped exactly once; one reply per message.
      expect(em.table(GtmReply)).toHaveLength(2)
      expect(fixture.enrollments.map((e) => e.status)).toEqual(['stopped', 'stopped'])
    } finally {
      spy.mockRestore()
    }
  })

  it('quarantines an event that keeps failing instead of re-running it forever', async () => {
    const em = new FakeEm()
    const message = em.create(EmailMessage, {
      organizationId: ORG,
      tenantId: TENANT,
      accountId: MAILBOX,
      direction: 'inbound',
      fromAddress: 'person@example.com',
      toAddress: 'sender@example.com',
      subject: 'x',
      bodyHtml: '',
      bodyText: 'x',
      metadata: { provider: 'gmail', provider_event_id: 'stuck' },
      createdAt: NOW,
    })
    em.persist(message)
    await em.flush()
    const { correlateReplies, MAX_EVENT_ATTEMPTS } = await import('../replies/correlate')
    const scope = { organizationId: ORG, tenantId: TENANT, userId: USER, requestId: null }
    const probe = await correlateReplies(em, scope, { messageIds: [message.id], clock: { now: () => NOW } })
    expect(probe.unmatched).toBe(1)
    // Simulate MAX_EVENT_ATTEMPTS failed dispositions on that event.
    const event = em.table(GtmInboundEvent)[0]
    event.processingState = 'failed'
    event.processingFence = MAX_EVENT_ATTEMPTS
    const result = await correlateReplies(em, scope, { messageIds: [message.id], clock: { now: () => NOW } })
    expect(result).toMatchObject({ quarantined: 1, failed: 0, unmatched: 0 })
    expect(event).toMatchObject({ processingState: 'failed', processingFence: MAX_EVENT_ATTEMPTS })
  })

  it('recovers from an expired provider cursor: resync nulls the anchor, the next job re-baselines, then pages again (H3)', async () => {
    const em = new FakeEm()
    const readPage = jest.fn()
      // Job 1: the stored anchor is gone at the provider.
      .mockImplementationOnce(async () => {
        throw new MailboxProviderCursorExpiredError('gmail_history_expired')
      })
      // Job 2: null cursor -> fresh baseline (no messages).
      .mockImplementationOnce(async (cursor: string | null) => {
        expect(cursor).toBeNull()
        return { messages: [], nextCursor: JSON.stringify({ startHistoryId: '900' }), hasMore: false }
      })
      // Job 3: incremental page from the new baseline.
      .mockImplementationOnce(async (cursor: string | null) => {
        expect(cursor).toBe(JSON.stringify({ startHistoryId: '900' }))
        return {
          messages: [normalized({ providerEventId: 'after-resync', receivedAt: NOW })],
          nextCursor: JSON.stringify({ startHistoryId: '905' }),
          hasMore: false,
        }
      })
    const reader: MailboxProviderReader = { readPage }
    const ctx = { organizationId: ORG, tenantId: TENANT, userId: USER, requestId: 'test' }
    const input = {
      mailboxConnectionId: MAILBOX,
      provider: 'gmail' as const,
      cursorKind: 'gmail_history_id' as const,
      reader,
      codec,
    }
    // Seed a sealed (soon expired) anchor.
    await ingestMailbox(em, ctx, {
      ...input,
      reader: { readPage: async () => ({ messages: [], nextCursor: JSON.stringify({ startHistoryId: '100' }), hasMore: false }) },
    }, { clock: { now: () => NOW } })
    expect(em.table(GtmMailboxCursor)[0].cursorHash).not.toBeNull()

    const expired = await ingestMailbox(em, ctx, input, { clock: { now: () => NOW } })
    expect(expired.resyncRequired).toBe(true)
    expect(em.table(GtmMailboxCursor)[0]).toMatchObject({ status: 'resync_required', cursorHash: null, sealedCursor: null })
    expect(em.table(GtmAuditEvent).filter((row) => row.action === 'gtm.mailbox.cursor_resync')).toHaveLength(1)

    const rebaselined = await ingestMailbox(em, ctx, input, { clock: { now: () => NOW } })
    expect(rebaselined).toMatchObject({ pages: 1, messages: 0, resyncRequired: false })
    expect(em.table(GtmMailboxCursor)[0].status).toBe('idle')

    const paged = await ingestMailbox(em, ctx, input, { clock: { now: () => NOW } })
    expect(paged).toMatchObject({ pages: 1, messages: 1, resyncRequired: false })
    expect(readPage).toHaveBeenCalledTimes(3)
  })
})
