import { FakeEm } from './support/fake-em'
import { ctx, ORG } from './support/campaign-fixtures'
import {
  FakeTransport,
  LAUNCH_ISO,
  MAILBOX,
  fixedClock,
  seedInboundMessage,
  seedLaunchedCampaign,
  type LaunchedFixture,
} from './support/execution-fixtures'
import { claimDueAttempts } from '../execute/claim'
import { executeClaimedAttempt } from '../execute/send'
import { correlateReplies, recordSocialReply } from '../replies/correlate'
import {
  GtmEnrollment,
  GtmReply,
  GtmSendAttempt,
  GtmSuppression,
} from '../../data/entities'
import type { Clock } from '../execute/schedule'

const TICK_ISO = '2026-07-22T16:30:00.000Z'
const REPLY_ISO = '2026-07-22T18:00:00.000Z'

describe('correlateReplies + atomic stop (SPEC-066 sections 9, 3.3)', () => {
  beforeAll(() => {
    process.env.GTM_UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret'
    process.env.GTM_PUBLIC_BASE_URL = 'https://crm.fixture.example'
  })

  type SentFixture = {
    em: FakeEm
    clock: Clock & { set: (iso: string) => void }
    fixture: LaunchedFixture
    sentAttempt: GtmSendAttempt
    enrollment: GtmEnrollment
    address: string
    rfcBare: string
  }

  // Launch 2 email steps, execute the day-0 one for real (fake transport) so
  // it holds a minted rfc_message_id; the day-3 attempt stays 'approved'.
  async function sent(options: { linkedin?: boolean } = {}): Promise<SentFixture> {
    const em = new FakeEm()
    const launchClock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, {
      clock: launchClock,
      recipients: 1,
      emails: 2,
      linkedin: options.linkedin,
    })
    const clock = fixedClock(TICK_ISO)
    const claim = await claimDueAttempts(em, ctx, { clock })
    const transport = new FakeTransport()
    const outcome = await executeClaimedAttempt(em, ctx, claim.claimed[0].attempt, {
      transport,
      clock,
    })
    expect(outcome.outcome).toBe('accepted')
    const sentAttempt = claim.claimed[0].attempt
    const enrollment = fixture.enrollments[0]
    clock.set(REPLY_ISO)
    return {
      em,
      clock,
      fixture,
      sentAttempt,
      enrollment,
      address: fixture.addressFor(enrollment),
      rfcBare: sentAttempt.rfcMessageId!.replace(/[<>]/g, ''),
    }
  }

  it('header match: creates the reply AND stops the enrollment atomically, cancelling pending sends', async () => {
    const s = await sent()
    const message = await seedInboundMessage(s.em, {
      from: s.address,
      headers: { 'in-reply-to': `<${s.rfcBare}>` },
      threadId: 'unrelated-root',
      bodyText: 'Thanks, tell me more about this.',
      createdAt: s.clock.now(),
    })

    const result = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0].matchedBy).toBe('header')

    // The reply row is visible...
    const reply = await s.em.findOne(GtmReply, { emailMessageId: message.id })
    expect(reply).not.toBeNull()
    expect(reply!.sendAttemptId).toBe(s.sentAttempt.id)
    expect(reply!.channel).toBe('email')
    // ...and the stop is already durable (same transaction, section 9).
    expect(s.enrollment.status).toBe('stopped')
    expect(s.enrollment.stopReason).toBe('email_reply')

    // The pending day-3 attempt was cancelled before it could ever send.
    const pending = (await s.em.find(GtmSendAttempt, { enrollmentId: s.enrollment.id })).filter(
      (row) => row.id !== s.sentAttempt.id,
    )
    expect(pending).toHaveLength(1)
    expect(pending[0].state).toBe('failed')
    expect(pending[0].failureReason).toBe('stopped')

    // The matched attempt advanced accepted -> replied.
    expect(s.sentAttempt.state).toBe('replied')
    expect(s.sentAttempt.repliedAt).toBeInstanceOf(Date)

    // Post-commit classification ran ('interested' from the body keywords).
    expect(reply!.classification).toBe('interested')
    expect(reply!.classificationSource).toBe('model')

    // A subsequent claim finds nothing to send for this enrollment.
    s.clock.set('2026-07-27T15:00:00.000Z')
    const later = await claimDueAttempts(s.em, ctx, { clock: s.clock })
    expect(later.claimed).toHaveLength(0)
  })

  it('a reply cancels a CLAIMED in-flight send so it cannot be mailed over', async () => {
    const s = await sent()
    // Advance to the day-3 step and claim it, so an executor is genuinely
    // mid-flight holding a valid claim at the moment the reply lands.
    s.clock.set('2026-07-27T15:00:00.000Z')
    const claim = await claimDueAttempts(s.em, ctx, { clock: s.clock })
    expect(claim.claimed).toHaveLength(1)
    const inflight = claim.claimed[0].attempt
    expect(inflight.state).toBe('claimed')

    await seedInboundMessage(s.em, {
      from: s.address,
      headers: { 'in-reply-to': `<${s.rfcBare}>` },
      threadId: 'unrelated-root',
      bodyText: 'Thanks, tell me more about this.',
      createdAt: s.clock.now(),
    })
    const result = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(result.matched).toHaveLength(1)

    // The claim is REVOKED. Relying on the executor's pre-send recheck alone
    // is not enough: it reads enrollment.status early, then does nine more DB
    // round trips before the transport, so a reply committing inside that
    // window would still be mailed. Nulling the token closes it.
    expect(inflight.state).toBe('failed')
    expect(inflight.failureReason).toBe('stopped')
    expect(inflight.claimToken).toBeNull()

    // An executor still holding the stale claim sends nothing.
    const transport = new FakeTransport()
    const outcome = await executeClaimedAttempt(s.em, ctx, inflight, {
      transport,
      clock: s.clock,
    })
    expect(outcome.outcome).toBe('fenced')
    expect(transport.calls).toHaveLength(0)
  })

  it('references-header and thread_id matches both correlate', async () => {
    const viaReferences = await sent()
    const m1 = await seedInboundMessage(viaReferences.em, {
      from: viaReferences.address,
      headers: { references: `<${viaReferences.rfcBare}> <other@example.com>` },
      threadId: 'unrelated-root',
      createdAt: viaReferences.clock.now(),
    })
    const r1 = await correlateReplies(viaReferences.em, ctx, { clock: viaReferences.clock })
    expect(r1.matched).toHaveLength(1)
    expect(r1.matched[0].emailMessageId).toBe(m1.id)

    // inbox-ingest strips angle brackets and stores the References root as
    // thread_id without persisting the raw headers; that alone must match.
    const viaThread = await sent()
    const m2 = await seedInboundMessage(viaThread.em, {
      from: viaThread.address,
      threadId: viaThread.rfcBare,
      createdAt: viaThread.clock.now(),
    })
    const r2 = await correlateReplies(viaThread.em, ctx, { clock: viaThread.clock })
    expect(r2.matched).toHaveLength(1)
    expect(r2.matched[0].emailMessageId).toBe(m2.id)
    expect(r2.matched[0].matchedBy).toBe('header')
  })

  it('re-scan is idempotent: one reply per inbound message, ever', async () => {
    const s = await sent()
    await seedInboundMessage(s.em, {
      from: s.address,
      headers: { 'in-reply-to': `<${s.rfcBare}>` },
      createdAt: s.clock.now(),
    })
    const first = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(first.matched).toHaveLength(1)
    const second = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(second.matched).toHaveLength(0)
    expect(await s.em.find(GtmReply, {})).toHaveLength(1)
  })

  it('fallback match: same mailbox + counterparty address of a live enrollment', async () => {
    const s = await sent()
    // A fresh compose: no reply headers, unrelated thread root.
    const message = await seedInboundMessage(s.em, {
      from: s.address,
      accountId: MAILBOX,
      threadId: 'their-own-message-id',
      bodyText: 'Following up separately - interested.',
      createdAt: s.clock.now(),
    })
    const result = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0].matchedBy).toBe('fallback')
    expect(result.matched[0].attemptId).toBe(s.sentAttempt.id)
    const reply = await s.em.findOne(GtmReply, { emailMessageId: message.id })
    expect(reply).not.toBeNull()
    expect(s.enrollment.status).toBe('stopped')
  })

  it('no match = no-op (unknown sender, unrelated thread, different mailbox)', async () => {
    const s = await sent()
    await seedInboundMessage(s.em, {
      from: 'stranger@elsewhere.example',
      threadId: 'unrelated',
      createdAt: s.clock.now(),
    })
    await seedInboundMessage(s.em, {
      from: s.address,
      accountId: 'dddddddd-9999-4999-8999-777777777777', // different mailbox
      threadId: 'unrelated',
      createdAt: s.clock.now(),
    })
    const result = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(result.matched).toHaveLength(0)
    expect(await s.em.find(GtmReply, {})).toHaveLength(0)
    expect(s.enrollment.status).toBe('active')
  })

  it('an unsubscribe reply classifies as unsubscribe AND writes the suppression', async () => {
    const s = await sent()
    await seedInboundMessage(s.em, {
      from: s.address,
      headers: { 'in-reply-to': `<${s.rfcBare}>` },
      bodyText: 'Please unsubscribe me from these emails.',
      createdAt: s.clock.now(),
    })
    const result = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0].reply.classification).toBe('unsubscribe')
    const suppressions = (await s.em.find(GtmSuppression, { organizationId: ORG })).filter(
      (row) => row.reason === 'unsubscribe',
    )
    expect(suppressions).toHaveLength(1)
  })

  it('a reply for an already-stopped enrollment records the reply without rewriting the stop', async () => {
    const s = await sent()
    s.enrollment.status = 'stopped'
    s.enrollment.stopReason = 'manual'
    const stoppedAt = new Date('2026-07-22T17:00:00.000Z')
    s.enrollment.stoppedAt = stoppedAt
    await seedInboundMessage(s.em, {
      from: s.address,
      headers: { 'in-reply-to': `<${s.rfcBare}>` },
      createdAt: s.clock.now(),
    })
    const result = await correlateReplies(s.em, ctx, { clock: s.clock })
    expect(result.matched).toHaveLength(1)
    expect(s.enrollment.stopReason).toBe('manual')
    expect(s.enrollment.stoppedAt).toBe(stoppedAt)
  })
})

