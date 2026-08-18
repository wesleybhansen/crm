import { FakeEm } from './support/fake-em'
import {
  ctx,
  ORG,
  POSTAL_ADDRESS,
  seedCandidate,
  seedPlay,
  seedRun,
  seedWorkspace,
  TENANT,
  WORKSPACE,
} from './support/campaign-fixtures'
import { updateWorkspacePostalAddress } from '../workspace-settings'
import { createCampaign } from '../campaign/build'
import { hashAddress } from '../campaign/exclusions'
import {
  approveCampaign,
  computeDraftState,
  invalidateCurrentVersion,
  invalidateForPlayScopeChange,
  setCandidateExclusion,
  updateCampaignTemplate,
} from '../campaign/approve'
import {
  GtmAuditEvent,
  GtmCampaign,
  GtmCampaignVersion,
  GtmEnrollment,
  GtmPlay,
  GtmRenderedMessage,
  GtmResearchRun,
  GtmStep,
  GtmSuppression,
} from '../../data/entities'

async function setup(options: { candidates?: number; linkedin?: boolean } = {}) {
  const em = new FakeEm()
  const play = await seedPlay(em)
  const run = await seedRun(em, play)
  const candidates = []
  for (let i = 0; i < (options.candidates ?? 2); i += 1) {
    candidates.push(await seedCandidate(em, run))
  }
  const { campaign } = await createCampaign(em, ctx, {
    workspaceId: WORKSPACE,
    playId: play.id,
    name: 'Approval test',
    channelMix: { emails: 2, linkedin: options.linkedin ?? true },
  })
  return { em, play, run, campaign, candidates }
}

