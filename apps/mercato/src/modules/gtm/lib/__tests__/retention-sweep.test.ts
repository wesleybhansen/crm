import { FakeEm } from './support/fake-em'
import { sweepExpiredCandidates } from '../retention/sweep'
import {
  GtmAuditEvent,
  GtmCandidate,
  GtmCandidateRelation,
  GtmContactPoint,
  GtmEnrollment,
  GtmEvidence,
} from '../../data/entities'

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '66666666-6666-4666-8666-666666666666'
const TENANT = '22222222-2222-4222-8222-222222222222'
const WORKSPACE = '33333333-3333-4333-8333-333333333333'
const RUN = '44444444-4444-4444-8444-444444444444'
const CAMPAIGN = '77777777-7777-4777-8777-777777777777'
const VERSION = '88888888-8888-4888-8888-888888888888'

const NOW = new Date('2026-07-23T12:00:00.000Z')
const PAST = new Date('2026-07-01T00:00:00.000Z')
const FUTURE = new Date('2026-09-01T00:00:00.000Z')

let seq = 0

async function makeCandidate(
  em: FakeEm,
  options: {
    org?: string
    name?: string
    expiresAt?: Date | null
    promotedContactId?: string | null
    evidence?: number
    points?: number
  },
): Promise<GtmCandidate> {
  const name = options.name ?? `Synthetic Candidate ${seq}`
  const candidate = em.create(GtmCandidate, {
    organizationId: options.org ?? ORG_A,
    tenantId: TENANT,
    researchRunId: RUN,
    workspaceId: WORKSPACE,
    entityKind: 'person',
    identity: { name },
    dedupeKey: `dedupe-${seq++}`,
    fitStatus: 'accepted',
    retentionExpiresAt: options.expiresAt === undefined ? PAST : options.expiresAt,
    promotedContactId: options.promotedContactId ?? null,
  })
  em.persist(candidate)
  for (let i = 0; i < (options.evidence ?? 0); i += 1) {
    em.persist(
      em.create(GtmEvidence, {
        organizationId: candidate.organizationId,
        tenantId: TENANT,
        candidateId: candidate.id,
        claim: `synthetic claim ${i} about ${name}`,
        confidence: '0.8',
      }),
    )
  }
  for (let i = 0; i < (options.points ?? 0); i += 1) {
    em.persist(
      em.create(GtmContactPoint, {
        organizationId: candidate.organizationId,
        tenantId: TENANT,
        candidateId: candidate.id,
        channel: 'email',
        value: `synthetic-${seq}-${i}@retention.example`,
        verificationState: 'found',
      }),
    )
  }
  await em.flush()
  return candidate
}

async function enroll(em: FakeEm, candidate: GtmCandidate, status = 'stopped'): Promise<void> {
  em.persist(
    em.create(GtmEnrollment, {
      organizationId: candidate.organizationId,
      tenantId: TENANT,
      campaignId: CAMPAIGN,
      campaignVersionId: VERSION,
      candidateId: candidate.id,
      status,
    }),
  )
  await em.flush()
}

