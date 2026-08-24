import { EmailUnsubscribe } from '../../../email/data/schema'
import {
  GtmAuditEvent,
  GtmCandidate,
  GtmCandidateMatch,
  GtmContactPoint,
  GtmEvidence,
  GtmSuppression,
} from '../../data/entities'
import {
  auditReviewedLeadExport,
  buildReviewedLeadExport,
  qualificationDiagnostics,
} from '../candidate-export'
import { hashAddress } from '../campaign/exclusions'
import { gtmCandidatesBodySchema } from '../../data/validators'
import { FakeEm } from './support/fake-em'
import {
  ORG,
  OTHER_ORG,
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
  requestId: 'r26-request',
}

async function seedAcceptedMatch(
  em: FakeEm,
  overrides: Partial<{
    entityKind: string
    email: string
    verificationState: string
    exportAllowed: boolean
    organizationId: string
    fitStatus: string
    fitScore: string
    rejectReason: string | null
    qualificationReason: string
  }> = {},
) {
  const play = await seedPlay(em)
  const run = await seedRun(em, play)
  const candidate = await seedCandidate(em, run, {
    email: null,
    evidenceClaim: null,
    fitStatus: overrides.fitStatus ?? 'accepted',
  })
  candidate.entityKind = overrides.entityKind ?? 'person'
  candidate.organizationId = overrides.organizationId ?? ORG
  candidate.identity = {
    name: 'Alex Example',
    title: 'VP Growth',
    company: 'Example Dynamics LLC',
    linkedin_url: 'https://www.linkedin.com/in/alex-example',
  }
  const match = em.create(GtmCandidateMatch, {
    organizationId: overrides.organizationId ?? ORG,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    playId: play.id,
    researchRunId: run.id,
    candidateId: candidate.id,
    fitStatus: overrides.fitStatus ?? 'accepted',
    fitScore: overrides.fitScore ?? '93',
    rejectReason: overrides.rejectReason ?? null,
    qualification: { reason: overrides.qualificationReason ?? 'Hiring signals align with the frozen play.' },
  })
  em.persist(match)
  em.persist(em.create(GtmContactPoint, {
    organizationId: overrides.organizationId ?? ORG,
    tenantId: TENANT,
    candidateId: candidate.id,
    channel: 'email',
    value: overrides.email ?? 'alex@example.test',
    verificationState: overrides.verificationState ?? 'verified',
    verifiedAt: new Date('2026-08-23T12:00:00.000Z'),
  }))
  em.persist(em.create(GtmEvidence, {
    organizationId: overrides.organizationId ?? ORG,
    tenantId: TENANT,
    candidateId: candidate.id,
    researchRunId: run.id,
    claim: 'Synthetic hiring evidence',
    sourceUrl: 'https://example.test/evidence',
    observedAt: new Date('2026-08-22T12:00:00.000Z'),
    license: { export: overrides.exportAllowed ?? true },
  }))
  await em.flush()
  return { play, run, candidate, match }
}

describe('qualificationDiagnostics', () => {
  it('counts current verdicts and rejected reasons without inventing missing causes', () => {
    expect(qualificationDiagnostics([
      { fitStatus: 'accepted', rejectReason: null },
      { fitStatus: 'review', rejectReason: 'missing_decisive_evidence' },
      { fitStatus: 'rejected', rejectReason: 'outside_geography' },
      { fitStatus: 'rejected', rejectReason: 'outside_geography' },
      { fitStatus: 'rejected', rejectReason: null },
      { fitStatus: 'rejected', rejectReason: 'Alex asked not to be included' },
      { fitStatus: 'unscored', rejectReason: null },
    ] as GtmCandidateMatch[])).toEqual({
      scored: 6,
      accepted: 1,
      review: 1,
      rejected: 4,
      unscored: 1,
      qualification_rate: 1 / 6,
      by_reason: { outside_geography: 2, unspecified: 1, manual_review: 1 },
    })
  })
})

describe('candidate export validator', () => {
  it('requires the explicit play/workspace scope and server-injected idempotency key', () => {
    expect(gtmCandidatesBodySchema.safeParse({
      noliUserId: USER,
      op: 'export',
      workspaceId: WORKSPACE,
      playId: 'eeeeeeee-6666-4666-8666-666666666666',
      idempotency_key: 'r26-export',
    }).success).toBe(true)
    expect(gtmCandidatesBodySchema.safeParse({ noliUserId: USER, op: 'export' }).success).toBe(false)
  })
})

