import { FakeEm } from './support/fake-em'
import { ctx, ORG, TENANT } from './support/campaign-fixtures'
import {
  FakeTransport,
  LAUNCH_ISO,
  SENDER_ADDRESS,
  fixedClock,
  seedInboundMessage,
  seedLaunchedCampaign,
  type LaunchedFixture,
} from './support/execution-fixtures'
import { approveAndSendReply, buildReplyIdempotencyKey } from '../replies/send'
import { clearMailboxPause } from '../reputation/mailbox-control'
import { hashAddress } from '../campaign/exclusions'
import {
  GtmAuditEvent,
  GtmMailboxHealth,
  GtmReply,
  GtmSendAttempt,
  GtmSuppression,
} from '../../data/entities'
import { MAILBOX } from './support/execution-fixtures'
import { EmailMessage } from '../../../email/data/schema'

const SEND_ISO = '2026-07-22T17:00:00.000Z'

describe('approveAndSendReply (approved-draft SEND path)', () => {
  beforeAll(() => {
    process.env.GTM_UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret'
    process.env.GTM_UNSUBSCRIBE_KEYRING = JSON.stringify({
      test: 'test-versioned-unsubscribe-secret',
    })
    process.env.GTM_UNSUBSCRIBE_ACTIVE_KEY_ID = 'test'
    process.env.GTM_PUBLIC_BASE_URL = 'https://crm.fixture.example'
  })

  async function prepare(options: { dailyCap?: number } = {}) {
    const em = new FakeEm()
    const fixture = await seedLaunchedCampaign(em, {
      clock: fixedClock(LAUNCH_ISO),
      recipients: 1,
      emails: 1,
      dailyCap: options.dailyCap,
    })
    const enrollment = fixture.enrollments[0]
    // The conversation has already stopped (an inbound reply arrived).
    enrollment.status = 'stopped'
    enrollment.stopReason = 'email_reply'
    const inbound = await seedInboundMessage(em, {
      from: fixture.addressFor(enrollment),
      bodyText: 'Sounds great, tell me more.',
      createdAt: new Date(LAUNCH_ISO),
    })
    const reply = em.create(GtmReply, {
      organizationId: ORG,
      tenantId: TENANT,
      enrollmentId: enrollment.id,
      sendAttemptId: fixture.attempts[0]?.id ?? null,
      channel: 'email',
      direction: 'inbound',
      emailMessageId: inbound.id,
      classification: 'interested',
      classificationSource: 'model',
      draftResponse: { subject: 'Re: Quick question', body: 'Happy to walk you through it. Thursday at 10?' },
      draftStatus: 'drafted',
    })
    em.persist(reply)
    await em.flush()
    return { em, fixture, enrollment, reply }
  }

  function replyAttempts(em: FakeEm, reply: GtmReply): GtmSendAttempt[] {
    const key = buildReplyIdempotencyKey(reply.id)
    return em.table(GtmSendAttempt).filter((a) => a.idempotencyKey === key)
  }

  it('creates ONE durable attempt and drives it approved -> claimed -> provider_started -> accepted', async () => {
    const { em, enrollment, reply } = await prepare()
    const transport = new FakeTransport()
    const key = buildReplyIdempotencyKey(reply.id)

    // Capture the durable state the transport sees at provider contact.
    let stateAtCall: string | null = null
    let rfcAtCall: string | null = null
    transport.onSend = () => {
      const row = em.table(GtmSendAttempt).find((a) => a.idempotencyKey === key)
      stateAtCall = row?.state ?? null
      rfcAtCall = row?.rfcMessageId ?? null
    }

    const result = await approveAndSendReply(
      em,
      ctx,
      { replyId: reply.id },
      { executionEnabled: true, transport, clock: fixedClock(SEND_ISO) },
    )

    expect(result.outcome).toBe('accepted')
    expect(result.dryRun).toBe(false)

    // Rule 3: provider_started + rfc persisted BEFORE transport contact.
    expect(stateAtCall).toBe('provider_started')
    expect(rfcAtCall).toMatch(/^<[0-9a-f-]{36}@fixture\.example>$/)

    // Exactly one durable attempt, now accepted, stamped as a reply and
    // holding a capacity slot for the mailbox-local day (L11, H3).
    const attempts = replyAttempts(em, reply)
    expect(attempts).toHaveLength(1)
    expect(attempts[0].state).toBe('accepted')
    expect(attempts[0].kind).toBe('reply')
    expect(attempts[0].capacitySlotKey).toMatch(/^v1:.*:2026-07-22:\d+$/)
    expect(attempts[0].rfcMessageId).toBeTruthy()
    expect(attempts[0].sentAt).toBeInstanceOf(Date)

    // The reply is marked sent with an audit.
    expect(reply.draftStatus).toBe('sent')
    const sentAudits = (await em.find(GtmAuditEvent, {})).filter((e) => e.action === 'gtm.reply.sent')
    expect(sentAudits).toHaveLength(1)

    // Section 8: one-click List-Unsubscribe headers on the reply send.
    const args = transport.calls[0]
    expect(args.from).toBe(SENDER_ADDRESS)
    expect(args.to).toBe('synthetic-1@fixture.example')
    expect(args.text).toContain('Thursday at 10')
    expect(args.headers['List-Unsubscribe']).toContain(`<mailto:${SENDER_ADDRESS}?subject=unsubscribe>`)
    expect(args.headers['List-Unsubscribe']).toContain('https://crm.fixture.example/api/gtm/unsubscribe?token=')
    expect(args.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')

    // A reply send NEVER reopens the stopped enrollment.
    expect(enrollment.status).toBe('stopped')
  })

  it('omits one-click POST semantics when no rotatable signing key is configured', async () => {
    const { em, reply } = await prepare()
    const transport = new FakeTransport()
    delete process.env.GTM_UNSUBSCRIBE_KEYRING
    delete process.env.GTM_UNSUBSCRIBE_ACTIVE_KEY_ID
    try {
      const result = await approveAndSendReply(
        em,
        ctx,
        { replyId: reply.id },
        { executionEnabled: true, transport, clock: fixedClock(SEND_ISO) },
      )
      expect(result.outcome).toBe('accepted')
      expect(transport.calls[0].headers['List-Unsubscribe']).toBe(
        `<mailto:${SENDER_ADDRESS}?subject=unsubscribe>`,
      )
      expect(transport.calls[0].headers['List-Unsubscribe-Post']).toBeUndefined()
    } finally {
      process.env.GTM_UNSUBSCRIBE_KEYRING = JSON.stringify({
        test: 'test-versioned-unsubscribe-secret',
      })
      process.env.GTM_UNSUBSCRIBE_ACTIVE_KEY_ID = 'test'
    }
  })

  it('is idempotent: re-approving after a send returns the existing attempt and sends nothing new', async () => {
    const { em, reply } = await prepare()
    const transport = new FakeTransport()
    const deps = { executionEnabled: true, transport, clock: fixedClock(SEND_ISO) }

    const first = await approveAndSendReply(em, ctx, { replyId: reply.id }, deps)
    expect(first.outcome).toBe('accepted')

    const second = await approveAndSendReply(em, ctx, { replyId: reply.id }, deps)
    expect(second.alreadySent).toBe(true)
    expect(second.outcome).toBe('already_sent')
    expect(second.attempt?.id).toBe(first.attempt?.id)

    // Still exactly one attempt, and the transport was only contacted once.
    expect(replyAttempts(em, reply)).toHaveLength(1)
    expect(transport.calls).toHaveLength(1)
  })

  it('rechecks suppression at claim: a suppressed recipient fails closed, transport untouched', async () => {
    const { em, fixture, enrollment, reply } = await prepare()
    em.persist(
      em.create(GtmSuppression, {
        organizationId: ORG,
        tenantId: TENANT,
        scope: 'org',
        channel: 'email',
        addressHash: hashAddress(fixture.addressFor(enrollment)),
        reason: 'manual',
      }),
    )
    await em.flush()
    const transport = new FakeTransport()

    const result = await approveAndSendReply(
      em,
      ctx,
      { replyId: reply.id },
      { executionEnabled: true, transport, clock: fixedClock(SEND_ISO) },
    )
    expect(result.outcome).toBe('failed')
    expect(transport.calls).toHaveLength(0)
    expect(replyAttempts(em, reply)[0].failureReason).toBe('suppressed')
    expect(reply.draftStatus).toBe('approved')
  })

  it('rechecks sender health at claim: an inactive mailbox fails closed', async () => {
    const { em, fixture, reply } = await prepare()
    fixture.connection.isActive = false
    const transport = new FakeTransport()

    const result = await approveAndSendReply(
      em,
      ctx,
      { replyId: reply.id },
      { executionEnabled: true, transport, clock: fixedClock(SEND_ISO) },
    )
    expect(result.outcome).toBe('failed')
    expect(transport.calls).toHaveLength(0)
    expect(replyAttempts(em, reply)[0].failureReason).toBe('sender_inactive')
  })

  it('a paused mailbox refuses the reply without contacting the transport, and sends once the pause is cleared (H3)', async () => {
    const { em, reply } = await prepare()
    const health = em.create(GtmMailboxHealth, {
      organizationId: ORG,
      tenantId: TENANT,
      mailboxConnectionId: MAILBOX,
      status: 'paused',
      rollingWindowStartedAt: new Date('2026-07-15T16:30:00.000Z'),
      pauseReason: 'complaint',
      pauseUntil: null,
      fence: 3,
    })
    em.persist(health)
    await em.flush()
    const transport = new FakeTransport()
    const deps = { executionEnabled: true, transport, clock: fixedClock(SEND_ISO) }

    const refused = await approveAndSendReply(em, ctx, { replyId: reply.id }, deps)
    expect(refused.outcome).toBe('paused')
    expect(transport.calls).toHaveLength(0)
    // Not terminal: the row waits in 'approved' for the pause to clear.
    const attempt = replyAttempts(em, reply)[0]
    expect(attempt).toMatchObject({ state: 'approved', claimToken: null, failureReason: 'mailbox_paused:complaint' })
    expect(reply.draftStatus).toBe('approved')

    await clearMailboxPause(
      em,
      { organizationId: ORG, tenantId: TENANT },
      { mailboxConnectionId: MAILBOX, expectedFence: 3, reason: 'manual_investigation_complete' },
    )
    const sent = await approveAndSendReply(em, ctx, { replyId: reply.id }, deps)
    expect(sent.outcome).toBe('accepted')
    expect(transport.calls).toHaveLength(1)
    expect(replyAttempts(em, reply)).toHaveLength(1)
    expect(reply.draftStatus).toBe('sent')
  })

  it('honours the mailbox policy send window: outside it the reply waits in approved (H3)', async () => {
    const { em, reply } = await prepare()
    const transport = new FakeTransport()
    // 19:00 America/New_York, outside the frozen 9-17 window.
    const result = await approveAndSendReply(
      em,
      ctx,
      { replyId: reply.id },
      { executionEnabled: true, transport, clock: fixedClock('2026-07-22T23:00:00.000Z') },
    )
    expect(result.outcome).toBe('outside_send_window')
    expect(transport.calls).toHaveLength(0)
    expect(replyAttempts(em, reply)[0]).toMatchObject({ state: 'approved', claimToken: null })
  })

  it('honours the mailbox daily cap: a full day refuses the reply until capacity frees (H3)', async () => {
    // Cap 1: the campaign's own pending step already reserves today's slot.
    const { em, reply } = await prepare({ dailyCap: 1 })
    const transport = new FakeTransport()
    const result = await approveAndSendReply(
      em,
      ctx,
      { replyId: reply.id },
      { executionEnabled: true, transport, clock: fixedClock(SEND_ISO) },
    )
    expect(result.outcome).toBe('daily_cap_reached')
    expect(transport.calls).toHaveLength(0)
    expect(replyAttempts(em, reply)[0]).toMatchObject({ state: 'approved', claimToken: null })
  })

  it('never addresses a reply to a smuggled recipient list: falls back to the verified contact point (M5)', async () => {
    const { em, fixture, enrollment, reply } = await prepare()
    const verified = fixture.addressFor(enrollment)
    // Simulate a From header a lenient ingest turned into a list.
    const stored = (await em.findOne(EmailMessage, { id: reply.emailMessageId! }))!
    stored.fromAddress = `${verified}, victim@z.example`
    const transport = new FakeTransport()
    const result = await approveAndSendReply(
      em,
      ctx,
      { replyId: reply.id },
      { executionEnabled: true, transport, clock: fixedClock(SEND_ISO) },
    )
    expect(result.outcome).toBe('accepted')
    expect(transport.calls[0].to).toBe(verified)
  })

  it('honors the GTM_EXECUTION_ENABLED double-lock: dry-run when off (no attempt, no transport)', async () => {
    const { em, reply } = await prepare()
    const transport = new FakeTransport()

    const result = await approveAndSendReply(
      em,
      ctx,
      { replyId: reply.id },
      { executionEnabled: false, transport, clock: fixedClock(SEND_ISO) },
    )
    expect(result.dryRun).toBe(true)
    expect(result.outcome).toBe('dry_run')
    expect(result.attempt).toBeNull()
    expect(transport.calls).toHaveLength(0)
    expect(replyAttempts(em, reply)).toHaveLength(0)
    // The draft was still approved.
    expect(reply.draftStatus).toBe('approved')
  })

  it('a transport error fails the attempt; re-approving returns that same attempt (no auto-retry)', async () => {
    const { em, reply } = await prepare()
    const transport = new FakeTransport()
    transport.behavior = 'fail'
    const deps = { executionEnabled: true, transport, clock: fixedClock(SEND_ISO) }

    const first = await approveAndSendReply(em, ctx, { replyId: reply.id }, deps)
    expect(first.outcome).toBe('failed')
    expect(replyAttempts(em, reply)[0].state).toBe('failed')

    // Re-approve: idempotent return of the existing failed attempt, no re-send.
    // The transport was contacted once on the first send and NOT again.
    transport.behavior = 'success'
    const second = await approveAndSendReply(em, ctx, { replyId: reply.id }, deps)
    expect(second.outcome).toBe('failed')
    expect(replyAttempts(em, reply)).toHaveLength(1)
    expect(transport.calls).toHaveLength(1)
  })

  it('refuses to send a social reply (no mailbox thread)', async () => {
    const { em, reply } = await prepare()
    reply.channel = 'linkedin'
    await expect(
      approveAndSendReply(em, ctx, { replyId: reply.id }, { executionEnabled: true, transport: new FakeTransport() }),
    ).rejects.toMatchObject({ code: 'invalid_state' })
  })

  it('refuses to approve a reply that was never drafted', async () => {
    const { em, reply } = await prepare()
    reply.draftStatus = 'none'
    reply.draftResponse = null
    await expect(
      approveAndSendReply(em, ctx, { replyId: reply.id }, { executionEnabled: false }),
    ).rejects.toMatchObject({ code: 'invalid_state' })
  })
})