describe('sweepExpiredCandidates', () => {
  it('deletes only expired, never-promoted, non-enrolled candidates and cascades their rows', async () => {
    const em = new FakeEm()
    const expired = await makeCandidate(em, { evidence: 2, points: 1 })
    const promoted = await makeCandidate(em, {
      promotedContactId: '99999999-9999-4999-8999-999999999999',
      evidence: 1,
      points: 1,
    })
    const enrolled = await makeCandidate(em, { evidence: 1, points: 1 })
    await enroll(em, enrolled, 'stopped')
    const fresh = await makeCandidate(em, { expiresAt: FUTURE, evidence: 1 })
    const noRetention = await makeCandidate(em, { expiresAt: null })
    em.persist(
      em.create(GtmCandidateRelation, {
        organizationId: ORG_A,
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        playId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        researchRunId: RUN,
        parentMatchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        parentCandidateId: promoted.id,
        childCandidateId: expired.id,
        providerOperationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        relationshipKind: 'current_employee',
        observedTitle: 'Synthetic Decision Maker',
        confidence: '0.950',
        observedAt: PAST,
      }),
    )
    await em.flush()

    const result = await sweepExpiredCandidates(em, { now: NOW })

    // Result shape gained the post-campaign, manual-draft, and legal-hold
    // counters (review H7 / M11); the hard-delete counts are unchanged.
    expect(result).toEqual({
      candidatesDeleted: 1,
      evidenceDeleted: 2,
      contactPointsDeleted: 1,
      skippedLegalHold: 0,
      postCampaignAnonymized: 0,
      postCampaignContactPointsAnonymized: 0,
      postCampaignRenderedAnonymized: 0,
      expiredManualDraftsDeleted: 0,
      relationsDeleted: 1,
      manualDraftsDeleted: 0,
      skippedEnrolled: 1,
      batches: 1,
    })

    const remaining = em.table(GtmCandidate).map((candidate) => candidate.id)
    expect(remaining).not.toContain(expired.id)
    expect(remaining).toEqual(
      expect.arrayContaining([promoted.id, enrolled.id, fresh.id, noRetention.id]),
    )

    // cascade: no evidence or contact points survive for the deleted candidate
    expect(em.table(GtmEvidence).some((row) => row.candidateId === expired.id)).toBe(false)
    expect(em.table(GtmContactPoint).some((row) => row.candidateId === expired.id)).toBe(false)
    expect(em.table(GtmCandidateRelation)).toHaveLength(0)
    // untouched candidates keep their rows
    expect(em.table(GtmEvidence).some((row) => row.candidateId === promoted.id)).toBe(true)
    expect(em.table(GtmContactPoint).some((row) => row.candidateId === enrolled.id)).toBe(true)
  })

  it('writes one audit event per swept batch with counts and NO PII', async () => {
    const em = new FakeEm()
    await makeCandidate(em, { name: 'Privet Person', evidence: 1, points: 2 })
    await makeCandidate(em, { name: 'Second Person', evidence: 2, points: 1 })

    const result = await sweepExpiredCandidates(em, { now: NOW })
    expect(result.candidatesDeleted).toBe(2)
    expect(result.batches).toBe(1)

    const audits = em.table(GtmAuditEvent)
    expect(audits).toHaveLength(1)
    const audit = audits[0]
    expect(audit.actor).toBe('system')
    expect(audit.action).toBe('gtm.candidate.retention_sweep')
    expect(audit.objectType).toBe('gtm_candidate')
    expect(audit.organizationId).toBe(ORG_A)
    expect(audit.metadata).toEqual({
      candidates_deleted: 2,
      evidence_deleted: 3,
      contact_points_deleted: 3,
      manual_drafts_deleted: 0,
      relations_deleted: 0,
      cutoff: NOW.toISOString(),
    })
    // no identity material leaks into the audit trail
    const serialized = JSON.stringify(audit.metadata)
    expect(serialized).not.toContain('Person')
    expect(serialized).not.toContain('@retention.example')
  })

  it('audits per (org, tenant) batch when multiple orgs sweep together', async () => {
    const em = new FakeEm()
    await makeCandidate(em, { org: ORG_A })
    await makeCandidate(em, { org: ORG_A })
    await makeCandidate(em, { org: ORG_B })

    const result = await sweepExpiredCandidates(em, { now: NOW })

    expect(result.candidatesDeleted).toBe(3)
    expect(result.batches).toBe(2)
    const audits = em.table(GtmAuditEvent)
    expect(audits).toHaveLength(2)
    const byOrg = Object.fromEntries(
      audits.map((audit) => [audit.organizationId, audit.metadata?.candidates_deleted]),
    )
    expect(byOrg).toEqual({ [ORG_A]: 2, [ORG_B]: 1 })
  })

  it('scopes to one organization when orgId is given', async () => {
    const em = new FakeEm()
    const inOrgA = await makeCandidate(em, { org: ORG_A })
    const inOrgB = await makeCandidate(em, { org: ORG_B })

    const result = await sweepExpiredCandidates(em, { orgId: ORG_A, now: NOW })

    expect(result.candidatesDeleted).toBe(1)
    const remaining = em.table(GtmCandidate).map((candidate) => candidate.id)
    expect(remaining).not.toContain(inOrgA.id)
    expect(remaining).toContain(inOrgB.id)
  })

  it('is idempotent: a second sweep finds nothing and writes no audit event', async () => {
    const em = new FakeEm()
    await makeCandidate(em, { evidence: 1, points: 1 })

    const first = await sweepExpiredCandidates(em, { now: NOW })
    expect(first.candidatesDeleted).toBe(1)
    expect(em.table(GtmAuditEvent)).toHaveLength(1)

    const second = await sweepExpiredCandidates(em, { now: NOW })
    expect(second).toEqual({
      candidatesDeleted: 0,
      evidenceDeleted: 0,
      contactPointsDeleted: 0,
      skippedLegalHold: 0,
      postCampaignAnonymized: 0,
      postCampaignContactPointsAnonymized: 0,
      postCampaignRenderedAnonymized: 0,
      expiredManualDraftsDeleted: 0,
      relationsDeleted: 0,
      manualDraftsDeleted: 0,
      skippedEnrolled: 0,
      batches: 0,
    })
    expect(em.table(GtmAuditEvent)).toHaveLength(1)
  })
})

