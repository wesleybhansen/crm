import { FakeEm } from './support/fake-em'
import { ctx, ORG } from './support/campaign-fixtures'
import { hashAddress } from '../campaign/exclusions'
import {
  FakeTransport,
  LAUNCH_ISO,
  MAILBOX,
  fixedClock,
  seedInboundMessage,
  seedLaunchedCampaign,
} from './support/execution-fixtures'
import { claimDueAttempts } from '../execute/claim'
import { executeClaimedAttempt } from '../execute/send'
import {
  authenticationVerdict,
  correlateReplies,
  detectInboundEventKind,
  MAX_AUTOMATED_RESPONSE_DEFERRALS,
} from '../replies/correlate'
import {
  GtmInboundEvent,
  GtmMailboxHealth,
  GtmReply,
  GtmSendAttempt,
  GtmSuppression,
} from '../../data/entities'

// Authentication-Results as Gmail stamps it for a genuine sender.
const AUTH_PASS = (domain: string) =>
  `mx.google.com; dkim=pass header.i=@${domain} header.s=sel header.b=abc; spf=pass (google.com: domain designates 1.2.3.4 as permitted sender) smtp.mailfrom=someone@${domain}; dmarc=pass (p=NONE) header.from=${domain}`
const AUTH_FAIL = 'mx.google.com; dkim=none; spf=fail (google.com: domain does not designate 9.9.9.9) smtp.mailfrom=attacker.example'