describe('approveCampaign (immutable freeze)', () => {
  it('creates the version, steps, enrollments, and frozen rendered rows in one pass', async () => {
    const { em, campaign, candidates } = await setup({ candidates: 2, linkedin: true })
    const draft = await computeDraftState(em, ctx, campaign)
    expect(draft.recipients).toHaveLength(2)

    const result = await approveCampaign(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: draft.contentHash,
    })

    expect(result.alreadyApproved).toBe(false)
    expect(result.version.version).toBe(1)
    expect(result.version.contentHash).toBe(draft.contentHash)
    expect(result.version.approvedByUserId).toBe(ctx.userId)
    expect(result.version.approvedAt).toBeInstanceOf(Date)

    const campaignRow = em.table(GtmCampaign).find((row) => row.id === campaign.id)!
    expect(campaignRow.status).toBe('approved')
    expect(campaignRow.currentVersionId).toBe(result.version.id)

    // Steps belong to the version: 2 email + 2 linkedin.
    const steps = em.table(GtmStep).filter((row) => row.campaignVersionId === result.version.id)
    expect(steps).toHaveLength(4)

    // Connect-first dependency resolved from draft keys to row ids.
    const followup = steps.find((row) => row.dependencyKind === 'linkedin_connection_accepted')!
    const connect = steps.find(
      (row) =>
        (row.sendWindow as Record<string, unknown>).social_action === 'connection_request',
    )!
    expect(followup.dependsOnStepId).toBe(connect.id)

    // One enrollment per recipient, unique (campaign, candidate).
    const enrollments = em.table(GtmEnrollment).filter((row) => row.campaignId === campaign.id)
    expect(enrollments).toHaveLength(2)
    expect(new Set(enrollments.map((row) => row.candidateId))).toEqual(
      new Set(candidates.map((candidate) => candidate.id)),
    )
    expect(enrollments.every((row) => row.campaignVersionId === result.version.id)).toBe(true)

    // Frozen rendered rows: one per (enrollment, email step).
    const rendered = em
      .table(GtmRenderedMessage)
      .filter((row) => row.campaignVersionId === result.version.id)
    expect(rendered).toHaveLength(4)
    const emailStepIds = new Set(steps.filter((s) => s.mode === 'automated_email').map((s) => s.id))
    expect(rendered.every((row) => emailStepIds.has(row.stepId))).toBe(true)

    // Snapshot carries the canonical draft plus created row ids.
    const snapshot = result.version.snapshot as Record<string, unknown>
    expect(snapshot.projected_credits).toBe(0)
    expect((snapshot.recipients as unknown[]).length).toBe(2)
    const ids = snapshot.ids as Record<string, unknown[]>
    expect(ids.steps).toHaveLength(4)
    expect(ids.enrollments).toHaveLength(2)
    expect(ids.rendered).toHaveLength(4)

    const audit = em.table(GtmAuditEvent).filter((row) => row.action === 'gtm.campaign.approved')
    expect(audit).toHaveLength(1)
    expect(audit[0].objectVersion).toBe(1)
  })

  it('rejects stale_draft when the draft changed after the reviewer took the hash', async () => {
    const { em, campaign } = await setup()
    const draft = await computeDraftState(em, ctx, campaign)
    await updateCampaignTemplate(em, ctx, campaign.id, {
      subject: 'Changed {{first_name}}',
      body: 'New body {{company}}',
    })
    await expect(
      approveCampaign(em, ctx, { campaignId: campaign.id, expectedContentHash: draft.contentHash }),
    ).rejects.toMatchObject({ code: 'stale_draft' })
    expect(em.table(GtmCampaignVersion)).toHaveLength(0)
    expect(em.table(GtmCampaign)[0].status).toBe('draft')
  })

  it('double-approve with the live hash returns the existing version idempotently', async () => {
    const { em, campaign } = await setup()
    const draft = await computeDraftState(em, ctx, campaign)
    const first = await approveCampaign(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: draft.contentHash,
    })
    const second = await approveCampaign(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: draft.contentHash,
    })
    expect(second.alreadyApproved).toBe(true)
    expect(second.version.id).toBe(first.version.id)
    expect(em.table(GtmCampaignVersion)).toHaveLength(1)
    expect(em.table(GtmEnrollment)).toHaveLength(2)
  })

  it('rejects a second approve carrying a different hash', async () => {
    const { em, campaign } = await setup()
    const draft = await computeDraftState(em, ctx, campaign)
    await approveCampaign(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: draft.contentHash,
    })
    await expect(
      approveCampaign(em, ctx, {
        campaignId: campaign.id,
        expectedContentHash: 'deadbeefdeadbeefdeadbeef',
      }),
    ).rejects.toMatchObject({ code: 'stale_draft' })
  })

  it('cannot approve a strategy_only play even by direct call with raw ids (boundary 4)', async () => {
    const { em, play, campaign } = await setup()
    const reviewed = await computeDraftState(em, ctx, campaign)
    // The play drifts out of scope AFTER the campaign was attached; the
    // stored execution_eligibility column still says executable and is
    // rightly ignored.
    play.marketType = 'b2c'
    await expect(
      approveCampaign(em, ctx, {
        campaignId: campaign.id,
        expectedContentHash: reviewed.contentHash,
      }),
    ).rejects.toMatchObject({ code: 'play_not_executable' })
    expect(em.table(GtmCampaignVersion)).toHaveLength(0)
    expect(em.table(GtmEnrollment)).toHaveLength(0)
  })

  it('re-excludes at approval: a suppression added between render and approve drops the recipient', async () => {
    const { em, campaign, candidates } = await setup({ candidates: 2 })
    const draft = await computeDraftState(em, ctx, campaign)
    expect(draft.recipients).toHaveLength(2)
    const dropped = draft.recipients[0]

    em.persist(
      em.create(GtmSuppression, {
        organizationId: ORG,
        tenantId: TENANT,
        scope: 'org',
        channel: 'email',
        addressHash: hashAddress(dropped.address),
        reason: 'unsubscribe',
      }),
    )
    await em.flush()

    await expect(
      approveCampaign(em, ctx, {
        campaignId: campaign.id,
        expectedContentHash: draft.contentHash,
      }),
    ).rejects.toMatchObject({ code: 'stale_draft' })

    const reviewedAfterSuppression = await computeDraftState(em, ctx, campaign)
    const result = await approveCampaign(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: reviewedAfterSuppression.contentHash,
    })
    const snapshot = result.version.snapshot as Record<string, unknown>
    expect((snapshot.recipients as Array<Record<string, unknown>>).length).toBe(1)
    const exclusions = snapshot.exclusions as Array<Record<string, unknown>>
    expect(exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ candidate_id: dropped.candidateId, reason: 'unsubscribe' }),
      ]),
    )
    const enrollments = em.table(GtmEnrollment).filter((row) => row.campaignId === campaign.id)
    expect(enrollments).toHaveLength(1)
    expect(enrollments[0].candidateId).not.toBe(dropped.candidateId)
    expect(candidates.map((c) => c.id)).toContain(enrollments[0].candidateId)
  })

  it('rejects approval when no eligible recipients remain', async () => {
    const em = new FakeEm()
    const play = await seedPlay(em)
    const run = await seedRun(em, play)
    await seedCandidate(em, run, { email: null })
    const { campaign } = await createCampaign(em, ctx, {
      workspaceId: WORKSPACE,
      playId: play.id,
      name: 'Empty',
    })
    const draft = await computeDraftState(em, ctx, campaign)
    await expect(
      approveCampaign(em, ctx, {
        campaignId: campaign.id,
        expectedContentHash: draft.contentHash,
      }),
    ).rejects.toMatchObject({ code: 'no_recipients' })
  })

  it('treats an enrollment unique violation as already-enrolled (race safety)', async () => {
    const { em, campaign, candidates } = await setup({ candidates: 1, linkedin: false })

    // Pre-existing enrollment from a concurrent writer that this approver's
    // first read does not yet see: the insert loses the unique race and the
    // durable row is reused.
    const preexisting = em.create(GtmEnrollment, {
      organizationId: ORG,
      tenantId: TENANT,
      campaignId: campaign.id,
      campaignVersionId: 'ffffffff-1111-4111-8111-111111111111',
      candidateId: candidates[0].id,
      status: 'active',
    })
    em.persist(preexisting)
    await em.flush()

    const draft = await computeDraftState(em, ctx, campaign)

    const originalFindOne = em.findOne.bind(em)
    let misses = 1
    jest.spyOn(em, 'findOne').mockImplementation(async (Ctor: any, where: any) => {
      if (Ctor === GtmEnrollment && misses > 0) {
        misses -= 1
        return null
      }
      return originalFindOne(Ctor, where)
    })

    const result = await approveCampaign(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: draft.contentHash,
    })
    const enrollments = em.table(GtmEnrollment).filter((row) => row.campaignId === campaign.id)
    expect(enrollments).toHaveLength(1)
    expect(enrollments[0].id).toBe(preexisting.id)
    expect(enrollments[0].campaignVersionId).toBe(result.version.id)
  })
})

