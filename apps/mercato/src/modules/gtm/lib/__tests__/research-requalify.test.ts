import {
  GtmAuditEvent,
  GtmCandidate,
  GtmCandidateMatch,
  GtmEvidence,
  GtmResearchRun,
} from '../../data/entities'
import { FIT_SCORER_VERSION } from '../research/qualify'
import { requalifyResearchRun } from '../research/requalify'
import { FakeEm } from './support/fake-em'

const ORG = '10000000-0000-4000-8000-000000000001'
const TENANT = '20000000-0000-4000-8000-000000000001'
const WORKSPACE = '30000000-0000-4000-8000-000000000001'
const RUN_ID = '40000000-0000-4000-8000-000000000001'
const STARTED = new Date('2026-08-22T19:00:00.000Z')
const USER = '70000000-0000-4000-8000-000000000001'

async function seed(em: FakeEm) {
  const run = em.create(GtmResearchRun, {
    id: RUN_ID,
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    playId: '50000000-0000-4000-8000-000000000001',
    status: 'completed',
    startedAt: STARTED,
    inputSnapshot: {
      play: {
        entity_unit: 'companies',
        geography: 'San Diego County, California',
        provider_query: {
          industries: ['Dentistry', 'Medical Practices'],
          employee_ranges: ['2 to 50'],
          locations: ['San Diego County, California'],
        },
      },
    },
    providerPlan: {
      execution: {
        funnel: {
          target_accepted: 10,
          accepted: 0,
          review: 0,
          rejected: 3,
          by_reason: { required_criterion_mismatch: 3 },
        },
      },
    },
  })
  em.persist(run)

  const makeCandidate = (id: string, name: string, industry: string) => em.create(GtmCandidate, {
    id,
    organizationId: ORG,
    tenantId: TENANT,
    researchRunId: RUN_ID,
    workspaceId: WORKSPACE,
    entityKind: 'company',
    identity: {
      name,
      industry,
      location: '13465 Camino Canada, El Cajon, CA 92021',
    },
    dedupeKey: id,
    fitStatus: 'rejected',
    fitScore: '25',
    rejectReason: 'required_criterion_mismatch',
    qualificationVersion: 'fit-v4',
  })
  const dental = makeCandidate(
    '60000000-0000-4000-8000-000000000001',
    'Example Family Dental',
    'Dental clinic',
  )
  const vet = makeCandidate(
    '60000000-0000-4000-8000-000000000002',
    'Example Animal Hospital',
    'Veterinarian',
  )
  const manual = makeCandidate(
    '60000000-0000-4000-8000-000000000003',
    'Owner Reviewed Dental',
    'Dental clinic',
  )
  manual.fitStatus = 'accepted'
  manual.rejectReason = null
  for (const candidate of [dental, vet, manual]) em.persist(candidate)

  for (const candidate of [dental, vet, manual]) {
    em.persist(em.create(GtmEvidence, {
      organizationId: ORG,
      tenantId: TENANT,
      candidateId: candidate.id,
      claim: `${candidate.identity.name} appeared in the approved Google Maps result.`,
      sourceUrl: `https://www.google.com/maps/place/?q=place_id:${candidate.id}`,
      providerRef: { provider: 'dataforseo-google-maps' },
      observedAt: STARTED,
      confidence: '0.9',
      qualityStatus: 'strong',
      qualityIssues: [],
    }))
  }
  em.persist(em.create(GtmAuditEvent, {
    organizationId: ORG,
    tenantId: TENANT,
    actor: 'user_id',
    action: 'gtm.candidate.review_override',
    objectType: 'gtm_candidate',
    objectId: manual.id,
  }))
  await em.flush()
  return { run, dental, vet, manual }
}

