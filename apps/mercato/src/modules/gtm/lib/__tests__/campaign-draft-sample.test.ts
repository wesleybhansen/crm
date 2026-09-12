import crypto from 'crypto'
import { FakeEm } from './support/fake-em'
import { ctx, OTHER_ORG, seedCandidate, seedPlay, seedRun, WORKSPACE } from './support/campaign-fixtures'
import { createCampaign, GtmCampaignError } from '../campaign/build'
import { approveCampaign, computeDraftState, updateCampaignTemplate } from '../campaign/approve'
import {
  computeMergeSpans,
  describeWaitRule,
  getCampaignDraftSample,
  type MergeSpan,
  type MergeValues,
} from '../campaign/draft-sample'
import { campaignFeatureForOp } from '../authorize'
import { gtmCampaignsBodySchema } from '../../data/validators'
import { GtmEnrollment } from '../../data/entities'

const TEMPLATE = {
  subject: 'Quick question for {{company}}',
  body: 'Hi {{first_name}},\n\nI noticed {{signal}}.\n\n{{why_now}}\n\nWorth a look for {{company}}?',
}

async function setup(options: { candidates?: number; linkedin?: boolean } = {}) {
  const em = new FakeEm()
  const play = await seedPlay(em)
  const run = await seedRun(em, play)
  const candidates = []
  for (let i = 0; i < (options.candidates ?? 2); i += 1) {
    candidates.push(await seedCandidate(em, run, { name: `Ada Lovelace ${i + 1}`, company: `Analytical Engines ${i + 1}` }))
  }
  const { campaign } = await createCampaign(em, ctx, {
    workspaceId: WORKSPACE,
    playId: play.id,
    name: 'Sample test',
    channelMix: { emails: 2, linkedin: options.linkedin ?? false },
  })
  await updateCampaignTemplate(em, ctx, campaign.id, TEMPLATE)
  return { em, play, run, campaign, candidates }
}

function sliceOf(text: string, span: MergeSpan): string {
  return text.slice(span.start, span.end)
}

