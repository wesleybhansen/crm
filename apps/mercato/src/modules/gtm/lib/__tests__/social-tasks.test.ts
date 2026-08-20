import { FakeEm } from './support/fake-em'
import { WORKSPACE, ctx, seedCandidate, seedPlay, seedRun } from './support/campaign-fixtures'
import {
  LAUNCH_ISO,
  fixedClock,
  seedLaunchedCampaign,
  type LaunchedFixture,
} from './support/execution-fixtures'
import { createCampaign } from '../campaign/build'
import { approveCampaign, computeDraftState, updateCampaignTemplate } from '../campaign/approve'
import { claimDueAttempts } from '../execute/claim'
import type { Clock } from '../execute/schedule'
import {
  DEPENDENCY_OVERRIDE_ACTION,
  TASK_MARKED_ACTION,
  buildTaskKey,
  listManualTasks,
  markTask,
  overrideTaskDependency,
} from '../social/tasks'
import {
  GtmAuditEvent,
  GtmReply,
  GtmSendAttempt,
  GtmStep,
} from '../../data/entities'

const MARK_ISO = '2026-07-22T17:00:00.000Z'

type SocialFixture = {
  em: FakeEm
  clock: Clock & { set: (iso: string) => void }
  fixture: LaunchedFixture
  connectStep: GtmStep
  followupStep: GtmStep
  connectKey: string
  followupKey: string
}

async function socialFixture(): Promise<SocialFixture> {
  const em = new FakeEm()
  const clock = fixedClock(LAUNCH_ISO)
  const fixture = await seedLaunchedCampaign(em, {
    clock,
    recipients: 1,
    emails: 2,
    linkedin: true,
  })
  const socialAction = (step: GtmStep) =>
    ((step.sendWindow ?? {}) as Record<string, unknown>).social_action
  const connectStep = fixture.steps.find((step) => socialAction(step) === 'connection_request')!
  const followupStep = fixture.steps.find((step) => socialAction(step) === 'followup')!
  const enrollment = fixture.enrollments[0]
  clock.set(MARK_ISO)
  return {
    em,
    clock,
    fixture,
    connectStep,
    followupStep,
    connectKey: buildTaskKey(fixture.version.id, enrollment.id, connectStep.id),
    followupKey: buildTaskKey(fixture.version.id, enrollment.id, followupStep.id),
  }
}

