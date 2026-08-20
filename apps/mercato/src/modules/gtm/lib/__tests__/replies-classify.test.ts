import { FakeEm } from './support/fake-em'
import { ctx, ORG, TENANT } from './support/campaign-fixtures'
import {
  LAUNCH_ISO,
  fixedClock,
  seedInboundMessage,
  seedLaunchedCampaign,
} from './support/execution-fixtures'
import {
  approveDraft,
  classifyReply,
  draftResponse,
  keywordClassifier,
} from '../replies/classify'
import { recordSocialReply } from '../replies/correlate'
import { hashAddress } from '../campaign/exclusions'
import { GtmAuditEvent, GtmReply, GtmSuppression } from '../../data/entities'

describe('keywordClassifier (deterministic v1; LLM is a later seam)', () => {
  const cases: Array<[string, string]> = [
    ['Please unsubscribe me from this list', 'unsubscribe'],
    ['Opt me out of these emails', 'unsubscribe'],
    ['I think you have the wrong person', 'wrong_person'],
    ['She no longer works here, sorry', 'wrong_person'],
    ['You should talk to our head of growth', 'referral'],
    ['Try contacting our operations lead instead', 'referral'],
    ['Maybe next quarter, circle back then', 'not_now'],
    ['Bad timing for us right now', 'not_now'],
    ['Not interested, please stop', 'negative'],
    ['This is not a good fit for us', 'negative'],
    ['Sounds great, tell me more', 'interested'],
    ['Interested. Can we book a call?', 'interested'],
    ['What exactly does your product do?', 'neutral_question'],
    ['', 'neutral_question'],
  ]
  it.each(cases)('classifies %j as %s', (text, expected) => {
    expect(keywordClassifier.classify(text)).toBe(expected)
  })

  it('negative intent wins over the interested keyword it contains', () => {
    expect(keywordClassifier.classify('We are not interested in a demo')).toBe('negative')
  })
})

describe('classifyReply / drafts (SPEC-066 section 9)', () => {
  beforeAll(() => {
    process.env.GTM_UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret'
  })

  async function socialReplyFixture() {
    const em = new FakeEm()
    const fixture = await seedLaunchedCampaign(em, {
      clock: fixedClock(LAUNCH_ISO),
      recipients: 1,
      emails: 1,
      linkedin: true,
    })
    const step = fixture.steps.find((row) => row.mode === 'manual_social')!
    const { reply } = await recordSocialReply(em, ctx, {
      enrollmentId: fixture.enrollments[0].id,
      stepId: step.id,
      note: 'They answered on LinkedIn',
    })
    return { em, fixture, reply }
  }

  it('user override sets the classification with source user_override and audits', async () => {
    const { em, reply } = await socialReplyFixture()
    const result = await classifyReply(em, ctx, {
      replyId: reply.id,
      classification: 'interested',
    })
    expect(result.classification).toBe('interested')
    expect(reply.classification).toBe('interested')
    expect(reply.classificationSource).toBe('user_override')
    const audits = (await em.find(GtmAuditEvent, {})).filter(
      (event) => event.action === 'gtm.reply.classified',
    )
    expect(audits).toHaveLength(1)
  })

  it('model classification reads the linked inbound message text', async () => {
    const { em, fixture, reply } = await socialReplyFixture()
    // Link an inbound message carrying interested-intent text.
    const message = await seedInboundMessage(em, {
      from: fixture.addressFor(fixture.enrollments[0]),
      bodyText: 'Sounds great, can we schedule something?',
      createdAt: new Date(LAUNCH_ISO),
    })
    reply.emailMessageId = message.id
    const result = await classifyReply(em, ctx, { replyId: reply.id })
    expect(result.classification).toBe('interested')
    expect(reply.classificationSource).toBe('model')
  })

  it('an unsubscribe classification writes the suppression in the same transaction', async () => {
    const { em, fixture, reply } = await socialReplyFixture()
    const address = fixture.addressFor(fixture.enrollments[0])
    const result = await classifyReply(em, ctx, {
      replyId: reply.id,
      classification: 'unsubscribe',
    })
    expect(result.suppressed).toBe(true)
    const suppression = await em.findOne(GtmSuppression, {
      organizationId: ORG,
      channel: 'email',
      addressHash: hashAddress(address),
    })
    expect(suppression).not.toBeNull()
    expect(suppression!.reason).toBe('unsubscribe')

    // Re-classifying unsubscribe again is idempotent on the suppression.
    const repeat = await classifyReply(em, ctx, {
      replyId: reply.id,
      classification: 'unsubscribe',
    })
    expect(repeat.suppressed).toBe(false)
    const all = (await em.find(GtmSuppression, { organizationId: ORG, tenantId: TENANT })).filter(
      (row) => row.addressHash === hashAddress(address),
    )
    expect(all).toHaveLength(1)
  })

  it('draft-response stores the draft and approve-draft flips it with an audit; no send path exists', async () => {
    const { em, reply } = await socialReplyFixture()
    expect(reply.draftStatus).toBe('none')

    await draftResponse(em, ctx, {
      replyId: reply.id,
      draft: { subject: 'Re: your note', body: 'Happy to walk you through it.' },
    })
    expect(reply.draftStatus).toBe('drafted')
    expect((reply.draftResponse as Record<string, unknown>).body).toBe(
      'Happy to walk you through it.',
    )

    const approved = await approveDraft(em, ctx, { replyId: reply.id })
    expect(approved.draftStatus).toBe('approved')
    const audits = (await em.find(GtmAuditEvent, {})).filter(
      (event) => event.action === 'gtm.reply.draft_approved',
    )
    expect(audits).toHaveLength(1)

    // Approving twice (or approving a never-drafted reply) is refused.
    await expect(approveDraft(em, ctx, { replyId: reply.id })).rejects.toMatchObject({
      code: 'invalid_state',
    })
  })

  it('a reply that was never drafted cannot be approved and unknown replies 404 out', async () => {
    const { em } = await socialReplyFixture()
    const bare = em.create(GtmReply, {
      organizationId: ORG,
      tenantId: TENANT,
      enrollmentId: 'abababab-1111-4111-8111-121212121212',
      channel: 'email',
    })
    em.persist(bare)
    await em.flush()
    await expect(approveDraft(em, ctx, { replyId: bare.id })).rejects.toMatchObject({
      code: 'invalid_state',
    })
    await expect(
      draftResponse(em, ctx, {
        replyId: 'ffffffff-0000-4000-8000-999999999999',
        draft: { body: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'reply_not_found' })
  })
})