describe('getCampaignDraftSample (internal campaigns op draft-sample)', () => {
  it('samples the frozen rows of the approved version with merge-field spans and wait rules', async () => {
    const { em, campaign, candidates } = await setup({ candidates: 2, linkedin: true })
    const draft = await computeDraftState(em, ctx, campaign)
    const approved = await approveCampaign(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: draft.contentHash,
    })

    const sample = await getCampaignDraftSample(em, ctx, { campaignId: campaign.id })
    expect(sample.campaign_id).toBe(campaign.id)
    expect(sample.version_id).toBe(approved.version.id)
    expect(sample.source).toBe('approved_version')
    expect(sample.enrollment_id).toEqual(expect.any(String))
    expect(candidates.map((row) => row.id)).toContain(sample.candidate_id)
    const recipientCandidate = candidates.find((row) => row.id === sample.candidate_id)!
    expect(sample.recipient).toEqual({
      name: (recipientCandidate.identity as Record<string, string>).name,
      company: (recipientCandidate.identity as Record<string, string>).company,
      title: null,
    })

    // 2 email + 2 linkedin steps, in order, first email at launch, second
    // email 3 days later only if nobody replied.
    expect(sample.steps.map((step) => step.channel)).toEqual(['email', 'email', 'linkedin', 'linkedin'])
    expect(sample.steps.map((step) => step.step_index)).toEqual([0, 1, 2, 3])
    expect(sample.steps[0].wait_rule).toBe('At launch')
    expect(sample.steps[1].wait_rule).toBe('3 days, if no reply')
    expect(sample.steps[3].wait_rule).toContain('after the connection request is accepted')

    // Frozen email copy comes back with spans that slice to the merge values.
    const first = sample.steps[0]
    expect(first.subject).toBe(`Quick question for ${sample.recipient.company}`)
    expect(first.body).toContain(`Hi ${sample.recipient.name!.split(' ')[0]},`)
    const fieldsMarked = new Map(first.spans.map((span) => [span.field, sliceOf(first.body!, span)]))
    expect(fieldsMarked.get('first_name')).toBe('Ada')
    expect(fieldsMarked.get('company')).toBe(sample.recipient.company)
    expect(fieldsMarked.get('signal')).toBe('the team posted three synthetic roles this month')
    expect(fieldsMarked.get('why_now')).toBe(
      'Teams hiring this quarter are actively rebuilding their outbound stack.',
    )
    expect(first.subject_spans.map((span) => [span.field, sliceOf(first.subject!, span)])).toEqual([
      ['company', sample.recipient.company],
    ])
    // Spans never overlap and are ordered.
    for (let i = 1; i < first.spans.length; i += 1) {
      expect(first.spans[i].start).toBeGreaterThanOrEqual(first.spans[i - 1].end)
    }

    // Manual social steps have no rendered copy.
    expect(sample.steps[2].subject).toBeNull()
    expect(sample.steps[2].body).toBeNull()
    expect(sample.steps[2].spans).toEqual([])

    // A named enrollment is honoured.
    const enrollments = em.table(GtmEnrollment).filter((row) => row.campaignId === campaign.id)
    const other = enrollments.find((row) => row.id !== sample.enrollment_id)!
    const named = await getCampaignDraftSample(em, ctx, { campaignId: campaign.id, enrollmentId: other.id })
    expect(named.enrollment_id).toBe(other.id)
    expect(named.candidate_id).toBe(other.candidateId)
  })

  it('falls back to the read-only draft render before approval', async () => {
    const { em, campaign } = await setup({ candidates: 1 })
    const sample = await getCampaignDraftSample(em, ctx, { campaignId: campaign.id })
    expect(sample.source).toBe('draft')
    expect(sample.version_id).toBeNull()
    expect(sample.enrollment_id).toBeNull()
    expect(sample.steps).toHaveLength(2)
    expect(sample.steps[0].step_key).toBe('email_1')
    expect(sample.steps[0].body).toContain('Hi Ada,')
    expect(sample.steps[0].spans.map((span) => span.field)).toEqual(
      expect.arrayContaining(['first_name', 'signal', 'why_now', 'company']),
    )
    // Reading the sample writes nothing.
    expect(em.table(GtmEnrollment)).toHaveLength(0)

    // No enrollment exists yet, so naming one is an opaque miss.
    await expect(
      getCampaignDraftSample(em, ctx, { campaignId: campaign.id, enrollmentId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'enrollment_not_found' })
  })

  it('is tenant scoped: another workspace cannot read the campaign or its enrollments', async () => {
    const { em, campaign } = await setup({ candidates: 1 })
    const draft = await computeDraftState(em, ctx, campaign)
    await approveCampaign(em, ctx, { campaignId: campaign.id, expectedContentHash: draft.contentHash })
    const foreignCtx = { ...ctx, organizationId: OTHER_ORG }

    await expect(getCampaignDraftSample(em, foreignCtx, { campaignId: campaign.id })).rejects.toMatchObject({
      code: 'campaign_not_found',
    })
    const enrollment = em.table(GtmEnrollment).find((row) => row.campaignId === campaign.id)!
    await expect(
      getCampaignDraftSample(em, foreignCtx, { campaignId: campaign.id, enrollmentId: enrollment.id }),
    ).rejects.toMatchObject({ code: 'campaign_not_found' })
    // A foreign / unknown enrollment id on our own campaign is the same opaque miss.
    await expect(
      getCampaignDraftSample(em, ctx, { campaignId: campaign.id, enrollmentId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(GtmCampaignError)
  })

  it('computeMergeSpans: longest value wins, word-bounded, non-overlapping, ordered', () => {
    const values: MergeValues = { first_name: 'Sam', company: 'Sam Co', signal: '', why_now: 'x' }
    const text = 'Hi Sam, Sam Co is great. Samuel and sam co agree. Sam'
    const spans = computeMergeSpans(text, values)
    expect(spans.map((span) => [span.field, sliceOf(text, span), span.start])).toEqual([
      ['first_name', 'Sam', 3],
      ['company', 'Sam Co', 8],
      ['first_name', 'Sam', 50],
    ])
    expect(computeMergeSpans(null, values)).toEqual([])
    expect(computeMergeSpans('nothing here', { first_name: '', company: '', signal: '', why_now: '' })).toEqual([])
  })

  it('describeWaitRule reads as plain English', () => {
    expect(describeWaitRule({ order: 1, delay_days: 0, dependency_kind: 'none' }, true)).toBe('At launch')
    expect(describeWaitRule({ order: 2, delay_days: 0, dependency_kind: 'none' }, false)).toBe('Same day, if no reply')
    expect(describeWaitRule({ order: 2, delay_days: 1, dependency_kind: 'none' }, false)).toBe('1 day, if no reply')
    expect(describeWaitRule({ order: 3, delay_days: 7, dependency_kind: 'none' }, false)).toBe('7 days, if no reply')
    expect(
      describeWaitRule({ order: 4, delay_days: 2, dependency_kind: 'linkedin_connection_accepted' }, false),
    ).toBe('2 days, after the connection request is accepted')
  })

  it('is a read op on the route contract', () => {
    expect(campaignFeatureForOp('draft-sample')).toBe('gtm.view')
    expect(
      gtmCampaignsBodySchema.safeParse({
        op: 'draft-sample',
        noliUserId: '55555555-5555-4555-8555-555555555555',
        campaignId: WORKSPACE,
      }).success,
    ).toBe(true)
    expect(
      gtmCampaignsBodySchema.safeParse({
        op: 'draft-sample',
        noliUserId: '55555555-5555-4555-8555-555555555555',
        campaignId: WORKSPACE,
        enrollmentId: WORKSPACE,
      }).success,
    ).toBe(true)
  })
})