describe('manual social tasks (SPEC-066 section 10, Tranche 7)', () => {
  it('derives one task per manual step x active enrollment from the approved version', async () => {
    const s = await socialFixture()
    const result = await listManualTasks(s.em, ctx, { campaignId: s.fixture.campaign.id })

    expect(result.campaignVersionId).toBe(s.fixture.version.id)
    expect(result.tasks).toHaveLength(2)

    const connect = result.tasks.find((task) => task.task_key === s.connectKey)!
    const followup = result.tasks.find((task) => task.task_key === s.followupKey)!

    expect(connect.state).toBe('task_pending')
    expect(connect.channel).toBe('linkedin')
    expect(connect.social_action).toBe('connection_request')
    expect(connect.locked).toBe(false)
    expect(connect.enrollment_id).toBe(s.fixture.enrollments[0].id)

    // Connect-first: the follow-up is locked until the connection request is
    // recorded as accepted.
    expect(followup.locked).toBe(true)
    expect(followup.lock_reason).toBe('awaiting_connection_accepted')
    expect(followup.depends_on_task_key).toBe(s.connectKey)

    // The exact approved message copy rides along (frozen template).
    expect(connect.message.subject).toContain('Quick question')
    expect(connect.message.body).toBeTruthy()
  })

  it('truth rule: every serialized task is recorded_by user and carries no synchronized/auto flag', async () => {
    const s = await socialFixture()
    await markTask(
      s.em,
      ctx,
      { taskKey: s.connectKey, outcome: 'requested' },
      { clock: s.clock },
    )
    const { tasks } = await listManualTasks(s.em, ctx, { campaignId: s.fixture.campaign.id })
    expect(tasks.length).toBeGreaterThan(0)
    for (const task of tasks) {
      expect(task.recorded_by).toBe('user')
      for (const key of Object.keys(task)) {
        expect(key).not.toMatch(/sync|synchronized|automated|auto_/i)
      }
      const serialized = JSON.stringify(task)
      expect(serialized).not.toContain('synchronized')
      expect(serialized).not.toContain('"synced"')
    }
  })

  it('a campaign without an approved current version has no tasks', async () => {
    const s = await socialFixture()
    await updateCampaignTemplate(s.em, ctx, s.fixture.campaign.id, {
      subject: 'Edited subject',
      body: 'Edited body',
    })
    const result = await listManualTasks(s.em, ctx, { campaignId: s.fixture.campaign.id })
    expect(result.campaignVersionId).toBeNull()
    expect(result.tasks).toHaveLength(0)
    // Marking against the invalidated version is refused.
    await expect(
      markTask(s.em, ctx, { taskKey: s.connectKey, outcome: 'sent' }, { clock: s.clock }),
    ).rejects.toMatchObject({ code: 'stale_version' })
  })

  it('GUARD: the email claimer never touches task:* rows, even when they look due', async () => {
    const s = await socialFixture()
    await markTask(
      s.em,
      ctx,
      { taskKey: s.connectKey, outcome: 'requested' },
      { clock: s.clock },
    )
    const taskRow = (await s.em.find(GtmSendAttempt, { idempotencyKey: s.connectKey }))[0]
    expect(taskRow).toBeDefined()
    // Adversarial: give the task row a long-past due time. The claimer must
    // still ignore it because task_* states are outside its allowlist.
    taskRow.scheduledFor = new Date('2020-01-01T00:00:00.000Z')

    // Far future: every email attempt of the version is due.
    s.clock.set('2026-08-31T15:00:00.000Z')
    const claim = await claimDueAttempts(s.em, ctx, { clock: s.clock, limit: 100 })

    expect(claim.claimed.length).toBeGreaterThan(0)
    for (const claimed of claim.claimed) {
      expect(claimed.attempt.idempotencyKey.startsWith('send:')).toBe(true)
      expect(claimed.attempt.idempotencyKey.startsWith('task:')).toBe(false)
    }
    // The task row is untouched: same user-recorded state, no claim, no fence.
    expect(taskRow.state).toBe('task_requested')
    expect(taskRow.claimToken).toBeNull()
    expect(taskRow.fence).toBe(0)
  })

  it('connect-first: the follow-up rejects marks until the connection is accepted', async () => {
    const s = await socialFixture()

    await expect(
      markTask(s.em, ctx, { taskKey: s.followupKey, outcome: 'sent' }, { clock: s.clock }),
    ).rejects.toMatchObject({ code: 'task_locked' })

    // 'requested' is not enough.
    await markTask(s.em, ctx, { taskKey: s.connectKey, outcome: 'requested' }, { clock: s.clock })
    await expect(
      markTask(s.em, ctx, { taskKey: s.followupKey, outcome: 'sent' }, { clock: s.clock }),
    ).rejects.toMatchObject({ code: 'task_locked' })

    // 'accepted' unlocks.
    await markTask(s.em, ctx, { taskKey: s.connectKey, outcome: 'accepted' }, { clock: s.clock })
    const listed = await listManualTasks(s.em, ctx, { campaignId: s.fixture.campaign.id })
    const followup = listed.tasks.find((task) => task.task_key === s.followupKey)!
    expect(followup.locked).toBe(false)

    const marked = await markTask(
      s.em,
      ctx,
      { taskKey: s.followupKey, outcome: 'sent', note: 'sent the DM' },
      { clock: s.clock },
    )
    expect(marked.state).toBe('task_sent')
    const taskRow = await s.em.findOne(GtmSendAttempt, {
      organizationId: ctx.organizationId,
      idempotencyKey: s.followupKey,
    })
    expect(taskRow?.renderedMessageId).toBeNull()
    expect(taskRow?.mailboxConnectionId).toBeNull()

    const audits = await s.em.find(GtmAuditEvent, { action: TASK_MARKED_ACTION })
    expect(audits.length).toBeGreaterThanOrEqual(3)
    const followupAudit = audits.find(
      (event) => (event.metadata as Record<string, unknown>)?.task_key === s.followupKey,
    )
    expect(followupAudit).toBeDefined()
    expect((followupAudit!.metadata as Record<string, unknown>).outcome).toBe('sent')
  })

  it('an explicit dependency override records an audit event and unlocks the task', async () => {
    const s = await socialFixture()
    const result = await overrideTaskDependency(s.em, ctx, {
      taskKey: s.followupKey,
      reason: 'already connected outside the campaign',
    })
    expect(result.overridden).toBe(true)
    expect(result.alreadyOverridden).toBe(false)

    const audits = await s.em.find(GtmAuditEvent, { action: DEPENDENCY_OVERRIDE_ACTION })
    expect(audits).toHaveLength(1)
    const metadata = audits[0].metadata as Record<string, unknown>
    expect(metadata.task_key).toBe(s.followupKey)
    expect(metadata.reason).toBe('already connected outside the campaign')

    const listed = await listManualTasks(s.em, ctx, { campaignId: s.fixture.campaign.id })
    const followup = listed.tasks.find((task) => task.task_key === s.followupKey)!
    expect(followup.locked).toBe(false)
    expect(followup.dependency_overridden).toBe(true)

    // Marking now works; the second override is idempotent.
    await markTask(s.em, ctx, { taskKey: s.followupKey, outcome: 'sent' }, { clock: s.clock })
    const again = await overrideTaskDependency(s.em, ctx, {
      taskKey: s.followupKey,
      reason: 'again',
    })
    expect(again.alreadyOverridden).toBe(true)
    expect(await s.em.find(GtmAuditEvent, { action: DEPENDENCY_OVERRIDE_ACTION })).toHaveLength(1)
  })

  it("'requested'/'accepted' are rejected on non-connection tasks", async () => {
    const em = new FakeEm()
    const play = await seedPlay(em)
    const run = await seedRun(em, play)
    await seedCandidate(em, run)
    const { campaign } = await createCampaign(em, ctx, {
      workspaceId: WORKSPACE,
      playId: play.id,
      name: 'X DM campaign',
      channelMix: { emails: 1, x: true },
    })
    const draft = await computeDraftState(em, ctx, campaign)
    const approved = await approveCampaign(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: draft.contentHash,
    })
    const listed = await listManualTasks(em, ctx, { campaignId: campaign.id })
    expect(listed.tasks).toHaveLength(1)
    const dmTask = listed.tasks[0]
    expect(dmTask.channel).toBe('x')
    expect(dmTask.social_action).toBe('dm')
    expect(dmTask.locked).toBe(false)
    expect(dmTask.campaign_version_id).toBe(approved.version.id)

    await expect(
      markTask(em, ctx, { taskKey: dmTask.task_key, outcome: 'accepted' }),
    ).rejects.toMatchObject({ code: 'invalid_outcome' })

    const marked = await markTask(em, ctx, { taskKey: dmTask.task_key, outcome: 'skipped' })
    expect(marked.state).toBe('task_skipped')
  })

  it("mark 'replied' takes the atomic stop path: enrollment stopped, pending emails cancelled, tasks hidden", async () => {
    const s = await socialFixture()
    const enrollment = s.fixture.enrollments[0]

    const result = await markTask(
      s.em,
      ctx,
      { taskKey: s.connectKey, outcome: 'replied', note: 'they answered on LinkedIn' },
      { clock: s.clock },
    )
    expect(result.state).toBe('replied')
    expect(result.reply).not.toBeNull()
    expect(result.reply!.alreadyRecorded).toBe(false)

    // The stop is durable in the same transaction (section 9).
    expect(enrollment.status).toBe('stopped')
    expect(enrollment.stopReason).toBe('social_reply')

    // Every pending email attempt of the enrollment was cancelled.
    const attempts = (await s.em.find(GtmSendAttempt, { enrollmentId: enrollment.id })).filter(
      (row) => row.idempotencyKey.startsWith('send:'),
    )
    expect(attempts.length).toBeGreaterThan(0)
    for (const attempt of attempts) {
      expect(attempt.state).toBe('failed')
      expect(attempt.failureReason).toBe('stopped')
    }

    // The reply row exists and points at the social step.
    const replies = await s.em.find(GtmReply, { enrollmentId: enrollment.id })
    expect(replies).toHaveLength(1)
    expect(replies[0].stepId).toBe(s.connectStep.id)
    expect(replies[0].channel).toBe('linkedin')

    // Stopped enrollment: all tasks cancelled/hidden.
    const listed = await listManualTasks(s.em, ctx, { campaignId: s.fixture.campaign.id })
    expect(listed.tasks).toHaveLength(0)

    // Nothing is claimable for this enrollment ever again.
    s.clock.set('2026-08-31T15:00:00.000Z')
    const claim = await claimDueAttempts(s.em, ctx, { clock: s.clock, limit: 100 })
    expect(claim.claimed).toHaveLength(0)

    // Further marks on the stopped enrollment are refused.
    await expect(
      markTask(s.em, ctx, { taskKey: s.followupKey, outcome: 'sent' }, { clock: s.clock }),
    ).rejects.toMatchObject({ code: 'enrollment_stopped' })
    await expect(
      markTask(s.em, ctx, { taskKey: s.connectKey, outcome: 'replied' }, { clock: s.clock }),
    ).rejects.toMatchObject({ code: 'enrollment_stopped' })
  })

  it('re-marking a task updates the user-recorded state and appends history', async () => {
    const s = await socialFixture()
    await markTask(s.em, ctx, { taskKey: s.connectKey, outcome: 'requested' }, { clock: s.clock })
    await markTask(
      s.em,
      ctx,
      { taskKey: s.connectKey, outcome: 'accepted', note: 'accepted today' },
      { clock: s.clock },
    )
    const rows = await s.em.find(GtmSendAttempt, { idempotencyKey: s.connectKey })
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('task_accepted')
    const receipt = rows[0].providerReceipt as Record<string, unknown>
    expect(receipt.recorded_by).toBe('user')
    expect((receipt.history as unknown[]).length).toBe(2)
  })

  it('unknown or malformed task keys resolve to task_not_found', async () => {
    const s = await socialFixture()
    await expect(
      markTask(s.em, ctx, { taskKey: 'task:not-a-key', outcome: 'sent' }),
    ).rejects.toMatchObject({ code: 'task_not_found' })
    await expect(
      markTask(s.em, ctx, { taskKey: 'send:whatever', outcome: 'sent' }),
    ).rejects.toMatchObject({ code: 'task_not_found' })
    await expect(
      markTask(s.em, ctx, {
        taskKey: buildTaskKey(s.fixture.version.id, s.fixture.enrollments[0].id, WORKSPACE),
        outcome: 'sent',
      }),
    ).rejects.toMatchObject({ code: 'task_not_found' })
    expect.assertions(3)
  })

  it('rejects marks on email steps (tasks exist only for manual social steps)', async () => {
    const s = await socialFixture()
    const emailStep = s.fixture.steps.find((step) => step.mode === 'automated_email')!
    await expect(
      markTask(s.em, ctx, {
        taskKey: buildTaskKey(s.fixture.version.id, s.fixture.enrollments[0].id, emailStep.id),
        outcome: 'sent',
      }),
    ).rejects.toMatchObject({ code: 'task_not_found' })
  })

  it('cross-tenant campaigns are invisible', async () => {
    const s = await socialFixture()
    const foreignCtx = { ...ctx, organizationId: '99999999-9999-4999-8999-999999999999' }
    await expect(
      listManualTasks(s.em, foreignCtx, { campaignId: s.fixture.campaign.id }),
    ).rejects.toMatchObject({ code: 'campaign_not_found' })
    await expect(
      markTask(s.em, foreignCtx, { taskKey: s.connectKey, outcome: 'sent' }),
    ).rejects.toMatchObject({ code: 'task_not_found' })
  })
})