/*
 * Review H7 (post-campaign retention + expired manual drafts) and M11 (legal
 * holds). Same synthetic fixtures as above.
 */
describe('sweepExpiredCandidates: post-campaign rule, manual drafts, legal holds', () => {
  const { GtmDeletionRequest, GtmManualOutreachDraft, GtmRenderedMessage } = jest.requireActual('../../data/entities')
  const LONG_AGO = new Date('2026-03-01T00:00:00.000Z')
  const RECENT = new Date('2026-07-20T00:00:00.000Z')

  const OTHER_CAMPAIGN = '78787878-7878-4787-8787-787878787878'

  async function enrollWith(
    em: FakeEm,
    candidate: GtmCandidate,
    options: { status: string; stoppedAt?: Date | null; campaignId?: string },
  ): Promise<GtmEnrollment> {
    const enrollment = em.create(GtmEnrollment, {
      organizationId: candidate.organizationId,
      tenantId: TENANT,
      campaignId: options.campaignId ?? CAMPAIGN,
      campaignVersionId: VERSION,
      candidateId: candidate.id,
      status: options.status,
      stoppedAt: options.stoppedAt ?? null,
    })
    em.persist(enrollment)
    em.persist(
      em.create(GtmRenderedMessage, {
        organizationId: candidate.organizationId,
        tenantId: TENANT,
        campaignVersionId: VERSION,
        enrollmentId: enrollment.id,
        stepId: '99999999-9999-4999-8999-999999999999',
        subject: 'Quick question',
        bodyHtml: '<p>Hi there</p>',
        bodyText: 'Hi there',
        contentHash: 'hash',
      }),
    )
    await em.flush()
    return enrollment
  }

  it('anonymizes contact points, rendered bodies, and identity once every enrollment finished > 90 days ago', async () => {
    const em = new FakeEm()
    const finished = await makeCandidate(em, { name: 'Finished Long Ago', points: 1, evidence: 1 })
    const enrollment = await enrollWith(em, finished, { status: 'stopped', stoppedAt: LONG_AGO })
    const recent = await makeCandidate(em, { name: 'Finished Recently', points: 1 })
    await enrollWith(em, recent, { status: 'completed', stoppedAt: RECENT })
    const stillActive = await makeCandidate(em, { name: 'Still Active', points: 1 })
    await enrollWith(em, stillActive, { status: 'stopped', stoppedAt: LONG_AGO })
    await enrollWith(em, stillActive, { status: 'active', campaignId: OTHER_CAMPAIGN })

    const result = await sweepExpiredCandidates(em, { now: NOW })
    expect(result).toMatchObject({
      candidatesDeleted: 0,
      postCampaignAnonymized: 1,
      postCampaignContactPointsAnonymized: 1,
      postCampaignRenderedAnonymized: 1,
      skippedEnrolled: 2,
    })
    // The enrollment (outreach history) survives; the personal data does not.
    expect(await em.find(GtmEnrollment, { candidateId: finished.id })).toHaveLength(1)
    expect(finished.identity).toMatchObject({ removed: true })
    expect(finished.identity.name).toBeUndefined()
    expect(finished.deletedAt).toBeInstanceOf(Date)
    const point = (await em.find(GtmContactPoint, { candidateId: finished.id }))[0]
    expect(point.value).toMatch(/^removed:/)
    expect(point.deletedAt).toBeInstanceOf(Date)
    const rendered = (await em.find(GtmRenderedMessage, { enrollmentId: enrollment.id }))[0]
    expect(rendered).toMatchObject({ subject: null, bodyHtml: null, bodyText: null })
    expect(recent.identity).toMatchObject({ name: 'Finished Recently' })
    expect(stillActive.identity).toMatchObject({ name: 'Still Active' })
    for (const audit of await em.find(GtmAuditEvent, {})) {
      expect(JSON.stringify(audit)).not.toContain('Finished Long Ago')
    }
    // Idempotent: the anonymized husk is not processed again.
    const second = await sweepExpiredCandidates(em, { now: NOW })
    expect(second.postCampaignAnonymized).toBe(0)
  })

  it('bounds the post-campaign batch per sweep', async () => {
    const em = new FakeEm()
    for (let i = 0; i < 3; i += 1) {
      const candidate = await makeCandidate(em, { points: 1 })
      await enrollWith(em, candidate, { status: 'stopped', stoppedAt: LONG_AGO })
    }
    const first = await sweepExpiredCandidates(em, { now: NOW, postCampaignBatch: 2 })
    expect(first.postCampaignAnonymized).toBe(2)
    const second = await sweepExpiredCandidates(em, { now: NOW, postCampaignBatch: 2 })
    expect(second.postCampaignAnonymized).toBe(1)
  })

  it('hard-deletes expired manual outreach drafts regardless of candidate state', async () => {
    const em = new FakeEm()
    const enrolled = await makeCandidate(em, { expiresAt: FUTURE })
    await enrollWith(em, enrolled, { status: 'active' })
    const promoted = await makeCandidate(em, { expiresAt: FUTURE, promotedContactId: '12121212-1212-4121-8121-121212121212' })
    const draftFor = (candidate: GtmCandidate, expiresAt: Date) =>
      em.create(GtmManualOutreachDraft, {
        organizationId: candidate.organizationId,
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        playId: '13131313-1313-4131-8131-131313131313',
        candidateId: candidate.id,
        matchId: '14141414-1414-4141-8141-141414141414',
        channel: 'linkedin',
        destinationUrl: 'https://profile.example/x',
        bodyText: 'Hi, saw your post about synthetic things',
        contentHash: 'c',
        evidenceHash: 'e',
        idempotencyKeyHash: `k-${seq++}`,
        status: 'draft',
        retentionExpiresAt: expiresAt,
      })
    const expiredA = draftFor(enrolled, PAST)
    const expiredB = draftFor(promoted, PAST)
    const live = draftFor(promoted, FUTURE)
    em.persist(expiredA)
    em.persist(expiredB)
    em.persist(live)
    await em.flush()

    const result = await sweepExpiredCandidates(em, { now: NOW })
    expect(result.expiredManualDraftsDeleted).toBe(2)
    expect(await em.find(GtmManualOutreachDraft, {})).toEqual([live])
    expect(await em.find(GtmAuditEvent, { action: 'gtm.manual_outreach_draft.retention_sweep' })).toHaveLength(1)
  })

  it('skips candidates covered by a non-completed legal-hold request', async () => {
    const em = new FakeEm()
    const held = await makeCandidate(em, { points: 1 })
    const heldPoint = (await em.find(GtmContactPoint, { candidateId: held.id }))[0]
    const free = await makeCandidate(em, { points: 1 })
    const heldEnrolled = await makeCandidate(em, { points: 1 })
    await enrollWith(em, heldEnrolled, { status: 'stopped', stoppedAt: LONG_AGO })
    // Removed-then-held: identity stamped by a removal whose request is held.
    const stampedRequest = em.create(GtmDeletionRequest, {
      organizationId: ORG_A,
      tenantId: TENANT,
      idempotencyKey: 'tenant-email:x',
      scope: 'tenant_email',
      addressHash: 'f'.repeat(64),
      status: 'completed',
      legalHold: true,
      requestedAt: NOW,
    })
    heldEnrolled.identity = { removed: true, removal_request_id: stampedRequest.id }
    const { hashAddress } = jest.requireActual('../campaign/exclusions')
    const holdByHash = em.create(GtmDeletionRequest, {
      organizationId: ORG_A,
      tenantId: TENANT,
      idempotencyKey: 'tenant-email:y',
      scope: 'tenant_email',
      addressHash: hashAddress(heldPoint.value),
      status: 'partial',
      legalHold: true,
      requestedAt: NOW,
    })
    em.persist(stampedRequest)
    em.persist(holdByHash)
    em.persist(heldEnrolled)
    await em.flush()

    const result = await sweepExpiredCandidates(em, { now: NOW })
    expect(result).toMatchObject({ candidatesDeleted: 1, skippedLegalHold: 2, postCampaignAnonymized: 0 })
    expect(await em.find(GtmCandidate, { id: held.id })).toHaveLength(1)
    expect(await em.find(GtmCandidate, { id: free.id })).toHaveLength(0)
    expect(heldEnrolled.deletedAt ?? null).toBeNull()

    // Lifting the hold releases the rows on the next sweep.
    holdByHash.legalHold = false
    stampedRequest.legalHold = false
    const released = await sweepExpiredCandidates(em, { now: NOW })
    expect(released).toMatchObject({ candidatesDeleted: 1, skippedLegalHold: 0, postCampaignAnonymized: 1 })
  })
})
