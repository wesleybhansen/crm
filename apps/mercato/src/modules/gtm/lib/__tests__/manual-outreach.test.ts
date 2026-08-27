import crypto from 'crypto'
import {
  GtmAuditEvent,
  GtmCandidateMatch,
  GtmContactPoint,
  GtmEvidence,
  GtmManualOutreachDraft,
} from '../../data/entities'
import {
  draftManualOutreachMessage,
  listManualOutreachDrafts,
  markManualOutreachDraft,
  prepareManualOutreachDraft,
  storeManualOutreachDraft,
} from '../manual-outreach'
import { FakeModel } from './support/fake-model'
import { FakeEm } from './support/fake-em'
import {
  ORG,
  TENANT,
  USER,
  WORKSPACE,
  seedCandidate,
  seedPlay,
  seedRun,
} from './support/campaign-fixtures'

const ctx = {
  organizationId: ORG,
  tenantId: TENANT,
  userId: USER,
  requestId: 'manual-outreach-test',
}

async function consumerContext(em: FakeEm, licenseOverride: Record<string, unknown> = {}) {
  const play = await seedPlay(em)
  play.marketType = 'b2c'
  play.entityUnit = 'people'
  play.signalKind = 'social_engagement'
  play.audience = 'Adults who publicly asked for a local home-design workshop follow-up'
  play.signal = 'Public workshop follow-up request'
  play.geography = 'United States'
  const run = await seedRun(em, play)
  const candidate = await seedCandidate(em, run, { email: null, evidenceClaim: null })
  candidate.entityKind = 'person'
  candidate.identity = {
    name: 'Avery Example',
    urls: ['https://profiles.example/avery-home-design'],
  }
  const match = em.create(GtmCandidateMatch, {
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    playId: play.id,
    researchRunId: run.id,
    candidateId: candidate.id,
    fitStatus: 'accepted',
    fitScore: '94',
    qualification: { reason: 'The public request matches the workshop play.' },
  })
  em.persist(match)
  em.persist(em.create(GtmContactPoint, {
    organizationId: ORG,
    tenantId: TENANT,
    candidateId: candidate.id,
    channel: 'public_profile',
    value: 'https://profiles.example/avery-home-design',
    verificationState: 'found',
  }))
  em.persist(em.create(GtmEvidence, {
    organizationId: ORG,
    tenantId: TENANT,
    candidateId: candidate.id,
    researchRunId: run.id,
    claim: 'Publicly requested follow-up information after a neighborhood home-design workshop.',
    sourceUrl: 'https://events.example/workshops/home-design/avery-example',
    observedAt: new Date('2026-08-26T12:00:00.000Z'),
    license: {
      customer_display: true,
      export: true,
      manual_outreach_allowed: true,
      ...licenseOverride,
    },
  }))
  await em.flush()
  return { play, candidate, match }
}

