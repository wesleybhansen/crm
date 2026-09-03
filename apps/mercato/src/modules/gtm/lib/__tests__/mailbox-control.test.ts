import { EmailConnection } from '../../../email/data/schema'
import { GtmInboundEvent, GtmMailboxHealth, GtmSendAttempt } from '../../data/entities'
import {
  clearMailboxPause,
  GtmMailboxControlError,
} from '../reputation/mailbox-control'
import { refreshMailboxHealth } from '../reputation/mailbox-health'
import { FakeEm } from './support/fake-em'

const ORG = '00000000-0000-4000-8000-000000000001'
const TENANT = '00000000-0000-4000-8000-000000000002'
const USER = '00000000-0000-4000-8000-000000000003'
const MAILBOX = '00000000-0000-4000-8000-000000000004'
const NOW = new Date('2026-08-17T20:00:00.000Z')

async function seedPausedMailbox(em: FakeEm): Promise<GtmMailboxHealth> {
  em.persist(em.create(EmailConnection, {
    id: MAILBOX,
    organizationId: ORG,
    tenantId: TENANT,
    userId: USER,
    provider: 'gmail',
    emailAddress: 'owned-fixture@example.test',
    isActive: true,
  }))
  const health = em.create(GtmMailboxHealth, {
    organizationId: ORG,
    tenantId: TENANT,
    mailboxConnectionId: MAILBOX,
    rollingWindowStartedAt: new Date(NOW.getTime() - 86_400_000),
    status: 'paused',
    pauseReason: 'complaint',
    pauseUntil: null,
    complaintCount: 1,
    fence: 7,
  })
  em.persist(health)
  await em.flush()
  return health
}

describe('GTM mailbox operator controls', () => {
  it('clears exactly the echoed pause fence without erasing evidence', async () => {
    const em = new FakeEm()
    const health = await seedPausedMailbox(em)
    const result = await clearMailboxPause(
      em,
      { organizationId: ORG, tenantId: TENANT },
      {
        mailboxConnectionId: MAILBOX,
        expectedFence: 7,
        reason: 'manual_investigation_complete',
      },
      { clock: { now: () => NOW } },
    )
    expect(result.health).toBe(health)
    expect(result.health).toMatchObject({
      status: 'warning',
      pauseReason: null,
      pauseUntil: null,
      complaintCount: 1,
      fence: 8,
      updatedAt: NOW,
    })

    await expect(clearMailboxPause(
      em,
      { organizationId: ORG, tenantId: TENANT },
      {
        mailboxConnectionId: MAILBOX,
        expectedFence: 7,
        reason: 'manual_investigation_complete',
      },
    )).rejects.toMatchObject({ code: 'stale_fence' })
  })

  it('fails closed for a foreign or inactive mailbox and a current non-pause', async () => {
    const em = new FakeEm()
    const health = await seedPausedMailbox(em)
    await expect(clearMailboxPause(
      em,
      { organizationId: ORG, tenantId: '00000000-0000-4000-8000-000000000099' },
      { mailboxConnectionId: MAILBOX, expectedFence: 7, reason: 'false_positive' },
    )).rejects.toBeInstanceOf(GtmMailboxControlError)

    health.status = 'warning'
    await expect(clearMailboxPause(
      em,
      { organizationId: ORG, tenantId: TENANT },
      { mailboxConnectionId: MAILBOX, expectedFence: 7, reason: 'false_positive' },
    )).rejects.toMatchObject({ code: 'mailbox_not_paused' })

    const mailbox = await em.findOne(EmailConnection, { id: MAILBOX })
    if (!mailbox) throw new Error('fixture mailbox missing')
    mailbox.isActive = false
    health.status = 'paused'
    await expect(clearMailboxPause(
      em,
      { organizationId: ORG, tenantId: TENANT },
      { mailboxConnectionId: MAILBOX, expectedFence: 7, reason: 'sender_remediated' },
    )).rejects.toMatchObject({ code: 'mailbox_not_found' })
  })

  it('allows the next safety refresh to re-latch a cleared mailbox on NEW evidence only', async () => {
    const em = new FakeEm()
    await seedPausedMailbox(em)
    const attempt = em.create(GtmSendAttempt, {
      organizationId: ORG,
      tenantId: TENANT,
      mailboxConnectionId: MAILBOX,
      idempotencyKey: 'send:1',
      acceptedAt: new Date(NOW.getTime() - 60_000),
    })
    em.persist(attempt)
    // The complaint the operator judged a false positive (at/before the clear).
    em.persist(em.create(GtmInboundEvent, {
      organizationId: ORG,
      tenantId: TENANT,
      mailboxConnectionId: MAILBOX,
      provider: 'gmail',
      providerEventId: 'old-complaint',
      dedupeKey: 'old-complaint',
      eventKind: 'complaint',
      sendAttemptId: attempt.id,
      processingState: 'processed',
      occurredAt: new Date(NOW.getTime() - 1_000),
    }))
    await em.flush()
    await clearMailboxPause(
      em,
      { organizationId: ORG, tenantId: TENANT },
      { mailboxConnectionId: MAILBOX, expectedFence: 7, reason: 'false_positive' },
      { clock: { now: () => NOW } },
    )
    // Reviewed behaviour (api-send-privacy M2): the rows that caused the
    // false positive must not re-latch the pause on the next refresh.
    const stillClear = await refreshMailboxHealth(
      em,
      { organizationId: ORG, tenantId: TENANT },
      MAILBOX,
      { clock: { now: () => new Date(NOW.getTime() + 500) } },
    )
    expect(stillClear).toMatchObject({ status: 'healthy', complaintCount: 0, fence: 9 })

    // A NEW correlated complaint after the clear pauses again. (The event
    // carries a send_attempt_id and is processed: uncorrelated rows never
    // count, see mailbox-health.ts.)
    em.persist(em.create(GtmInboundEvent, {
      organizationId: ORG,
      tenantId: TENANT,
      mailboxConnectionId: MAILBOX,
      provider: 'gmail',
      providerEventId: 'new-complaint',
      dedupeKey: 'new-complaint',
      eventKind: 'complaint',
      sendAttemptId: attempt.id,
      processingState: 'processed',
      occurredAt: new Date(NOW.getTime() + 800),
    }))
    await em.flush()
    const refreshed = await refreshMailboxHealth(
      em,
      { organizationId: ORG, tenantId: TENANT },
      MAILBOX,
      { clock: { now: () => new Date(NOW.getTime() + 1_000) } },
    )
    expect(refreshed).toMatchObject({
      status: 'paused',
      pauseReason: 'complaint',
      pauseUntil: null,
      complaintCount: 1,
      fence: 10,
    })
  })
})
