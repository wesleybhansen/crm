import crypto from 'crypto'
import { FakeEm } from './support/fake-em'
import { ctx, ORG, TENANT } from './support/campaign-fixtures'
import {
  FakeTransport,
  LAUNCH_ISO,
  MAILBOX,
  SENDER_ADDRESS,
  fixedClock,
  seedLaunchedCampaign,
  type LaunchedFixture,
} from './support/execution-fixtures'
import { claimDueAttempts } from '../execute/claim'
import { executeClaimedAttempt } from '../execute/send'
import { hashAddress } from '../campaign/exclusions'
import { messageContentHash, UNSUBSCRIBE_URL_TOKEN } from '../campaign/render'
import {
  GtmContactPoint,
  GtmRenderedMessage,
  GtmSendAttempt,
  GtmSuppression,
  GtmWorkspace,
} from '../../data/entities'
import type { Clock } from '../execute/schedule'
import { EmailUnsubscribe } from '../../../email/data/schema'

const TICK_ISO = '2026-07-22T16:30:00.000Z'

describe('executeClaimedAttempt (SPEC-066 section 6 rules 2-5, section 8)', () => {
  beforeAll(() => {
    process.env.GTM_UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret'
    process.env.GTM_PUBLIC_BASE_URL = 'https://crm.fixture.example'
  })

  type Prepared = {
    em: FakeEm
    clock: Clock & { set: (iso: string) => void }
    fixture: LaunchedFixture
    claimed: GtmSendAttempt
    claimToken: string
    transport: FakeTransport
  }

  async function prepare(
    options: { emails?: number; dailyCap?: number; recipients?: number } = {},
  ): Promise<Prepared> {
    const em = new FakeEm()
    const launchClock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, {
      clock: launchClock,
      recipients: options.recipients ?? 1,
      emails: options.emails ?? 1,
      dailyCap: options.dailyCap,
    })
    const clock = fixedClock(TICK_ISO)
    const claim = await claimDueAttempts(em, ctx, { clock })
    expect(claim.claimed.length).toBeGreaterThan(0)
    return {
      em,
      clock,
      fixture,
      claimed: claim.claimed[0].attempt,
      claimToken: claim.claimed[0].claimToken,
      transport: new FakeTransport(),
    }
  }

  it('mints and DURABLY persists rfc_message_id + provider_started BEFORE transport contact, then accepts', async () => {
    const { em, clock, fixture, claimed, transport } = await prepare()
    let stateAtCall: string | null = null
    let rfcAtCall: string | null = null
    transport.onSend = () => {
      // What the transport sees is the already-persisted durable row.
      stateAtCall = claimed.state
      rfcAtCall = claimed.rfcMessageId ?? null
    }

    const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
    expect(outcome.outcome).toBe('accepted')

    // Rule 3: the durable transition happened before provider contact.
    expect(stateAtCall).toBe('provider_started')
    expect(rfcAtCall).toMatch(/^<[0-9a-f-]{36}@fixture\.example>$/)

    expect(transport.calls).toHaveLength(1)
    const args = transport.calls[0]
    expect(args.from).toBe(SENDER_ADDRESS)
    expect(args.to).toBe(fixture.addressFor(fixture.enrollments[0]))
    expect(args.messageId).toBe(claimed.rfcMessageId)
    expect(args.subject.length).toBeGreaterThan(0)
    expect(args.html.length).toBeGreaterThan(0)

    // Section 8: RFC 8058 one-click headers on every GTM send.
    expect(args.headers['List-Unsubscribe']).toContain(
      `<mailto:${SENDER_ADDRESS}?subject=unsubscribe>`,
    )
    expect(args.headers['List-Unsubscribe']).toContain(
      'https://crm.fixture.example/api/gtm/unsubscribe?token=',
    )
    expect(args.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')

    expect(claimed.state).toBe('accepted')
    expect(claimed.providerMessageId).toBe('provider-1')
    expect(claimed.providerReceipt).toEqual({ response: '250 OK' })
    expect(claimed.sentAt).toBeInstanceOf(Date)
    expect(claimed.acceptedAt).toBeInstanceOf(Date)
  })

  it('a thrown transport error maps to failed (retry would be a NEW attempt row)', async () => {
    const { em, clock, claimed, transport } = await prepare()
    transport.behavior = 'fail'
    const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
    expect(outcome).toMatchObject({ outcome: 'failed' })
    expect(claimed.state).toBe('failed')
    expect(claimed.failureReason).toContain('transport_error')
    expect(claimed.failedAt).toBeInstanceOf(Date)
    // rfc id survives: the provider may have logged the message id.
    expect(claimed.rfcMessageId).toBeTruthy()
  })

  it('a transport timeout maps to ambiguous and is never auto-retried', async () => {
    const { em, clock, claimed, transport } = await prepare()
    transport.behavior = 'timeout'
    const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
    expect(outcome).toMatchObject({ outcome: 'ambiguous' })
    expect(claimed.state).toBe('ambiguous')
    expect(claimed.ambiguousAt).toBeInstanceOf(Date)

    // Rule 4: a later tick never claims (so never re-sends) the row.
    clock.set('2026-07-23T15:00:00.000Z')
    const later = await claimDueAttempts(em, ctx, { clock })
    expect(later.claimed.map((c) => c.attempt.id)).not.toContain(claimed.id)
  })

  describe('pre-send recheck failures (rule 2: explicit failed, transport untouched)', () => {
    it('suppression added mid-flight', async () => {
      const { em, clock, fixture, claimed, transport } = await prepare()
      const address = fixture.addressFor(fixture.enrollments[0])
      em.persist(
        em.create(GtmSuppression, {
          organizationId: ORG,
          tenantId: TENANT,
          scope: 'org',
          channel: 'email',
          addressHash: hashAddress(address),
          reason: 'manual',
        }),
      )
      await em.flush()
      const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
      expect(outcome).toMatchObject({ outcome: 'failed', reason: 'suppressed' })
      expect(claimed.state).toBe('failed')
      expect(claimed.failureReason).toBe('suppressed')
      expect(transport.calls).toHaveLength(0)
    })

    it('enrollment stopped (the atomic-stop marker)', async () => {
      const { em, clock, fixture, claimed, transport } = await prepare()
      fixture.enrollments[0].status = 'stopped'
      fixture.enrollments[0].stopReason = 'manual'
      const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
      expect(outcome).toMatchObject({ outcome: 'failed', reason: 'enrollment_stopped' })
      expect(transport.calls).toHaveLength(0)
    })

    it('campaign version superseded', async () => {
      const { em, clock, fixture, claimed, transport } = await prepare()
      fixture.campaign.currentVersionId = crypto.randomUUID()
      const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
      expect(outcome).toMatchObject({ outcome: 'failed', reason: 'version_superseded' })
      expect(transport.calls).toHaveLength(0)
    })

    it('version invalidated after claim', async () => {
      const { em, clock, fixture, claimed, transport } = await prepare()
      fixture.version.invalidatedAt = new Date()
      fixture.version.invalidatedReason = 'scope_change'
      const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
      expect(outcome).toMatchObject({ outcome: 'failed', reason: 'version_invalidated' })
      expect(transport.calls).toHaveLength(0)
    })

    it('campaign paused', async () => {
      const { em, clock, fixture, claimed, transport } = await prepare()
      fixture.campaign.status = 'paused'
      const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
      expect(outcome).toMatchObject({ outcome: 'failed', reason: 'campaign_not_active' })
      expect(transport.calls).toHaveLength(0)
    })

    it('sender connection deactivated', async () => {
      const { em, clock, fixture, claimed, transport } = await prepare()
      fixture.connection.isActive = false
      const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
      expect(outcome).toMatchObject({ outcome: 'failed', reason: 'sender_inactive' })
      expect(transport.calls).toHaveLength(0)
    })

    it('sender identity or credential generation changed after approval', async () => {
      const { em, clock, fixture, claimed, transport } = await prepare()
      fixture.connection.emailAddress = 'rotated@fixture.example'
      fixture.connection.updatedAt = new Date(fixture.connection.updatedAt.getTime() + 1000)
      const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
      expect(outcome).toMatchObject({ outcome: 'failed', reason: 'sender_changed' })
      expect(transport.calls).toHaveLength(0)
    })

    it('approved contact point cannot silently switch to another address', async () => {
      const { em, clock, fixture, claimed, transport } = await prepare()
      const point = (await em.find(GtmContactPoint, {
        candidateId: fixture.enrollments[0].candidateId,
        verificationState: 'verified',
      }))[0]
      point.value = 'changed-address@fixture.example'
      const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
      expect(outcome).toMatchObject({ outcome: 'failed', reason: 'recipient_changed' })
      expect(transport.calls).toHaveLength(0)
    })

    it('a late legacy unsubscribe is enforced inside the claimed send', async () => {
      const { em, clock, fixture, claimed, transport } = await prepare()
      em.persist(em.create(EmailUnsubscribe, {
        tenantId: TENANT,
        organizationId: ORG,
        email: fixture.addressFor(fixture.enrollments[0]).toUpperCase(),
      }))
      await em.flush()
      const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
      expect(outcome).toMatchObject({ outcome: 'failed', reason: 'legacy_unsubscribe' })
      expect(transport.calls).toHaveLength(0)
    })

    it('play no longer executable (strategy_only fails closed at the send boundary)', async () => {
      const { em, clock, fixture, claimed, transport } = await prepare()
      fixture.play.geography = 'Berlin, Germany'
      const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
      expect(outcome).toMatchObject({ outcome: 'failed', reason: 'play_not_executable' })
      expect(transport.calls).toHaveLength(0)
    })

    it('a manual-task-shaped row cannot enter the email executor', async () => {
      const { em, clock, claimed, transport } = await prepare()
      claimed.renderedMessageId = null
      claimed.mailboxConnectionId = null
      const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
      expect(outcome).toMatchObject({ outcome: 'failed', reason: 'attempt_binding_missing' })
      expect(transport.calls).toHaveLength(0)
    })

    it('daily cap reached for the mailbox within the send-window day', async () => {
      const { em, clock, claimed, transport } = await prepare({ dailyCap: 1 })
      // A send already went out from this mailbox today.
      em.persist(
        em.create(GtmSendAttempt, {
          organizationId: ORG,
          tenantId: TENANT,
          enrollmentId: crypto.randomUUID(),
          stepId: crypto.randomUUID(),
          renderedMessageId: crypto.randomUUID(),
          campaignVersionId: crypto.randomUUID(),
          mailboxConnectionId: MAILBOX,
          state: 'accepted',
          fence: 1,
          attemptNo: 1,
          idempotencyKey: 'send:prior:today:1',
          sentAt: clock.now(),
        }),
      )
      await em.flush()
      const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
      expect(outcome).toMatchObject({ outcome: 'failed', reason: 'daily_cap_reached' })
      expect(transport.calls).toHaveLength(0)
    })

    it('a send that already happened YESTERDAY does not consume today\'s cap', async () => {
      const { em, clock, claimed, transport } = await prepare({ dailyCap: 1 })
      em.persist(
        em.create(GtmSendAttempt, {
          organizationId: ORG,
          tenantId: TENANT,
          enrollmentId: crypto.randomUUID(),
          stepId: crypto.randomUUID(),
          renderedMessageId: crypto.randomUUID(),
          campaignVersionId: crypto.randomUUID(),
          mailboxConnectionId: MAILBOX,
          state: 'accepted',
          fence: 1,
          attemptNo: 1,
          idempotencyKey: 'send:prior:yesterday:1',
          sentAt: new Date('2026-07-21T16:00:00.000Z'),
        }),
      )
      await em.flush()
      const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
      expect(outcome.outcome).toBe('accepted')
    })
  })

  it('substitutes the per-enrollment unsubscribe URL on the outbound COPY; the frozen row keeps the token', async () => {
    const { em, clock, claimed, transport } = await prepare()
    const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
    expect(outcome.outcome).toBe('accepted')

    // The transport received a real https URL in both bodies, no token left.
    const args = transport.calls[0]
    const urlPattern = /https:\/\/crm\.fixture\.example\/api\/gtm\/unsubscribe\?token=/
    expect(args.html).toMatch(urlPattern)
    expect(args.text).toMatch(urlPattern)
    expect(args.html).not.toContain(UNSUBSCRIBE_URL_TOKEN)
    expect(args.text).not.toContain(UNSUBSCRIBE_URL_TOKEN)

    // The stored rendered row is untouched: token still present and the
    // frozen content hash still verifies over the stored body.
    const stored = (await em.findOne(GtmRenderedMessage, { id: claimed.renderedMessageId }))!
    expect(stored.bodyHtml).toContain(UNSUBSCRIBE_URL_TOKEN)
    expect(stored.bodyText).toContain(UNSUBSCRIBE_URL_TOKEN)
    expect(stored.bodyHtml).not.toMatch(urlPattern)
    expect(messageContentHash(stored.subject ?? '', stored.bodyHtml ?? '')).toBe(
      stored.contentHash,
    )

    // The frozen footer carries the org postal address end to end.
    expect(args.text).toContain('Fresno, CA')
  })

  it('postal address cleared after approval fails the pre-send recheck (defense in depth)', async () => {
    const { em, clock, claimed, transport } = await prepare()
    const workspace = (await em.findOne(GtmWorkspace, {
      organizationId: ORG,
      tenantId: TENANT,
    }))!
    workspace.settings = {}
    const outcome = await executeClaimedAttempt(em, ctx, claimed, { transport, clock })
    expect(outcome).toMatchObject({ outcome: 'failed', reason: 'postal_address_changed' })
    expect(claimed.state).toBe('failed')
    expect(claimed.failureReason).toBe('postal_address_changed')
    expect(transport.calls).toHaveLength(0)
  })

  it('a delayed writer with a stale claim token/fence is fenced out everywhere', async () => {
    const { em, clock, claimed, transport } = await prepare()

    // The first executor stalls; its lease lapses and a second claimer takes
    // over (fence bump, new token). The stale executor still holds its OLD
    // snapshot of the row (cloned here because the fake identity map would
    // otherwise show it the reclaimed values a real stale worker never sees).
    const staleSnapshot = Object.assign(new GtmSendAttempt(), claimed)
    clock.set('2026-07-22T16:41:00.000Z')
    const reclaim = await claimDueAttempts(em, ctx, { clock })
    expect(reclaim.claimed).toHaveLength(1)
    const freshToken = reclaim.claimed[0].claimToken

    const outcome = await executeClaimedAttempt(em, ctx, staleSnapshot, { transport, clock })
    expect(outcome).toMatchObject({ outcome: 'fenced' })
    // The stale writer touched nothing: no transport call, and the row still
    // belongs to the new claimant.
    expect(transport.calls).toHaveLength(0)
    expect(claimed.state).toBe('claimed')
    expect(claimed.claimToken).toBe(freshToken)
    expect(claimed.fence).toBe(2)
    expect(claimed.rfcMessageId).toBeNull()
  })

  it('rejects execution of a row that is not held under a claim', async () => {
    const { em, clock, claimed, transport, fixture } = await prepare({ emails: 2 })
    const unclaimed = (
      await em.find(GtmSendAttempt, { campaignVersionId: fixture.version.id, state: 'approved' })
    )[0]
    expect(unclaimed).toBeDefined()
    await expect(
      executeClaimedAttempt(em, ctx, unclaimed, { transport, clock }),
    ).rejects.toMatchObject({ code: 'attempt_not_claimed' })
    expect(transport.calls).toHaveLength(0)
    void claimed
  })
})