describe('invalidation (immutable versions, mutable campaign pointer)', () => {
  it('a template edit invalidates the approved version without mutating its frozen content', async () => {
    const { em, campaign } = await setup()
    const draft = await computeDraftState(em, ctx, campaign)
    const { version } = await approveCampaign(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: draft.contentHash,
    })
    const frozenSnapshot = JSON.stringify(version.snapshot)
    const frozenHash = version.contentHash

    const edit = await updateCampaignTemplate(em, ctx, campaign.id, {
      subject: 'New subject {{first_name}}',
      body: 'New body',
    })
    expect(edit.invalidated).toBe(true)

    const campaignRow = em.table(GtmCampaign)[0]
    expect(campaignRow.status).toBe('draft')
    expect(campaignRow.currentVersionId).toBeNull()

    const versionRow = em.table(GtmCampaignVersion).find((row) => row.id === version.id)!
    expect(versionRow.invalidatedAt).toBeInstanceOf(Date)
    expect(versionRow.invalidatedReason).toBe('template_edited')
    // The freeze itself is untouched: snapshot, hash, and approval stamps.
    expect(JSON.stringify(versionRow.snapshot)).toBe(frozenSnapshot)
    expect(versionRow.contentHash).toBe(frozenHash)
    expect(versionRow.approvedByUserId).toBe(ctx.userId)

    const audits = em
      .table(GtmAuditEvent)
      .filter((row) => row.action === 'gtm.campaign.version_invalidated')
    expect(audits).toHaveLength(1)
    expect((audits[0].metadata as Record<string, unknown>).reason).toBe('template_edited')
  })

  it('manual exclusion of a recipient invalidates and re-approval produces version 2 reusing enrollments', async () => {
    const { em, campaign, candidates } = await setup({ candidates: 2 })
    const draft1 = await computeDraftState(em, ctx, campaign)
    const first = await approveCampaign(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: draft1.contentHash,
    })

    const exclusion = await setCandidateExclusion(em, ctx, campaign.id, candidates[0].id, true)
    expect(exclusion.invalidated).toBe(true)
    expect(em.table(GtmCampaign)[0].status).toBe('draft')

    const draft2 = await computeDraftState(em, ctx, campaign)
    expect(draft2.recipients.map((r) => r.candidateId)).toEqual([candidates[1].id])
    expect(draft2.contentHash).not.toBe(draft1.contentHash)
    const manualEntry = draft2.exclusions.byCandidate.get(candidates[0].id)
    expect(manualEntry).toMatchObject({ excluded: true, reason: 'manual' })

    const second = await approveCampaign(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: draft2.contentHash,
    })
    expect(second.version.version).toBe(2)
    // The durable enrollment rows are reused, not duplicated; the remaining
    // recipient is repointed at version 2.
    const enrollments = em.table(GtmEnrollment).filter((row) => row.campaignId === campaign.id)
    expect(enrollments).toHaveLength(2)
    const kept = enrollments.find((row) => row.candidateId === candidates[1].id)!
    expect(kept.campaignVersionId).toBe(second.version.id)
    // Version 1 stays fully intact as history.
    const v1 = em.table(GtmCampaignVersion).find((row) => row.id === first.version.id)!
    expect(v1.invalidatedReason).toBe('recipient_excluded')
    expect(v1.contentHash).toBe(draft1.contentHash)
  })

  it('a play geography/market change invalidates dependent versions with reason scope_change', async () => {
    const { em, play, campaign } = await setup()
    const draft = await computeDraftState(em, ctx, campaign)
    const { version } = await approveCampaign(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: draft.contentHash,
    })

    // The play is edited out of US scope.
    play.geography = 'Berlin, Germany'
    const swept = await invalidateForPlayScopeChange(em, ctx, play.id)
    expect(swept.invalidatedCampaignIds).toEqual([campaign.id])

    const versionRow = em.table(GtmCampaignVersion).find((row) => row.id === version.id)!
    expect(versionRow.invalidatedReason).toBe('scope_change')
    expect(em.table(GtmCampaign)[0].status).toBe('draft')

    // And the now strategy_only play can never be re-approved (boundary 4).
    const changedDraft = await computeDraftState(em, ctx, campaign)
    await expect(
      approveCampaign(em, ctx, {
        campaignId: campaign.id,
        expectedContentHash: changedDraft.contentHash,
      }),
    ).rejects.toMatchObject({ code: 'play_not_executable' })
  })

  it('explicit invalidate is a no-op on a draft campaign', async () => {
    const { em, campaign } = await setup()
    const result = await invalidateCurrentVersion(em, ctx, campaign.id, 'manual')
    expect(result.invalidated).toBe(false)
    expect(result.version).toBeNull()
  })

  it('suppression at build time excludes the candidate from the draft recipients', async () => {
    const { em, campaign, candidates } = await setup({ candidates: 2 })
    const initial = await computeDraftState(em, ctx, campaign)
    const target = initial.recipients[1]
    em.persist(
      em.create(GtmSuppression, {
        organizationId: ORG,
        tenantId: TENANT,
        scope: 'org',
        channel: 'email',
        addressHash: hashAddress(target.address),
        reason: 'complaint',
      }),
    )
    await em.flush()

    const draft = await computeDraftState(em, ctx, campaign)
    expect(draft.recipients.map((r) => r.candidateId)).not.toContain(target.candidateId)
    expect(draft.exclusions.byCandidate.get(target.candidateId)).toMatchObject({
      excluded: true,
      reason: 'complaint',
    })
    expect(draft.rendered.map((r) => r.candidateId)).not.toContain(target.candidateId)
    expect(candidates).toHaveLength(2)
  })
})