describe('recordSocialReply: the identical atomic-stop path (SPEC-066 sections 9, 10)', () => {
  beforeAll(() => {
    process.env.GTM_UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret'
  })

  it('stops the enrollment, cancels the scheduled email before it can send, and records the reply', async () => {
    const em = new FakeEm()
    const launchClock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, {
      clock: launchClock,
      recipients: 1,
      emails: 2,
      linkedin: true,
    })
    const enrollment = fixture.enrollments[0]
    const linkedinStep = fixture.steps.find(
      (step) => step.mode === 'manual_social' && step.channel === 'linkedin',
    )!

    const clock = fixedClock(TICK_ISO)
    const { reply, alreadyRecorded } = await recordSocialReply(
      em,
      ctx,
      { enrollmentId: enrollment.id, stepId: linkedinStep.id, note: 'Replied on LinkedIn' },
      { clock },
    )
    expect(alreadyRecorded).toBe(false)
    expect(reply.channel).toBe('linkedin')
    expect(reply.stepId).toBe(linkedinStep.id)
    expect(enrollment.status).toBe('stopped')
    expect(enrollment.stopReason).toBe('social_reply')

    // Both pending email attempts were cancelled inside the same
    // transaction, so the racing tick has nothing to claim.
    const attempts = await em.find(GtmSendAttempt, { enrollmentId: enrollment.id })
    expect(attempts).toHaveLength(2)
    for (const attempt of attempts) {
      expect(attempt.state).toBe('failed')
      expect(attempt.failureReason).toBe('stopped')
    }
    const claim = await claimDueAttempts(em, ctx, { clock })
    expect(claim.claimed).toHaveLength(0)
  })

  it('is idempotent per (enrollment, step)', async () => {
    const em = new FakeEm()
    const fixture = await seedLaunchedCampaign(em, {
      clock: fixedClock(LAUNCH_ISO),
      recipients: 1,
      emails: 1,
      linkedin: true,
    })
    const enrollment = fixture.enrollments[0]
    const step = fixture.steps.find((row) => row.mode === 'manual_social')!
    const first = await recordSocialReply(em, ctx, {
      enrollmentId: enrollment.id,
      stepId: step.id,
    })
    const second = await recordSocialReply(em, ctx, {
      enrollmentId: enrollment.id,
      stepId: step.id,
    })
    expect(second.alreadyRecorded).toBe(true)
    expect(second.reply.id).toBe(first.reply.id)
    expect(await em.find(GtmReply, {})).toHaveLength(1)
  })

  it('refuses to record a social reply on an automated email step', async () => {
    const em = new FakeEm()
    const fixture = await seedLaunchedCampaign(em, {
      clock: fixedClock(LAUNCH_ISO),
      recipients: 1,
      emails: 1,
    })
    const emailStep = fixture.steps.find((row) => row.mode === 'automated_email')!
    await expect(
      recordSocialReply(em, ctx, {
        enrollmentId: fixture.enrollments[0].id,
        stepId: emailStep.id,
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' })
  })
})
