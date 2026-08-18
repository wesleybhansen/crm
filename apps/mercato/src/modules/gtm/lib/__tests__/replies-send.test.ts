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
import { hashAddress } from '../campaign/exclusions'
import { GtmAuditEvent, GtmReply, GtmSendAttempt, GtmSuppression } from '../../data/entities'

const SEND_ISO = '2026-07-22T17:00:00.000Z'

describe('approveAndSendReply (approved-draft SEND path)', () => {
  beforeAll(() => {
    process.env.GTM_UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret'
    process.env.GTM_PUBLIC_BASE_URL = 'https://crm.fixture.example'
  })

  async function prepare() {
    const em = new FakeEm()
    const fixture = await seedLaunchedCampaign(em, {
      clock: fixedClock(LAUNCH_ISO),
      recipients: 1,
      emails: 1,
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

    // Exactly one durable attempt, now accepted.
    const attempts = replyAttempts(em, reply)
    expect(attempts).toHaveLength(1)
    expect(attempts[0].state).toBe('accepted')
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