describe('buildReviewedLeadExport', () => {
  it('exports only the latest accepted person with verified email and export-permitted evidence', async () => {
    const em = new FakeEm()
    const { play, candidate } = await seedAcceptedMatch(em)

    const result = await buildReviewedLeadExport(em, ctx, { workspaceId: WORKSPACE, playId: play.id })

    expect(result).toMatchObject({ considered: 1, exported: 1, truncated: false, skipped_by_reason: {} })
    expect(result.exportedCandidateIds).toEqual([candidate.id])
    expect(result.rows).toEqual([{
      name: 'Alex Example',
      title: 'VP Growth',
      company: 'Example Dynamics LLC',
      profile_url: 'https://www.linkedin.com/in/alex-example',
      verified_email: 'alex@example.test',
      fit_score: 93,
      fit_status: 'accepted',
      why_them: 'Hiring signals align with the frozen play.',
      evidence_source_urls: ['https://example.test/evidence'],
      latest_observed_at: '2026-08-22T12:00:00.000Z',
      verification_state: 'verified',
    }])
  })

  it('uses only the latest contextual verdict for a candidate', async () => {
    const em = new FakeEm()
    const { play, candidate, match } = await seedAcceptedMatch(em)
    const laterRun = await seedRun(em, play)
    const laterCreatedAt = new Date(match.createdAt.getTime() + 1_000)
    em.persist(em.create(GtmCandidateMatch, {
      organizationId: ORG,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      playId: play.id,
      researchRunId: laterRun.id,
      candidateId: candidate.id,
      fitStatus: 'rejected',
      fitScore: '20',
      rejectReason: 'outside_geography',
      // Stay later than the seeded verdict regardless of the wall clock on
      // the runner (the old fixed timestamp became earlier after midnight).
      createdAt: laterCreatedAt,
    }))
    await em.flush()

    const result = await buildReviewedLeadExport(em, ctx, { workspaceId: WORKSPACE, playId: play.id })
    expect(result).toMatchObject({ considered: 0, exported: 0, rows: [] })
  })

  it('fails closed for company rows, non-verified addresses, missing rights, suppressions, and legacy unsubscribes', async () => {
    const scenarios = [
      { overrides: { entityKind: 'company' }, reason: 'not_a_person' },
      { overrides: { verificationState: 'found' }, reason: 'no_verified_email' },
      { overrides: { exportAllowed: false }, reason: 'export_rights_unconfirmed' },
    ] as const
    for (const scenario of scenarios) {
      const em = new FakeEm()
      const { play } = await seedAcceptedMatch(em, scenario.overrides)
      const result = await buildReviewedLeadExport(em, ctx, { workspaceId: WORKSPACE, playId: play.id })
      expect(result.exported).toBe(0)
      expect(result.skipped_by_reason[scenario.reason]).toBe(1)
    }

    const suppressedEm = new FakeEm()
    const suppressed = await seedAcceptedMatch(suppressedEm, { email: 'blocked@example.test' })
    suppressedEm.persist(suppressedEm.create(GtmSuppression, {
      organizationId: ORG,
      tenantId: TENANT,
      channel: 'email',
      addressHash: hashAddress('blocked@example.test'),
      scope: 'org',
      reason: 'unsubscribe',
    }))
    await suppressedEm.flush()
    const suppressedResult = await buildReviewedLeadExport(suppressedEm, ctx, {
      workspaceId: WORKSPACE,
      playId: suppressed.play.id,
    })
    expect(suppressedResult.skipped_by_reason.suppressed_unsubscribe).toBe(1)

    const legacyEm = new FakeEm()
    const legacy = await seedAcceptedMatch(legacyEm, { email: 'legacy@example.test' })
    legacyEm.persist(legacyEm.create(EmailUnsubscribe, {
      organizationId: ORG,
      tenantId: TENANT,
      email: 'legacy@example.test',
    }))
    await legacyEm.flush()
    const legacyResult = await buildReviewedLeadExport(legacyEm, ctx, {
      workspaceId: WORKSPACE,
      playId: legacy.play.id,
    })
    expect(legacyResult.skipped_by_reason.suppressed_unsubscribe).toBe(1)
  })

  it('does not let one export-permitted evidence row launder a missing-rights row', async () => {
    const em = new FakeEm()
    const { play, run, candidate } = await seedAcceptedMatch(em)
    em.persist(em.create(GtmEvidence, {
      organizationId: ORG,
      tenantId: TENANT,
      candidateId: candidate.id,
      researchRunId: run.id,
      claim: 'Second synthetic source without an export grant',
      sourceUrl: 'https://example.test/restricted',
      license: null,
    }))
    await em.flush()

    const result = await buildReviewedLeadExport(em, ctx, { workspaceId: WORKSPACE, playId: play.id })
    expect(result).toMatchObject({ exported: 0, skipped_by_reason: { export_rights_unconfirmed: 1 } })
  })

  it('does not cross tenant or organization scope', async () => {
    const em = new FakeEm()
    const { play } = await seedAcceptedMatch(em)
    await expect(buildReviewedLeadExport(em, { ...ctx, organizationId: OTHER_ORG }, {
      workspaceId: WORKSPACE,
      playId: play.id,
    })).rejects.toMatchObject({ code: 'scope_not_found' })
  })

  it('reports rather than hiding rows beyond the 1,000-row export cap', async () => {
    const em = new FakeEm()
    const play = await seedPlay(em)
    const run = await seedRun(em, play)
    for (let index = 0; index < 1001; index += 1) {
      const candidate = em.create(GtmCandidate, {
        organizationId: ORG,
        tenantId: TENANT,
        researchRunId: run.id,
        workspaceId: WORKSPACE,
        entityKind: 'person',
        identity: { name: `Synthetic export ${index}` },
        dedupeKey: `r26-cap-${index}`,
        fitStatus: 'accepted',
      })
      em.persist(candidate)
      em.persist(em.create(GtmCandidateMatch, {
        organizationId: ORG,
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        playId: play.id,
        researchRunId: run.id,
        candidateId: candidate.id,
        fitStatus: 'accepted',
        fitScore: String(100 - (index % 100)),
      }))
      em.persist(em.create(GtmContactPoint, {
        organizationId: ORG,
        tenantId: TENANT,
        candidateId: candidate.id,
        channel: 'email',
        value: `synthetic-${index}@example.test`,
        verificationState: 'verified',
      }))
      em.persist(em.create(GtmEvidence, {
        organizationId: ORG,
        tenantId: TENANT,
        candidateId: candidate.id,
        researchRunId: run.id,
        claim: 'Synthetic export-permitted evidence',
        license: { export: true },
      }))
    }
    await em.flush()

    const result = await buildReviewedLeadExport(em, ctx, { workspaceId: WORKSPACE, playId: play.id })
    expect(result).toMatchObject({
      considered: 1001,
      exported: 1000,
      truncated: true,
      skipped_by_reason: { export_cap: 1 },
    })
    expect(result.rows).toHaveLength(1000)
  })
})

