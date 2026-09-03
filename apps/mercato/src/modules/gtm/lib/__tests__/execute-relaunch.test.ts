import { FakeEm } from './support/fake-em'
import { ctx } from './support/campaign-fixtures'
import { FakeTransport, LAUNCH_ISO, fixedClock, seedLaunchedCampaign } from './support/execution-fixtures'
import { approveCampaign, computeDraftState, invalidateCurrentVersion, updateCampaignTemplate } from '../campaign/approve'
import { claimDueAttempts } from '../execute/claim'
import { executeClaimedAttempt } from '../execute/send'
import { launchCampaign } from '../execute/schedule'
import { GtmAuditEvent, GtmSendAttempt } from '../../data/entities'

const TICK_ISO = '2026-07-22T16:30:00.000Z'

/*
 * Review M1: launch -> partial send -> invalidate -> re-approve -> relaunch
 * used to strand every not-yet-sent step. The stable idempotency key already
 * existed, bound to the superseded version, so materialization created
 * nothing and the executor then failed each row 'version_superseded'.
 */
describe('relaunch after invalidation (SPEC-066 section 6, review M1)', () => {
  beforeAll(() => {
    process.env.GTM_UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret'
    process.env.GTM_UNSUBSCRIBE_KEYRING = JSON.stringify({ test: 'test-unsubscribe-secret' })
    process.env.GTM_UNSUBSCRIBE_ACTIVE_KEY_ID = 'test'
    process.env.GTM_PUBLIC_BASE_URL = 'https://crm.fixture.example'
  })

  it('sends the remainder exactly once after invalidate -> approve -> relaunch', async () => {
    const em = new FakeEm()
    const launchClock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, { clock: launchClock, recipients: 3, emails: 1 })
    expect(fixture.attempts).toHaveLength(3)
    const transport = new FakeTransport()
    const clock = fixedClock(TICK_ISO)

    // Partial send: exactly one of the three step-1 mails goes out.
    const firstClaim = await claimDueAttempts(em, ctx, { clock, limit: 1 })
    expect(firstClaim.claimed).toHaveLength(1)
    const sentAttempt = firstClaim.claimed[0].attempt
    expect((await executeClaimedAttempt(em, ctx, sentAttempt, { transport, clock })).outcome).toBe('accepted')
    expect(transport.calls).toHaveLength(1)

    // Fix a typo: invalidate, edit, re-approve (new version + steps), relaunch.
    // The body is kept (it satisfies the quality envelope); only the subject
    // changes, which is enough to prove the corrected copy ships.
    await invalidateCurrentVersion(em, ctx, fixture.campaign.id, 'typo')
    const before = await computeDraftState(em, ctx, fixture.campaign)
    await updateCampaignTemplate(em, ctx, fixture.campaign.id, {
      subject: `${before.template.subject} (fixed)`,
      body: before.template.body,
    })
    const draft = await computeDraftState(em, ctx, fixture.campaign)
    const approved = await approveCampaign(em, ctx, {
      campaignId: fixture.campaign.id,
      expectedContentHash: draft.contentHash,
    })
    expect(approved.version.id).not.toBe(fixture.version.id)
    const relaunch = await launchCampaign(
      em,
      ctx,
      { campaignId: fixture.campaign.id, expectedContentHash: approved.version.contentHash },
      { clock: launchClock },
    )
    expect(relaunch.campaign.status).toBe('active')

    // No duplicate rows were minted: the two unsent rows were re-pointed at
    // the new version with a bumped fence; the sent row is untouched.
    const attempts = await em.find(GtmSendAttempt, { organizationId: ctx.organizationId })
    expect(attempts).toHaveLength(3)
    const sent = attempts.find((row) => row.id === sentAttempt.id)!
    expect(sent).toMatchObject({ state: 'accepted', campaignVersionId: fixture.version.id })
    const remainder = attempts.filter((row) => row.id !== sentAttempt.id)
    for (const row of remainder) {
      expect(row).toMatchObject({ state: 'approved', campaignVersionId: approved.version.id, fence: 1 })
      expect(row.renderedMessageId).not.toBeNull()
    }
    const launchAudit = (await em.find(GtmAuditEvent, { action: 'gtm.campaign.launched' })).at(-1)!
    expect(launchAudit.metadata).toMatchObject({ attempts_repointed: 2, attempts_created: 0, attempts_existing: 1 })

    // The remainder is sendable exactly once: two more sends, then nothing.
    const secondClaim = await claimDueAttempts(em, ctx, { clock, limit: 10 })
    expect(secondClaim.claimed.map((row) => row.attempt.id).sort()).toEqual(
      remainder.map((row) => row.id).sort(),
    )
    for (const claimed of secondClaim.claimed) {
      expect((await executeClaimedAttempt(em, ctx, claimed.attempt, { transport, clock })).outcome).toBe('accepted')
    }
    expect(transport.calls).toHaveLength(3)
    expect(new Set(transport.calls.map((call) => call.to)).size).toBe(3)
    // Corrected copy shipped for the remainder, original for the first.
    expect(transport.calls[1].subject).toContain('(fixed)')
    expect(transport.calls[0].subject).not.toContain('(fixed)')

    const thirdClaim = await claimDueAttempts(em, ctx, { clock, limit: 10 })
    expect(thirdClaim.claimed).toHaveLength(0)
    // A second relaunch is idempotent: nothing created, nothing re-pointed.
    const again = await launchCampaign(
      em,
      ctx,
      { campaignId: fixture.campaign.id, expectedContentHash: approved.version.contentHash },
      { clock: launchClock },
    )
    expect(again.alreadyLaunched).toBe(true)
    expect(await em.find(GtmSendAttempt, { organizationId: ctx.organizationId })).toHaveLength(3)
  })

  it('mints attempt_no 2 for a step that failed version_superseded in the draft window', async () => {
    const em = new FakeEm()
    const launchClock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, { clock: launchClock, recipients: 1, emails: 1 })
    const transport = new FakeTransport()
    const clock = fixedClock(TICK_ISO)

    // A tick that ran during the draft window failed the row pre-dispatch.
    await invalidateCurrentVersion(em, ctx, fixture.campaign.id, 'typo')
    const claim = await claimDueAttempts(em, ctx, { clock, limit: 1 })
    expect(claim.claimed).toHaveLength(1)
    const outcome = await executeClaimedAttempt(em, ctx, claim.claimed[0].attempt, { transport, clock })
    expect(outcome).toMatchObject({ outcome: 'failed', reason: 'campaign_not_active' })
    expect(transport.calls).toHaveLength(0)

    const draft = await computeDraftState(em, ctx, fixture.campaign)
    const approved = await approveCampaign(em, ctx, {
      campaignId: fixture.campaign.id,
      expectedContentHash: draft.contentHash,
    })
    await launchCampaign(
      em,
      ctx,
      { campaignId: fixture.campaign.id, expectedContentHash: approved.version.contentHash },
      { clock: launchClock },
    )
    const attempts = await em.find(GtmSendAttempt, { organizationId: ctx.organizationId })
    expect(attempts).toHaveLength(2)
    const fresh = attempts.find((row) => row.attemptNo === 2)!
    expect(fresh).toMatchObject({ state: 'approved', campaignVersionId: approved.version.id })
    expect(fresh.idempotencyKey.endsWith(':2')).toBe(true)

    const second = await claimDueAttempts(em, ctx, { clock, limit: 10 })
    expect(second.claimed).toHaveLength(1)
    expect((await executeClaimedAttempt(em, ctx, second.claimed[0].attempt, { transport, clock })).outcome).toBe('accepted')
    expect(transport.calls).toHaveLength(1)
    expect((await claimDueAttempts(em, ctx, { clock, limit: 10 })).claimed).toHaveLength(0)
  })

  it('never re-points a row a stop deliberately failed', async () => {
    const em = new FakeEm()
    const launchClock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, { clock: launchClock, recipients: 1, emails: 1 })
    const attempt = fixture.attempts[0]
    attempt.state = 'failed'
    attempt.failureReason = 'stopped'
    await invalidateCurrentVersion(em, ctx, fixture.campaign.id, 'typo')
    const draft = await computeDraftState(em, ctx, fixture.campaign)
    const approved = await approveCampaign(em, ctx, {
      campaignId: fixture.campaign.id,
      expectedContentHash: draft.contentHash,
    })
    await launchCampaign(
      em,
      ctx,
      { campaignId: fixture.campaign.id, expectedContentHash: approved.version.contentHash },
      { clock: launchClock },
    )
    const attempts = await em.find(GtmSendAttempt, { organizationId: ctx.organizationId })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ state: 'failed', failureReason: 'stopped', campaignVersionId: fixture.version.id })
  })
})
