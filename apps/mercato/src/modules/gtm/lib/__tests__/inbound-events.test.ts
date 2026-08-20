import { FakeEm } from './support/fake-em'
import { ctx, ORG } from './support/campaign-fixtures'
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
import { correlateReplies, detectInboundEventKind } from '../replies/correlate'
import {
  GtmInboundEvent,
  GtmReply,
  GtmSendAttempt,
  GtmSuppression,
} from '../../data/entities'

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

  it('hard bounce stops, suppresses, and never creates a human reply', async () => {
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
    expect(await s.em.find(GtmReply, {})).toHaveLength(0)
    expect(s.fixture.enrollments[0]).toMatchObject({ status: 'stopped', stopReason: 'hard_bounce' })
    expect(s.sent).toMatchObject({ state: 'bounced' })
    const suppression = await s.em.findOne(GtmSuppression, {
      organizationId: ORG,
      channel: 'email',
      reason: 'hard_bounce',
    })
    expect(suppression).not.toBeNull()
    expect(suppression!.addressDisplay).toBeNull()
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
