import { GtmAuditEvent, GtmSendAttempt } from '../../data/entities'
import { claimDueAttempts } from '../execute/claim'
import { transitionCampaignLifecycle } from '../execute/lifecycle'
import { executeClaimedAttempt } from '../execute/send'
import { FakeEm } from './support/fake-em'
import { ctx } from './support/campaign-fixtures'
import {
  FakeTransport,
  LAUNCH_ISO,
  fixedClock,
  seedLaunchedCampaign,
} from './support/execution-fixtures'

const CONTROL_ISO = '2026-07-22T16:20:00.000Z'

describe('GTM campaign lifecycle controls', () => {
  it('pauses, resumes, and stops only not-started work with exact hash binding', async () => {
    const em = new FakeEm()
    const fixture = await seedLaunchedCampaign(em, {
      clock: fixedClock(LAUNCH_ISO),
      recipients: 1,
      emails: 2,
    })
    const clock = fixedClock(CONTROL_ISO)
    const paused = await transitionCampaignLifecycle(em, ctx, {
      campaignId: fixture.campaign.id,
      expectedContentHash: fixture.version.contentHash,
      action: 'pause',
    }, { clock })
    expect(paused).toMatchObject({
      alreadyInState: false,
      attemptsChanged: 2,
      enrollmentsStopped: 0,
    })
    expect(fixture.campaign.status).toBe('paused')
    expect(fixture.attempts.every((row) => row.state === 'paused' && row.fence === 1)).toBe(true)
    expect(fixture.attempts.every((row) => row.capacitySlotKey == null)).toBe(true)

    const replay = await transitionCampaignLifecycle(em, ctx, {
      campaignId: fixture.campaign.id,
      expectedContentHash: fixture.version.contentHash,
      action: 'pause',
    }, { clock })
    expect(replay.alreadyInState).toBe(true)
    expect(replay.attemptsChanged).toBe(0)

    const resumed = await transitionCampaignLifecycle(em, ctx, {
      campaignId: fixture.campaign.id,
      expectedContentHash: fixture.version.contentHash,
      action: 'resume',
    }, { clock })
    expect(resumed.attemptsChanged).toBe(2)
    expect(fixture.campaign.status).toBe('active')
    expect(fixture.attempts.every((row) => row.state === 'approved' && row.fence === 2)).toBe(true)

    fixture.attempts[0].state = 'provider_started'
    fixture.attempts[0].claimToken = 'provider-started-token'
    const stopped = await transitionCampaignLifecycle(em, ctx, {
      campaignId: fixture.campaign.id,
      expectedContentHash: fixture.version.contentHash,
      action: 'stop',
    }, { clock })
    expect(stopped).toMatchObject({ attemptsChanged: 1, enrollmentsStopped: 1 })
    expect(fixture.campaign.status).toBe('stopped')
    expect(fixture.enrollments[0]).toMatchObject({
      status: 'stopped',
      stopReason: 'campaign_stopped',
    })
    expect(fixture.attempts[0].state).toBe('provider_started')
    expect(fixture.attempts[1]).toMatchObject({
      state: 'failed',
      failureReason: 'campaign_stopped',
      fence: 3,
    })
    expect(em.table(GtmAuditEvent).filter((row) =>
      ['gtm.campaign.paused', 'gtm.campaign.resumed', 'gtm.campaign.stopped'].includes(row.action),
    )).toHaveLength(3)
  })

  it('rejects stale approval and foreign scope without mutation', async () => {
    const em = new FakeEm()
    const fixture = await seedLaunchedCampaign(em, {
      clock: fixedClock(LAUNCH_ISO),
      recipients: 1,
      emails: 1,
    })
    await expect(transitionCampaignLifecycle(em, ctx, {
      campaignId: fixture.campaign.id,
      expectedContentHash: '0'.repeat(64),
      action: 'pause',
    })).rejects.toMatchObject({ code: 'stale_approval' })
    await expect(transitionCampaignLifecycle(em, {
      ...ctx,
      tenantId: '00000000-0000-4000-8000-000000000099',
    }, {
      campaignId: fixture.campaign.id,
      expectedContentHash: fixture.version.contentHash,
      action: 'stop',
    })).rejects.toMatchObject({ code: 'campaign_not_found' })
    expect(fixture.campaign.status).toBe('active')
  })

  it('fences an already claimed attempt when pause wins before execution', async () => {
    const em = new FakeEm()
    const fixture = await seedLaunchedCampaign(em, {
      clock: fixedClock(LAUNCH_ISO),
      recipients: 1,
      emails: 1,
    })
    const clock = fixedClock(CONTROL_ISO)
    const claim = await claimDueAttempts(em, ctx, { clock })
    const claimed = claim.claimed[0].attempt
    await transitionCampaignLifecycle(em, ctx, {
      campaignId: fixture.campaign.id,
      expectedContentHash: fixture.version.contentHash,
      action: 'pause',
    }, { clock })
    const transport = new FakeTransport()
    await expect(executeClaimedAttempt(em, ctx, claimed, { transport, clock }))
      .resolves.toEqual({ outcome: 'fenced', attemptId: claimed.id })
    expect(transport.calls).toHaveLength(0)
    expect(em.table(GtmSendAttempt)[0].state).toBe('paused')
  })
})