describe('postal address approval gate (CAN-SPAM: sender is the org, not Noli)', () => {
  async function setupWithoutAddress() {
    const em = new FakeEm()
    // Seed the workspace WITHOUT a postal address before seedPlay reuses it.
    await seedWorkspace(em, { postalAddress: null })
    const play = await seedPlay(em)
    const run = await seedRun(em, play)
    await seedCandidate(em, run)
    const { campaign } = await createCampaign(em, ctx, {
      workspaceId: WORKSPACE,
      playId: play.id,
      name: 'Postal gate test',
    })
    return { em, campaign }
  }

  it('approval fails typed postal_address_required while the address is unset', async () => {
    const { em, campaign } = await setupWithoutAddress()
    const draft = await computeDraftState(em, ctx, campaign)
    await expect(
      approveCampaign(em, ctx, {
        campaignId: campaign.id,
        expectedContentHash: draft.contentHash,
      }),
    ).rejects.toMatchObject({ code: 'postal_address_required' })
    // Nothing was frozen.
    expect(em.table(GtmCampaignVersion)).toHaveLength(0)
    expect(em.table(GtmEnrollment)).toHaveLength(0)
    expect(em.table(GtmCampaign)[0].status).toBe('draft')
  })

  it('draft-state exposes postal address presence so the UI can prompt', async () => {
    const { em, campaign } = await setupWithoutAddress()
    const before = await computeDraftState(em, ctx, campaign)
    expect(before.postalAddress).toBeNull()
    // Every preview honestly flags the missing footer address.
    expect(before.rendered.every((row) => row.missingFields.includes('postal_address'))).toBe(true)

    await updateWorkspacePostalAddress(em, ctx, WORKSPACE, POSTAL_ADDRESS)
    const after = await computeDraftState(em, ctx, campaign)
    expect(after.postalAddress).toBe(POSTAL_ADDRESS)
    expect(after.rendered.every((row) => !row.missingFields.includes('postal_address'))).toBe(true)
    // Setting the address changes the reviewed content (footer + settings).
    expect(after.contentHash).not.toBe(before.contentHash)
  })

  it('approval passes once the address is set and freezes it into footer and snapshot', async () => {
    const { em, campaign } = await setupWithoutAddress()
    await updateWorkspacePostalAddress(em, ctx, WORKSPACE, POSTAL_ADDRESS)
    const draft = await computeDraftState(em, ctx, campaign)
    const result = await approveCampaign(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: draft.contentHash,
    })
    expect(result.version.version).toBe(1)
    const snapshot = result.version.snapshot as Record<string, unknown>
    expect((snapshot.settings as Record<string, unknown>).postal_address).toBe(POSTAL_ADDRESS)
    const frozen = em.table(GtmRenderedMessage)
    expect(frozen.length).toBeGreaterThan(0)
    expect(frozen.every((row) => (row.bodyText ?? '').includes(POSTAL_ADDRESS))).toBe(true)
    expect(frozen.every((row) => (row.bodyText ?? '').includes('[[unsubscribe_url]]'))).toBe(true)
  })
})