describe('durable inbound delivery and reply events', () => {
  beforeAll(() => {
    process.env.GTM_UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret'
    process.env.GTM_PUBLIC_BASE_URL = 'https://crm.fixture.example'
  })

  async function sentFixture() {
    const em = new FakeEm()
    const launchClock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, {
      clock: launchClock,
      recipients: 1,
      emails: 2,
    })
    const clock = fixedClock('2026-07-22T16:30:00.000Z')
    const claim = await claimDueAttempts(em, ctx, { clock })
    const sent = claim.claimed[0].attempt
    await executeClaimedAttempt(em, ctx, sent, { transport: new FakeTransport(), clock })
    clock.set('2026-07-22T18:00:00.000Z')
    return {
      em,
      fixture,
      clock,
      sent,
      address: fixture.addressFor(fixture.enrollments[0]),
      rfc: sent.rfcMessageId!.replace(/[<>]/g, ''),
    }
  }

  it('classifies an out-of-office event before side effects and defers without stopping', async () => {
    const s = await sentFixture()
    const message = await seedInboundMessage(s.em, {
      from: s.address,
      headers: {
        'in-reply-to': `<${s.rfc}>`,
        'auto-submitted': 'auto-replied',
        'x-autoreply': 'yes',
      },
      bodyText: 'Sounds great. I am interested when I return.',
      createdAt: s.clock.now(),
    })
    message.subject = 'Out of office: Re: Quick question'

    expect(detectInboundEventKind(message)).toBe('out_of_office')
    const result = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(result).toMatchObject({ systemEvents: 1, failed: 0 })
    expect(result.matched).toHaveLength(0)
    expect(await s.em.find(GtmReply, {})).toHaveLength(0)
    expect(s.fixture.enrollments[0].status).toBe('active')
    const pending = (await s.em.find(GtmSendAttempt, {
      enrollmentId: s.fixture.enrollments[0].id,
    })).find((row) => row.id !== s.sent.id)!
    expect(pending.scheduledFor!.getTime()).toBeGreaterThanOrEqual(
      new Date('2026-07-29T18:00:00.000Z').getTime(),
    )
    const event = await s.em.findOne(GtmInboundEvent, { emailMessageId: message.id })
    expect(event).toMatchObject({ eventKind: 'out_of_office', processingState: 'processed' })
  })

  it('hard bounce stops, suppresses, surfaces as a non-human inbox row, and pauses only on real evidence', async () => {
    const s = await sentFixture()
    const message = await seedInboundMessage(s.em, {
      from: 'mailer-daemon@fixture.example',
      headers: { 'in-reply-to': `<${s.rfc}>` },
      bodyText: 'Delivery failed permanently.',
      createdAt: s.clock.now(),
    })
    message.subject = 'Mail delivery failed: returning message to sender'

    const result = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(result).toMatchObject({ systemEvents: 1, failed: 0 })
    // Reviewed behaviour (api-send-privacy M4): a correlated non-delivery
    // surfaces in the inbox as a delivery-system row, never as a human reply.
    const replies = await s.em.find(GtmReply, {})
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ eventKind: 'hard_bounce', classification: null, draftStatus: 'none' })
    expect(replies.filter((row) => row.eventKind === 'human_reply')).toHaveLength(0)
    expect(s.fixture.enrollments[0]).toMatchObject({ status: 'stopped', stopReason: 'hard_bounce' })
    expect(s.sent).toMatchObject({ state: 'bounced' })
    const suppression = await s.em.findOne(GtmSuppression, {
      organizationId: ORG,
      channel: 'email',
      reason: 'hard_bounce',
    })
    expect(suppression).not.toBeNull()
    expect(suppression!.addressDisplay).toBeNull()
    // The event counts toward mailbox health because it is correlated to our
    // send and fully processed.
    const health = await s.em.findOne(GtmMailboxHealth, { mailboxConnectionId: MAILBOX })
    expect(health).toMatchObject({ hardBounceCount: 1, status: 'warning' })
  })

  it('a delivery DELAY notification is a soft bounce: defers, no stop, no suppression (H2)', async () => {
    const s = await sentFixture()
    // Reviewed behaviour: "Delivery Status Notification (Delay)" used to be
    // a permanent hard bounce that suppressed a perfectly valid address.
    const message = await seedInboundMessage(s.em, {
      from: 'mailer-daemon@googlemail.com',
      headers: { 'in-reply-to': `<${s.rfc}>` },
      bodyText: 'This is an automatically generated Delivery Status Notification. THIS IS A WARNING MESSAGE ONLY.',
      createdAt: s.clock.now(),
    })
    message.subject = 'Delivery Status Notification (Delay)'
    expect(detectInboundEventKind(message)).toBe('soft_bounce')

    const result = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(result).toMatchObject({ systemEvents: 1, failed: 0 })
    expect(s.fixture.enrollments[0].status).toBe('active')
    expect(s.sent.state).toBe('accepted')
    expect(await s.em.find(GtmSuppression, {})).toHaveLength(0)
    const pending = (await s.em.find(GtmSendAttempt, { enrollmentId: s.fixture.enrollments[0].id }))
      .find((row) => row.id !== s.sent.id)!
    expect(pending.scheduledFor!.getTime()).toBeGreaterThanOrEqual(new Date('2026-07-23T18:00:00.000Z').getTime())
    expect(await s.em.findOne(GtmInboundEvent, { emailMessageId: message.id })).toMatchObject({
      eventKind: 'soft_bounce',
      processingState: 'processed',
    })
    // Surfaced in the inbox as a delivery-system row.
    expect((await s.em.find(GtmReply, {})).map((row) => row.eventKind)).toEqual(['soft_bounce'])
  })

  it('a parsed DSN decides bounce severity: 4.x.x soft, 5.x.x hard, regardless of subject', async () => {
    const soft = await sentFixture()
    const delayed = await seedInboundMessage(soft.em, {
      from: 'mailer-daemon@fixture.example',
      headers: { 'in-reply-to': `<${soft.rfc}>` },
      createdAt: soft.clock.now(),
    })
    delayed.subject = 'Undeliverable: Quick question'
    delayed.metadata = { ...delayed.metadata, dsn: { action: 'delayed', status: '4.4.1' } }
    expect(detectInboundEventKind(delayed)).toBe('soft_bounce')
    await correlateReplies(soft.em, ctx, { clock: soft.clock })
    expect(soft.fixture.enrollments[0].status).toBe('active')
    expect(await soft.em.find(GtmSuppression, {})).toHaveLength(0)

    const hard = await sentFixture()
    const failed = await seedInboundMessage(hard.em, {
      from: 'mailer-daemon@fixture.example',
      headers: { 'in-reply-to': `<${hard.rfc}>` },
      createdAt: hard.clock.now(),
    })
    failed.subject = 'Delivery Status Notification (Delay)'
    failed.metadata = { ...failed.metadata, dsn: { action: 'failed', status: '5.1.1' } }
    expect(detectInboundEventKind(failed)).toBe('hard_bounce')
    await correlateReplies(hard.em, ctx, { clock: hard.clock })
    expect(hard.fixture.enrollments[0]).toMatchObject({ status: 'stopped', stopReason: 'hard_bounce' })
    expect(await hard.em.find(GtmSuppression, { reason: 'hard_bounce' })).toHaveLength(1)
  })

  it('a forged Feedback-Type from a prospect address cannot pause the mailbox (H1 scenario 2)', async () => {
    const s = await sentFixture()
    // Fresh compose (fallback correlation), unauthenticated, ARF header set.
    const message = await seedInboundMessage(s.em, {
      from: s.address,
      accountId: MAILBOX,
      threadId: 'attacker-made-this-up',
      headers: { 'feedback-type': 'abuse', 'authentication-results': AUTH_FAIL },
      bodyText: 'This is an email abuse report.',
      createdAt: s.clock.now(),
    })
    expect(authenticationVerdict(message)).toBe('fail')

    const result = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(result.failed).toBe(0)
    // Without a reference to our message the ARF header is not a complaint
    // at all: it is a (stopped, surfaced) human reply.
    const event = (await s.em.findOne(GtmInboundEvent, { emailMessageId: message.id }))!
    expect(event.eventKind).toBe('human_reply')
    expect(s.fixture.enrollments[0].status).toBe('stopped')
    expect(await s.em.find(GtmSuppression, {})).toHaveLength(0)
    expect(await s.em.findOne(GtmMailboxHealth, { mailboxConnectionId: MAILBOX })).toBeNull()
  })

  it('a complaint that references our message but fails authentication is recorded unauthenticated, not acted on', async () => {
    const s = await sentFixture()
    const message = await seedInboundMessage(s.em, {
      from: `abuse@${s.address.split('@')[1]}`,
      headers: {
        'in-reply-to': `<${s.rfc}>`,
        'feedback-type': 'abuse',
        'authentication-results': AUTH_FAIL,
      },
      createdAt: s.clock.now(),
    })
    const result = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(result).toMatchObject({ systemEvents: 1, failed: 0 })
    const event = (await s.em.findOne(GtmInboundEvent, { emailMessageId: message.id }))!
    expect(event).toMatchObject({ eventKind: 'complaint', correlationConfidence: 'unauthenticated', processingState: 'processed' })
    // Safe direction: the enrollment stops and the row surfaces for a human;
    // no suppression, no attempt 'complained', no mailbox pause.
    expect(s.fixture.enrollments[0].status).toBe('stopped')
    expect((await s.em.find(GtmReply, {}))[0]).toMatchObject({
      eventKind: 'unauthenticated_complaint',
      correlationConfidence: 'unauthenticated',
    })
    expect(s.sent.state).not.toBe('complained')
    expect(await s.em.find(GtmSuppression, {})).toHaveLength(0)
    expect(await s.em.findOne(GtmMailboxHealth, { mailboxConnectionId: MAILBOX })).toBeNull()
  })

  it('an authenticated complaint referencing our message pauses the mailbox and suppresses the verified address', async () => {
    const s = await sentFixture()
    const domain = s.address.split('@')[1]
    await seedInboundMessage(s.em, {
      from: `abuse@${domain}`,
      headers: {
        'in-reply-to': `<${s.rfc}>`,
        'feedback-type': 'abuse',
        'authentication-results': AUTH_PASS(domain),
      },
      createdAt: s.clock.now(),
    })
    const result = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(result).toMatchObject({ systemEvents: 1, failed: 0 })
    expect(s.fixture.enrollments[0]).toMatchObject({ status: 'stopped', stopReason: 'complaint' })
    expect(s.sent.state).toBe('complained')
    const suppression = (await s.em.find(GtmSuppression, { reason: 'complaint' }))[0]
    expect(suppression.addressHash).toBe(hashAddress(s.address))
    expect(await s.em.findOne(GtmMailboxHealth, { mailboxConnectionId: MAILBOX })).toMatchObject({
      status: 'paused',
      pauseReason: 'complaint',
      complaintCount: 1,
    })
  })

  it('a spoofed From cannot unsubscribe anyone: an explicit unsubscribe event needs an authenticated sender', async () => {
    const s = await sentFixture()
    const forged = await seedInboundMessage(s.em, {
      from: s.address,
      accountId: MAILBOX,
      threadId: 'fresh-compose',
      headers: { 'authentication-results': AUTH_FAIL },
      createdAt: s.clock.now(),
    })
    forged.metadata = { ...forged.metadata, event_kind: 'unsubscribe' }
    await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(await s.em.find(GtmSuppression, {})).toHaveLength(0)
    expect((await s.em.findOne(GtmInboundEvent, { emailMessageId: forged.id }))!.correlationConfidence)
      .toBe('unauthenticated')
    expect((await s.em.find(GtmReply, {}))[0].eventKind).toBe('unauthenticated_unsubscribe')

    // The genuine article (DKIM pass for the From domain) is honoured.
    const genuine = await sentFixture()
    const real = await seedInboundMessage(genuine.em, {
      from: genuine.address,
      accountId: MAILBOX,
      threadId: 'fresh-compose',
      headers: { 'authentication-results': AUTH_PASS(genuine.address.split('@')[1]) },
      createdAt: genuine.clock.now(),
    })
    real.metadata = { ...real.metadata, event_kind: 'unsubscribe' }
    await correlateReplies(genuine.em, ctx, { clock: genuine.clock })
    expect(await genuine.em.find(GtmSuppression, { reason: 'unsubscribe' })).toHaveLength(1)
  })

  it('personal-mailbox bounces that are not about our sends never touch health or enrollments', async () => {
    const s = await sentFixture()
    for (let i = 0; i < 3; i += 1) {
      const bounce = await seedInboundMessage(s.em, {
        from: 'mailer-daemon@fixture.example',
        threadId: `unrelated-${i}`,
        createdAt: s.clock.now(),
      })
      bounce.subject = 'Undeliverable: lunch on Friday?'
    }
    const result = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(result).toMatchObject({ unmatched: 3, systemEvents: 0, failed: 0 })
    expect(s.fixture.enrollments[0].status).toBe('active')
    expect(await s.em.findOne(GtmMailboxHealth, { mailboxConnectionId: MAILBOX })).toBeNull()
  })

  it('a human reply from the verified address with a bounce-looking subject is a human reply (M4)', async () => {
    const s = await sentFixture()
    const message = await seedInboundMessage(s.em, {
      from: s.address,
      headers: { 'in-reply-to': `<${s.rfc}>` },
      bodyText: 'Ha, not undeliverable at all. Tell me more about pricing.',
      createdAt: s.clock.now(),
    })
    message.subject = 'Re: Undeliverable mail? Not with Fixture Co'
    const result = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0].eventKind).toBe('human_reply')
    expect(await s.em.find(GtmSuppression, {})).toHaveLength(0)
    expect(s.fixture.enrollments[0].stopReason).toBe('email_reply')
  })

  it('caps auto-responder deferrals: after the limit the enrollment stops instead of living forever (L2)', async () => {
    const s = await sentFixture()
    for (let i = 0; i <= MAX_AUTOMATED_RESPONSE_DEFERRALS; i += 1) {
      const auto = await seedInboundMessage(s.em, {
        from: s.address,
        headers: { 'in-reply-to': `<${s.rfc}>`, 'auto-submitted': 'auto-replied' },
        bodyText: 'I am currently out of the office.',
        createdAt: new Date(s.clock.now().getTime() + i * 60_000),
      })
      auto.metadata = { ...auto.metadata, provider_event_id: `auto-${i}` }
      await correlateReplies(s.em, ctx, { clock: s.clock })
      if (i < MAX_AUTOMATED_RESPONSE_DEFERRALS) {
        expect(s.fixture.enrollments[0].status).toBe('active')
      }
    }
    expect(s.fixture.enrollments[0]).toMatchObject({ status: 'stopped', stopReason: 'auto_responder' })
    expect(await s.em.find(GtmSuppression, {})).toHaveLength(0)
    expect(await s.em.find(GtmReply, {})).toHaveLength(0)
  })

  it('rejects a valid RFC reference delivered to the wrong mailbox', async () => {
    const s = await sentFixture()
    await seedInboundMessage(s.em, {
      from: s.address,
      accountId: 'dddddddd-9999-4999-8999-777777777777',
      headers: { 'in-reply-to': `<${s.rfc}>` },
      createdAt: s.clock.now(),
    })
    const result = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(result).toMatchObject({ unmatched: 1, failed: 0 })
    expect(result.matched).toHaveLength(0)
    expect(s.fixture.enrollments[0].status).toBe('active')
  })

  it('refuses even an exact RFC reference when mailbox identity is absent', async () => {
    const s = await sentFixture()
    const message = await seedInboundMessage(s.em, {
      from: s.address,
      headers: { 'in-reply-to': `<${s.rfc}>` },
      createdAt: s.clock.now(),
    })
    message.accountId = null
    const result = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(result).toMatchObject({ unmatched: 1, failed: 0 })
    expect(result.matched).toHaveLength(0)
    expect(s.fixture.enrollments[0].status).toBe('active')
  })

  it('deduplicates a provider replay into one event and one reply', async () => {
    const s = await sentFixture()
    const message = await seedInboundMessage(s.em, {
      from: s.address,
      accountId: MAILBOX,
      headers: { 'in-reply-to': `<${s.rfc}>` },
      bodyText: 'Tell me more.',
      createdAt: s.clock.now(),
    })
    message.metadata = {
      provider: 'gmail',
      provider_event_id: 'history-123:message-456',
      headers: { 'in-reply-to': `<${s.rfc}>` },
    }
    const first = await correlateReplies(s.em, ctx, { clock: s.clock })
    const second = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(first.matched).toHaveLength(1)
    expect(second.matched).toHaveLength(0)
    expect(await s.em.find(GtmInboundEvent, {})).toHaveLength(1)
    expect(await s.em.find(GtmReply, {})).toHaveLength(1)
  })
})