describe('manual-only consumer outreach', () => {
  it('prepares, meters, stores, replays, and records manual actions without a send operation', async () => {
    const em = new FakeEm()
    const { play, candidate, match } = await consumerContext(em)
    const prepared = await prepareManualOutreachDraft(em, ctx, {
      workspaceId: WORKSPACE,
      playId: play.id,
      candidateId: candidate.id,
      matchId: match.id,
      channel: 'public_profile',
      idempotencyKey: 'manual-draft-1',
    })
    expect(prepared.destinationUrl).toBe('https://profiles.example/avery-home-design')

    const meter = jest.fn()
    const drafted = await draftManualOutreachMessage({
      model: new FakeModel(() => ({
        text: JSON.stringify({
          body: 'Hi Avery, I saw your public request for more information after the neighborhood home-design workshop. I have a concise local planning guide that may help. Would it be useful if I shared it here? No problem if the timing is not right.',
        }),
        model: 'fake-gemini',
        tokensIn: 120,
        tokensOut: 50,
      })),
      meter,
    }, prepared)
    expect(meter).toHaveBeenCalledWith(expect.objectContaining({
      feature: 'gtm-manual-outreach-draft',
      status: 'succeeded',
    }))

    const stored = await storeManualOutreachDraft(em, ctx, prepared, drafted)
    expect(stored).toMatchObject({ replayed: false, draft: { status: 'draft', channel: 'public_profile' } })
    expect(em.table(GtmManualOutreachDraft)).toHaveLength(1)

    const replayContext = await prepareManualOutreachDraft(em, ctx, {
      workspaceId: WORKSPACE,
      playId: play.id,
      candidateId: candidate.id,
      matchId: match.id,
      channel: 'public_profile',
      idempotencyKey: 'manual-draft-1',
    })
    expect(replayContext.existing?.id).toBe(stored.draft.id)
    const marked = await markManualOutreachDraft(em, ctx, {
      draftId: stored.draft.id,
      action: 'copied',
    })
    expect(marked.status).toBe('copied')
    expect(marked.copied_at).toBeInstanceOf(Date)
    expect(em.table(GtmAuditEvent).map((row) => row.action)).toEqual([
      'gtm.manual_outreach_draft.created',
      'gtm.manual_outreach_draft.copied',
    ])
    expect(JSON.stringify(em.table(GtmAuditEvent))).not.toMatch(/body_text|Hi Avery/)

    await markManualOutreachDraft(em, ctx, {
      draftId: stored.draft.id,
      action: 'dismissed',
    })
    await expect(listManualOutreachDrafts(em, ctx, {
      workspaceId: WORKSPACE,
      playId: play.id,
    })).resolves.toEqual([])
  })

  it('blocks B2B plays and consumer evidence without exact manual rights', async () => {
    const businessEm = new FakeEm()
    const business = await consumerContext(businessEm)
    business.play.marketType = 'b2b'
    await expect(prepareManualOutreachDraft(businessEm, ctx, {
      workspaceId: WORKSPACE,
      playId: business.play.id,
      candidateId: business.candidate.id,
      matchId: business.match.id,
      channel: 'public_profile',
      idempotencyKey: 'business-manual',
    })).rejects.toMatchObject({ code: 'manual_outreach_unavailable' })

    const rightsEm = new FakeEm()
    const rights = await consumerContext(rightsEm, { manual_outreach_allowed: false })
    await expect(prepareManualOutreachDraft(rightsEm, ctx, {
      workspaceId: WORKSPACE,
      playId: rights.play.id,
      candidateId: rights.candidate.id,
      matchId: rights.match.id,
      channel: 'public_profile',
      idempotencyKey: 'missing-rights',
    })).rejects.toMatchObject({ code: 'evidence_rights_unconfirmed' })
  })

  it('fails closed for expired drafts and cross-scope idempotency races', async () => {
    const expiredEm = new FakeEm()
    const expiredScope = await consumerContext(expiredEm)
    const expiredPrepared = await prepareManualOutreachDraft(expiredEm, ctx, {
      workspaceId: WORKSPACE,
      playId: expiredScope.play.id,
      candidateId: expiredScope.candidate.id,
      matchId: expiredScope.match.id,
      channel: 'public_profile',
      idempotencyKey: 'expired-manual-draft',
    })
    const expiredStored = await storeManualOutreachDraft(expiredEm, ctx, expiredPrepared, {
      bodyText: 'Hi Avery, your public workshop question stood out. I have a short local guide that may help. Would you like me to share it here? No problem if not.',
      model: 'fixture-model',
      provenance: { outreach_mode: 'manual_only' },
    })
    const expiredRow = expiredEm.table(GtmManualOutreachDraft)[0]
    expiredRow.retentionExpiresAt = new Date('2020-01-01T00:00:00.000Z')

    await expect(prepareManualOutreachDraft(expiredEm, ctx, {
      workspaceId: WORKSPACE,
      playId: expiredScope.play.id,
      candidateId: expiredScope.candidate.id,
      matchId: expiredScope.match.id,
      channel: 'public_profile',
      idempotencyKey: 'expired-manual-draft',
    })).rejects.toMatchObject({ code: 'scope_not_found' })
    await expect(markManualOutreachDraft(expiredEm, ctx, {
      draftId: expiredStored.draft.id,
      action: 'opened',
    })).rejects.toMatchObject({ code: 'scope_not_found' })
    await expect(listManualOutreachDrafts(expiredEm, ctx, {
      workspaceId: WORKSPACE,
      playId: expiredScope.play.id,
    })).resolves.toEqual([])

    const racedEm = new FakeEm()
    const racedScope = await consumerContext(racedEm)
    const racedPrepared = await prepareManualOutreachDraft(racedEm, ctx, {
      workspaceId: WORKSPACE,
      playId: racedScope.play.id,
      candidateId: racedScope.candidate.id,
      matchId: racedScope.match.id,
      channel: 'public_profile',
      idempotencyKey: 'cross-scope-race',
    })
    racedEm.persist(racedEm.create(GtmManualOutreachDraft, {
      organizationId: ORG,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      playId: racedScope.play.id,
      candidateId: crypto.randomUUID(),
      matchId: racedScope.match.id,
      channel: 'public_profile',
      destinationUrl: 'https://profiles.example/another-person',
      bodyText: 'A different draft body that must never be replayed across candidates or scopes.',
      contentHash: crypto.randomUUID(),
      evidenceHash: crypto.randomUUID(),
      idempotencyKeyHash: crypto.createHash('sha256').update('cross-scope-race').digest('hex'),
      retentionExpiresAt: new Date(Date.now() + 60_000),
    }))
    await racedEm.flush()
    await expect(storeManualOutreachDraft(racedEm, ctx, racedPrepared, {
      bodyText: 'Hi Avery, I saw your public request and prepared a short, relevant resource. Would it be useful if I shared it here? No problem if the timing is not right.',
      model: 'fixture-model',
      provenance: { outreach_mode: 'manual_only' },
    })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
})