describe('draft-state determinism', () => {
  it('the draft content hash is stable across recomputations and sensitive to template edits', async () => {
    const { em, campaign } = await setup()
    const a = await computeDraftState(em, ctx, campaign)
    const b = await computeDraftState(em, ctx, campaign)
    expect(a.contentHash).toBe(b.contentHash)

    await updateCampaignTemplate(em, ctx, campaign.id, {
      subject: 'Different {{first_name}}',
      body: 'Different body',
    })
    const c = await computeDraftState(em, ctx, campaign)
    expect(c.contentHash).not.toBe(a.contentHash)
  })

  it('only accepted candidates sourced by the campaign play are considered', async () => {
    const em = new FakeEm()
    const play = await seedPlay(em)
    const otherPlay = await seedPlay(em)
    const run = await seedRun(em, play)
    const otherRun = await seedRun(em, otherPlay)
    const inPlay = await seedCandidate(em, run)
    await seedCandidate(em, run, { fitStatus: 'rejected' })
    await seedCandidate(em, otherRun)
    const { campaign } = await createCampaign(em, ctx, {
      workspaceId: WORKSPACE,
      playId: play.id,
      name: 'Scoping',
    })
    const draft = await computeDraftState(em, ctx, campaign)
    expect(draft.consideredCandidateIds).toEqual([inPlay.id])
  })
})
