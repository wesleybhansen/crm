import { FakeEm } from './support/fake-em'
import { ctx, seedPlay, WORKSPACE } from './support/campaign-fixtures'
import {
  buildSteps,
  createCampaign,
  DAILY_CAP_CEILING,
  DEFAULT_DAILY_CAP,
  DEFAULT_TEMPLATE,
  GtmCampaignError,
  normalizeSettings,
} from '../campaign/build'
import { projectCampaignCredits } from '../campaign/project-credits'
import { GtmAuditEvent, GtmCampaign, GtmStep } from '../../data/entities'

describe('buildSteps (campaign step plan)', () => {
  it('defaults to three email steps spaced 0/3/7 days', () => {
    const steps = buildSteps()
    expect(steps).toHaveLength(3)
    expect(steps.map((step) => step.channel)).toEqual(['email', 'email', 'email'])
    expect(steps.map((step) => step.mode)).toEqual([
      'automated_email',
      'automated_email',
      'automated_email',
    ])
    expect(steps.map((step) => step.delay_days)).toEqual([0, 3, 7])
    expect(steps.map((step) => step.order)).toEqual([1, 2, 3])
    expect(steps.every((step) => step.dependency_kind === 'none')).toBe(true)
  })

  it('honors a reduced email count', () => {
    const steps = buildSteps({ emails: 1 })
    expect(steps).toHaveLength(1)
    expect(steps[0].key).toBe('email_1')
  })

  it('rejects email counts outside 1..3', () => {
    for (const emails of [0, 4, 2.5]) {
      expect(() => buildSteps({ emails })).toThrow(GtmCampaignError)
    }
  })

  it('wires LinkedIn connect-first: the follow-up depends on the connection request', () => {
    const steps = buildSteps({ emails: 2, linkedin: true })
    const connect = steps.find((step) => step.social_action === 'connection_request')
    const followup = steps.find((step) => step.social_action === 'followup')
    expect(connect).toBeDefined()
    expect(followup).toBeDefined()
    expect(connect!.mode).toBe('manual_social')
    expect(connect!.channel).toBe('linkedin')
    expect(connect!.dependency_kind).toBe('none')
    expect(followup!.depends_on_key).toBe(connect!.key)
    expect(followup!.dependency_kind).toBe('linkedin_connection_accepted')
    expect(followup!.order).toBeGreaterThan(connect!.order)
  })

  it('adds a manual X DM task when requested', () => {
    const steps = buildSteps({ emails: 1, x: true })
    const dm = steps.find((step) => step.channel === 'x')
    expect(dm).toBeDefined()
    expect(dm!.mode).toBe('manual_social')
    expect(dm!.social_action).toBe('dm')
    expect(dm!.dependency_kind).toBe('none')
  })
})

describe('normalizeSettings (daily cap, send window, jitter)', () => {
  it('defaults the daily cap to 25 sends per mailbox per day', () => {
    expect(normalizeSettings().daily_cap).toBe(DEFAULT_DAILY_CAP)
    expect(DEFAULT_DAILY_CAP).toBe(25)
  })

  it('accepts the ceiling exactly and rejects anything above it', () => {
    expect(normalizeSettings({ daily_cap: DAILY_CAP_CEILING }).daily_cap).toBe(50)
    for (const cap of [51, 60, 500]) {
      expect(() => normalizeSettings({ daily_cap: cap })).toThrow(
        expect.objectContaining({ code: 'daily_cap_exceeds_ceiling' }),
      )
    }
  })

  it('rejects non-positive and non-integer caps', () => {
    for (const cap of [0, -5, 2.5]) {
      expect(() => normalizeSettings({ daily_cap: cap })).toThrow(
        expect.objectContaining({ code: 'invalid_settings' }),
      )
    }
  })

  it('rejects an inverted send window', () => {
    expect(() =>
      normalizeSettings({ send_window: { start_hour: 17, end_hour: 9 } }),
    ).toThrow(expect.objectContaining({ code: 'invalid_settings' }))
  })
})