describe('auditReviewedLeadExport', () => {
  it('records count/hash evidence without copying exported PII', async () => {
    const em = new FakeEm()
    const { play } = await seedAcceptedMatch(em)
    const result = await buildReviewedLeadExport(em, ctx, { workspaceId: WORKSPACE, playId: play.id })
    const audit = await auditReviewedLeadExport(em, ctx, {
      workspaceId: WORKSPACE,
      playId: play.id,
      idempotencyKey: 'r26-export-1',
      result,
    })
    const replay = await auditReviewedLeadExport(em, ctx, {
      workspaceId: WORKSPACE,
      playId: play.id,
      idempotencyKey: 'r26-export-1',
      result,
    })

    expect(audit).toMatchObject({
      action: 'gtm.candidates.exported',
      objectType: 'gtm_play',
      objectId: play.id,
      actorUserId: USER,
    })
    const serialized = JSON.stringify(audit.metadata)
    expect(serialized).not.toContain('alex@example.test')
    expect(serialized).not.toContain('Alex Example')
    expect(serialized).not.toContain('Example Dynamics')
    expect(serialized).not.toContain('r26-export-1')
    expect(serialized).toMatch(/candidate_set_hash/)
    expect(serialized).toMatch(/result_hash/)
    expect(replay.id).toBe(audit.id)
    expect(em.table(GtmAuditEvent)).toHaveLength(1)

    await expect(auditReviewedLeadExport(em, ctx, {
      workspaceId: WORKSPACE,
      playId: play.id,
      idempotencyKey: 'r26-export-1',
      result: { ...result, exported: 0, rows: [], exportedCandidateIds: [] },
    })).rejects.toMatchObject({ code: 'idempotency_conflict' })

    await expect(auditReviewedLeadExport(em, ctx, {
      workspaceId: WORKSPACE,
      playId: play.id,
      idempotencyKey: 'r26-export-1',
      result: { ...result, rows: result.rows.map((row) => ({ ...row, verified_email: 'changed@example.test' })) },
    })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
})
