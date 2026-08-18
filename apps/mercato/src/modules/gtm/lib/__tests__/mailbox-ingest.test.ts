import { EmailMessage } from '../../../email/data/schema'
import { GtmInboundEvent, GtmMailboxCursor } from '../../data/entities'
import type { CursorCodec } from '../inbound/cursor'
import { ingestMailbox } from '../inbound/ingest'
import type { MailboxProviderReader } from '../inbound/providers/types'
import { FakeEm } from './support/fake-em'

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
})