describe('createCampaign (draft creation, ladder boundary)', () => {
  it('creates a draft campaign with default template, steps, and settings plus an audit event', async () => {
    const em = new FakeEm()
    const play = await seedPlay(em)
    const { campaign, steps, settings } = await createCampaign(em, ctx, {
      workspaceId: WORKSPACE,
      playId: play.id,
      name: 'Synthetic outbound',
      channelMix: { emails: 3, linkedin: true },
    })

    const stored = em.table(GtmCampaign)
    expect(stored).toHaveLength(1)
    expect(stored[0].status).toBe('draft')
    expect(stored[0].currentVersionId).toBeNull()
    const mix = stored[0].channelMix as Record<string, unknown>
    expect(mix.template).toEqual(DEFAULT_TEMPLATE)
    expect((mix.steps as unknown[]).length).toBe(5)
    expect(steps).toHaveLength(5)
    expect(settings.daily_cap).toBe(25)
    expect(campaign.id).toBe(stored[0].id)

    // No durable steps at draft time: steps belong to an approval version.
    expect(em.table(GtmStep)).toHaveLength(0)

    const audits = em.table(GtmAuditEvent).filter((row) => row.action === 'gtm.campaign.created')
    expect(audits).toHaveLength(1)
    expect(audits[0].objectId).toBe(campaign.id)
  })

  it('fails closed for a strategy_only play (section 7 boundary 4)', async () => {
    const em = new FakeEm()
    const play = await seedPlay(em, { marketType: 'b2c' })
    await expect(
      createCampaign(em, ctx, { workspaceId: WORKSPACE, playId: play.id, name: 'Nope' }),
    ).rejects.toMatchObject({ code: 'play_not_executable' })
    expect(em.table(GtmCampaign)).toHaveLength(0)
  })

  it('fails closed for a non-US geography play', async () => {
    const em = new FakeEm()
    const play = await seedPlay(em, { geography: 'Berlin, Germany' })
    await expect(
      createCampaign(em, ctx, { workspaceId: WORKSPACE, playId: play.id, name: 'Nope' }),
    ).rejects.toMatchObject({ code: 'play_not_executable' })
  })

  it('rejects a play that belongs to a different workspace', async () => {
    const em = new FakeEm()
    const play = await seedPlay(em, { workspaceId: 'eeeeeeee-5555-4555-8555-555555555555' })
    await expect(
      createCampaign(em, ctx, { workspaceId: WORKSPACE, playId: play.id, name: 'Nope' }),
    ).rejects.toMatchObject({ code: 'play_not_found' })
  })

  it('propagates the daily cap ceiling at create time', async () => {
    const em = new FakeEm()
    const play = await seedPlay(em)
    await expect(
      createCampaign(em, ctx, {
        workspaceId: WORKSPACE,
        playId: play.id,
        name: 'Too hot',
        settings: { daily_cap: 51 },
      }),
    ).rejects.toMatchObject({ code: 'daily_cap_exceeds_ceiling' })
  })
})

describe('projectCampaignCredits', () => {
  it('projects zero credits for mailbox email sends and manual tasks by default', () => {
    const steps = buildSteps({ emails: 3, linkedin: true })
    const projection = projectCampaignCredits({ recipientCount: 10, steps })
    expect(projection.projected_credits).toBe(0)
    const email = projection.breakdown.find((line) => line.kind === 'email_send')
    const manual = projection.breakdown.find((line) => line.kind === 'manual_social_task')
    expect(email).toMatchObject({ units: 30, credits: 0 })
    expect(manual).toMatchObject({ units: 20, credits: 0 })
  })

  it('keeps the seam for a future per-send cost provider', () => {
    const steps = buildSteps({ emails: 2 })
    const projection = projectCampaignCredits(
      { recipientCount: 5, steps },
      { email_send: 0.5 },
    )
    expect(projection.projected_credits).toBe(5)
    expect(projection.breakdown[0]).toMatchObject({
      kind: 'email_send',
      units: 10,
      credits_per_unit: 0.5,
      credits: 5,
    })
  })
})
