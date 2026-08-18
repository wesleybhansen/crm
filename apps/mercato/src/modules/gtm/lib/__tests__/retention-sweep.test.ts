import { FakeEm } from './support/fake-em'
import { sweepExpiredCandidates } from '../retention/sweep'
import {
  GtmAuditEvent,
  GtmCandidate,
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

    const result = await sweepExpiredCandidates(em, { now: NOW })

    expect(result).toEqual({
      candidatesDeleted: 1,
      evidenceDeleted: 2,
      contactPointsDeleted: 1,
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
      skippedEnrolled: 0,
      batches: 0,
    })
    expect(em.table(GtmAuditEvent)).toHaveLength(1)
  })
})
