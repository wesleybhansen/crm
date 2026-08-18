import { FakeEm } from './support/fake-em'
import { ctx, OTHER_ORG, TENANT, USER } from './support/campaign-fixtures'
import {
  FakeTransport,
  LAUNCH_ISO,
  fixedClock,
  seedInboundMessage,
  seedLaunchedCampaign,
} from './support/execution-fixtures'
import { claimDueAttempts } from '../execute/claim'
import { executeClaimedAttempt } from '../execute/send'
import { correlateReplies } from '../replies/correlate'
import { buildThread } from '../replies/thread'
import { GtmExecutionError } from '../execute/schedule'
import type { Clock } from '../execute/schedule'

const TICK_ISO = '2026-07-22T16:30:00.000Z'
const REPLY_ISO = '2026-07-22T16:45:00.000Z'

describe('buildThread (full correlated conversation)', () => {
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
    // Send the one outbound email so the thread has a real outbound leg.
    const clock: Clock = fixedClock(TICK_ISO)
    const claim = await claimDueAttempts(em, ctx, { clock })
    const outcome = await executeClaimedAttempt(em, ctx, claim.claimed[0].attempt, {
      transport: new FakeTransport(),
      clock,
    })
    expect(outcome.outcome).toBe('accepted')
    const attempt = claim.claimed[0].attempt

    // The prospect replies: an inbound message threaded onto our rfc id.
    const bareRfc = (attempt.rfcMessageId ?? '').replace(/[<>]/g, '')
    const inbound = await seedInboundMessage(em, {
      from: fixture.addressFor(fixture.enrollments[0]),
      threadId: bareRfc,
      bodyText: 'Sounds great, tell me more.',
      createdAt: new Date(REPLY_ISO),
    })
    const correlated = await correlateReplies(em, ctx, { clock: fixedClock(REPLY_ISO) })
    expect(correlated.matched).toHaveLength(1)
    return { em, fixture, reply: correlated.matched[0].reply, attempt, inbound }
  }

  it('returns the outbound send and the inbound reply in chronological order', async () => {
    const { em, reply } = await prepare()
    const thread = await buildThread(em, ctx, { replyId: reply.id })

    expect(thread.messages).toHaveLength(2)
    expect(thread.messages.map((m) => m.direction)).toEqual(['outbound', 'inbound'])

    const [out, inb] = thread.messages
    expect(out.kind).toBe('outbound')
    expect(out.from).toBe('sender@fixture.example')
    expect(out.to).toBe('synthetic-1@fixture.example')
    expect(out.body_text?.length ?? 0).toBeGreaterThan(0)
    expect(out.rfc_message_id).toMatch(/@fixture\.example/)

    expect(inb.kind).toBe('inbound')
    expect(inb.from).toBe('synthetic-1@fixture.example')
    expect(inb.body_text).toBe('Sounds great, tell me more.')

    // Ascending by instant: the send precedes the reply.
    expect((out.at as Date).getTime()).toBeLessThan((inb.at as Date).getTime())
  })

  it('scopes to the reply enrollment and 404s a foreign org', async () => {
    const { em, reply } = await prepare()
    const foreignCtx = { organizationId: OTHER_ORG, tenantId: TENANT, userId: USER, requestId: null }
    await expect(buildThread(em, foreignCtx, { replyId: reply.id })).rejects.toBeInstanceOf(
      GtmExecutionError,
    )
    await expect(buildThread(em, foreignCtx, { replyId: reply.id })).rejects.toMatchObject({
      code: 'reply_not_found',
    })
  })

  it('a missing reply id 404s', async () => {
    const { em } = await prepare()
    await expect(
      buildThread(em, ctx, { replyId: 'ffffffff-0000-4000-8000-999999999999' }),
    ).rejects.toMatchObject({ code: 'reply_not_found' })
  })
})