describe('requalifyResearchRun', () => {
  it('rescales stored Maps candidates without a provider call and preserves manual verdicts', async () => {
    const em = new FakeEm()
    const { run, dental, vet, manual } = await seed(em)

    const result = await requalifyResearchRun({ em, run, actorUserId: USER })

    expect(result).toEqual({
      scorerVersion: FIT_SCORER_VERSION,
      alreadyCurrent: false,
      candidates: 3,
      rescored: 2,
      manualOverridesPreserved: 1,
      accepted: 1,
      review: 1,
      rejected: 1,
      byReason: {
        required_criterion_unknown: 1,
        required_criterion_mismatch: 1,
        manual_review_accepted: 1,
      },
    })
    expect(dental.fitStatus).toBe('review')
    expect(dental.qualificationVersion).toBe(FIT_SCORER_VERSION)
    expect(dental.identity.provider_location).toBe('San Diego County, California')
    expect(dental.qualification).toEqual(expect.objectContaining({
      criteria: expect.arrayContaining([
        expect.objectContaining({ id: 'account.industry', status: 'pass' }),
        expect.objectContaining({ id: 'account.employee_range', status: 'unknown' }),
        expect.objectContaining({ id: 'geography.location', status: 'unknown' }),
      ]),
    }))
    expect(vet.fitStatus).toBe('rejected')
    expect(vet.rejectReason).toBe('required_criterion_mismatch')
    expect(manual.fitStatus).toBe('accepted')
    expect(manual.qualificationVersion).toBe('fit-v4')
    expect((run.providerPlan as Record<string, any>).execution.funnel).toEqual(expect.objectContaining({
      accepted: 1,
      review: 1,
      rejected: 1,
    }))
    expect(em.table(GtmAuditEvent)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'gtm.research_run.requalified',
        actorUserId: USER,
        objectId: run.id,
      }),
    ]))
  })

  it('is idempotent after the scorer version and run summary are current', async () => {
    const em = new FakeEm()
    const { run } = await seed(em)
    await requalifyResearchRun({ em, run, actorUserId: USER })

    const replay = await requalifyResearchRun({ em, run, actorUserId: USER })

    expect(replay.alreadyCurrent).toBe(true)
    expect(replay.rescored).toBe(0)
    expect(replay).toEqual(expect.objectContaining({ accepted: 1, review: 1, rejected: 1 }))
  })

  it('requalifies run matches without overwriting the workspace identity verdict', async () => {
    const em = new FakeEm()
    const { run, dental, vet, manual } = await seed(em)
    const matchByCandidate = new Map<string, GtmCandidateMatch>()
    for (const candidate of [dental, vet, manual]) {
      const match = em.create(GtmCandidateMatch, {
        organizationId: ORG,
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        playId: run.playId,
        researchRunId: run.id,
        candidateId: candidate.id,
        fitStatus: candidate.fitStatus,
        fitScore: candidate.fitScore,
        rejectReason: candidate.rejectReason,
        qualificationVersion: 'fit-v4',
      })
      matchByCandidate.set(candidate.id, match)
      em.persist(match)
    }
    for (const evidence of em.table(GtmEvidence)) evidence.researchRunId = run.id
    const manualMatch = matchByCandidate.get(manual.id)!
    em.persist(em.create(GtmAuditEvent, {
      organizationId: ORG,
      tenantId: TENANT,
      actor: 'user_id',
      action: 'gtm.candidate_match.review_override',
      objectType: 'gtm_candidate_match',
      objectId: manualMatch.id,
    }))
    await em.flush()

    const result = await requalifyResearchRun({ em, run, actorUserId: USER })

    expect(result).toEqual(expect.objectContaining({
      candidates: 3,
      rescored: 2,
      manualOverridesPreserved: 1,
      accepted: 1,
      review: 1,
      rejected: 1,
    }))
    expect(matchByCandidate.get(dental.id)?.fitStatus).toBe('review')
    expect(matchByCandidate.get(dental.id)?.qualificationVersion).toBe(FIT_SCORER_VERSION)
    expect(matchByCandidate.get(vet.id)?.fitStatus).toBe('rejected')
    expect(manualMatch.fitStatus).toBe('accepted')
    expect(dental.fitStatus).toBe('rejected')
    expect(dental.qualificationVersion).toBe('fit-v4')
  })

  it('fails closed when the immutable play snapshot is absent', async () => {
    const em = new FakeEm()
    const run = em.create(GtmResearchRun, {
      organizationId: ORG,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      playId: '50000000-0000-4000-8000-000000000001',
      inputSnapshot: null,
    })
    await expect(requalifyResearchRun({ em, run, actorUserId: USER })).rejects.toThrow(
      'research_run_missing_frozen_play',
    )
  })
})
