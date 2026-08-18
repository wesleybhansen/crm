import { FakeEm } from './support/fake-em'
import { ctx } from './support/campaign-fixtures'
import {
  FakeTransport,
  LAUNCH_ISO,
  fixedClock,
  seedLaunchedCampaign,
  type LaunchedFixture,
} from './support/execution-fixtures'
import { claimDueAttempts } from '../execute/claim'
import { executeClaimedAttempt } from '../execute/send'
import type { Clock } from '../execute/schedule'
import { buildTaskKey, markTask } from '../social/tasks'
import { TIMELINE_CAP, getCampaignTimeline } from '../timeline'
import { GtmReply, GtmStep } from '../../data/entities'

const TICK_ISO = '2026-07-22T16:30:00.000Z'
const MARK_ISO = '2026-07-22T17:00:00.000Z'
const REPLY_ISO = '2026-07-22T18:00:00.000Z'

type TimelineFixture = {
  em: FakeEm
  clock: Clock & { set: (iso: string) => void }
  fixture: LaunchedFixture
  connectKey: string
}

async function timelineFixture(recipients = 1): Promise<TimelineFixture> {
  const em = new FakeEm()
  const clock = fixedClock(LAUNCH_ISO)
  const fixture = await seedLaunchedCampaign(em, {
    clock,
    recipients,
    emails: 2,
    linkedin: true,
  })
  const connectStep = fixture.steps.find(
    (step: GtmStep) =>
      ((step.sendWindow ?? {}) as Record<string, unknown>).social_action === 'connection_request',
  )!
  return {
    em,
    clock,
    fixture,
    connectKey: buildTaskKey(fixture.version.id, fixture.enrollments[0].id, connectStep.id),
  }
}

describe('getCampaignTimeline (SPEC-066 Tranche 7)', () => {
  it('merges email attempts, manual tasks, replies, and stop events chronologically', async () => {
    const s = await timelineFixture()

    // Execute the day-0 email.
    s.clock.set(TICK_ISO)
    const claim = await claimDueAttempts(s.em, ctx, { clock: s.clock })
    expect(claim.claimed).toHaveLength(1)
    const transport = new FakeTransport()
    await executeClaimedAttempt(s.em, ctx, claim.claimed[0].attempt, {
      transport,
      clock: s.clock,
    })

    // Record the connection request as sent by the user.
    s.clock.set(MARK_ISO)
    await markTask(s.em, ctx, { taskKey: s.connectKey, outcome: 'requested' }, { clock: s.clock })

    let timeline = await getCampaignTimeline(s.em, ctx, { campaignId: s.fixture.campaign.id })
    let types = timeline.entries.map((entry) => entry.type)
    expect(types).toContain('email_attempt')
    expect(types).toContain('manual_task')
    // 2 email attempts + 2 manual tasks (connect recorded, follow-up pending).
    expect(timeline.entries.filter((entry) => entry.type === 'email_attempt')).toHaveLength(2)
    expect(timeline.entries.filter((entry) => entry.type === 'manual_task')).toHaveLength(2)
    // Every manual task rides the truth rule into the feed.
    for (const entry of timeline.entries.filter((row) => row.type === 'manual_task')) {
      expect(entry.detail.recorded_by).toBe('user')
    }

    // Chronological: timestamps are non-decreasing (nulls sort last).
    const stamps = timeline.entries
      .map((entry) => entry.at)
      .filter((at): at is string => at !== null)
      .map((at) => Date.parse(at))
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i]).toBeGreaterThanOrEqual(stamps[i - 1])
    }
    // The executed email (16:30) sorts before the recorded task (17:00).
    const sentIdx = timeline.entries.findIndex(
      (entry) => entry.type === 'email_attempt' && entry.detail.state === 'accepted',
    )
    const taskIdx = timeline.entries.findIndex(
      (entry) => entry.type === 'manual_task' && entry.detail.state === 'task_requested',
    )
    expect(sentIdx).toBeGreaterThanOrEqual(0)
    expect(taskIdx).toBeGreaterThan(sentIdx)

    // The user records a social reply: atomic stop, then the feed shows the
    // reply and the stop event, and pending items surface as cancelled.
    s.clock.set(REPLY_ISO)
    await markTask(s.em, ctx, { taskKey: s.connectKey, outcome: 'replied' }, { clock: s.clock })

    timeline = await getCampaignTimeline(s.em, ctx, { campaignId: s.fixture.campaign.id })
    types = timeline.entries.map((entry) => entry.type)
    expect(types).toContain('reply')
    expect(types).toContain('event')
    const stopEvent = timeline.entries.find(
      (entry) => entry.type === 'event' && entry.detail.action === 'gtm.reply.recorded',
    )
    expect(stopEvent).toBeDefined()
    const reply = timeline.entries.find((entry) => entry.type === 'reply')!
    expect(reply.detail.channel).toBe('linkedin')
    // The cancelled day-3 email shows its truthful state.
    const cancelled = timeline.entries.find(
      (entry) => entry.type === 'email_attempt' && entry.detail.failure_reason === 'stopped',
    )
    expect(cancelled).toBeDefined()
    // Stopped enrollment: manual tasks are hidden from the feed too.
    expect(timeline.entries.filter((entry) => entry.type === 'manual_task')).toHaveLength(0)
  })

  it('narrows to one enrollment and rejects foreign enrollment ids', async () => {
    const s = await timelineFixture(2)
    const [first, second] = s.fixture.enrollments
    const timeline = await getCampaignTimeline(s.em, ctx, {
      campaignId: s.fixture.campaign.id,
      enrollmentId: first.id,
    })
    expect(timeline.enrollment_id).toBe(first.id)
    expect(timeline.entries.length).toBeGreaterThan(0)
    for (const entry of timeline.entries) {
      expect(entry.enrollment_id).toBe(first.id)
    }
    expect(timeline.entries.some((entry) => entry.enrollment_id === second.id)).toBe(false)

    await expect(
      getCampaignTimeline(s.em, ctx, {
        campaignId: s.fixture.campaign.id,
        enrollmentId: 'ffffffff-0000-4000-8000-000000000000',
      }),
    ).rejects.toMatchObject({ code: 'enrollment_not_found' })
  })

  it('caps the merged feed at 200 entries, keeping the most recent', async () => {
    const s = await timelineFixture()
    const enrollment = s.fixture.enrollments[0]
    // Flood the feed with reply rows (cheapest entry source).
    const base = Date.parse('2026-07-23T00:00:00.000Z')
    for (let i = 0; i < 210; i += 1) {
      s.em.persist(
        s.em.create(GtmReply, {
          organizationId: enrollment.organizationId,
          tenantId: enrollment.tenantId,
          enrollmentId: enrollment.id,
          channel: 'email',
          direction: 'inbound',
          createdAt: new Date(base + i * 60_000),
        }),
      )
    }
    await s.em.flush()

    const timeline = await getCampaignTimeline(s.em, ctx, { campaignId: s.fixture.campaign.id })
    expect(timeline.entries).toHaveLength(TIMELINE_CAP)
    expect(timeline.truncated).toBe(true)
    expect(timeline.total).toBeGreaterThan(TIMELINE_CAP)
    // The oldest entries fell off; the newest reply survived.
    const newest = new Date(base + 209 * 60_000).toISOString()
    expect(timeline.entries.some((entry) => entry.at === newest)).toBe(true)
  })
})
