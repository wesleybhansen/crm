import { GtmInboundEvent, GtmMailboxHealth, GtmSendAttempt } from '../../data/entities'
import {
  evaluateMailboxHealth,
  readMailboxSendPermission,
  refreshMailboxHealth,
} from '../reputation/mailbox-health'
import { FakeEm } from './support/fake-em'

const ORG = '00000000-0000-4000-8000-000000000001'
const TENANT = '00000000-0000-4000-8000-000000000002'
const MAILBOX = '00000000-0000-4000-8000-000000000003'
const NOW = new Date('2026-08-17T20:00:00.000Z')
const clock = { now: () => NOW }

describe('mailbox health policy', () => {
  it('pauses immediately for a complaint and permanently at the hard-bounce threshold', () => {
    expect(evaluateMailboxHealth({
      accepted: 1,
      delivered: 0,
      softBounces: 0,
      hardBounces: 0,
      complaints: 1,
    }, NOW)).toEqual({ status: 'paused', pauseReason: 'complaint', pauseUntil: null })

    expect(evaluateMailboxHealth({
      accepted: 40,
      delivered: 35,
      softBounces: 0,
      hardBounces: 2,
      complaints: 0,
    }, NOW)).toEqual({ status: 'paused', pauseReason: 'hard_bounce_threshold', pauseUntil: null })
  })

  it('applies a bounded pause for repeated soft bounces', () => {
    const decision = evaluateMailboxHealth({
      accepted: 20,
      delivered: 16,
      softBounces: 3,
      hardBounces: 0,
      complaints: 0,
    }, NOW)
    expect(decision.status).toBe('paused')
    expect(decision.pauseReason).toBe('soft_bounce_threshold')
    expect(decision.pauseUntil).toEqual(new Date('2026-08-18T20:00:00.000Z'))
  })

  it('recomputes bounded counts and keeps an indefinite safety pause latched', async () => {
    const em = new FakeEm()
    for (let i = 0; i < 20; i += 1) {
      em.persist(em.create(GtmSendAttempt, {
        organizationId: ORG,
        tenantId: TENANT,
        mailboxConnectionId: MAILBOX,
        idempotencyKey: `send:${i}`,
        acceptedAt: new Date(NOW.getTime() - 60_000),
      }))
    }
    em.persist(em.create(GtmInboundEvent, {
      organizationId: ORG,
      tenantId: TENANT,
      mailboxConnectionId: MAILBOX,
      provider: 'gmail',
      providerEventId: 'complaint-1',
      dedupeKey: 'complaint-1',
      eventKind: 'complaint',
      occurredAt: new Date(NOW.getTime() - 30_000),
    }))
    await em.flush()

    const row = await refreshMailboxHealth(
      em,
      { organizationId: ORG, tenantId: TENANT },
      MAILBOX,
      { clock },
    )
    expect(row).toMatchObject({
      status: 'paused',
      pauseReason: 'complaint',
      pauseUntil: null,
      acceptedCount: 20,
      complaintCount: 1,
    })

    em.table(GtmInboundEvent).splice(0)
    const later = { now: () => new Date('2026-08-30T20:00:00.000Z') }
    const latched = await refreshMailboxHealth(
      em,
      { organizationId: ORG, tenantId: TENANT },
      MAILBOX,
      { clock: later },
    )
    expect(latched.status).toBe('paused')
    expect(latched.pauseReason).toBe('complaint')
    expect(latched.pauseUntil).toBeNull()
  })

  it('defaults an unseen mailbox to allowed and blocks a scoped paused mailbox', async () => {
    const em = new FakeEm()
    await expect(readMailboxSendPermission(
      em,
      { organizationId: ORG, tenantId: TENANT },
      MAILBOX,
      NOW,
    )).resolves.toEqual({ allowed: true })

    em.persist(em.create(GtmMailboxHealth, {
      organizationId: ORG,
      tenantId: TENANT,
      mailboxConnectionId: MAILBOX,
      rollingWindowStartedAt: NOW,
      status: 'paused',
      pauseReason: 'complaint',
      pauseUntil: null,
    }))
    await em.flush()
    await expect(readMailboxSendPermission(
      em,
      { organizationId: ORG, tenantId: TENANT },
      MAILBOX,
      NOW,
    )).resolves.toEqual({ allowed: false, pauseReason: 'complaint', pauseUntil: null })

    await expect(readMailboxSendPermission(
      em,
      { organizationId: 'other', tenantId: TENANT },
      MAILBOX,
      NOW,
    )).resolves.toEqual({ allowed: true })
  })
})
