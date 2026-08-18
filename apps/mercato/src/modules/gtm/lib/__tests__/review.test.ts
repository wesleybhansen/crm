import { FakeEm } from './support/fake-em'
import { reviewCandidate, DEFAULT_MANUAL_REJECT_REASON } from '../research/review'
import { GtmAuditEvent, GtmCandidate } from '../../data/entities'

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const USER = '55555555-5555-4555-8555-555555555555'

function makeCandidate(em: FakeEm): GtmCandidate {
  const candidate = em.create(GtmCandidate, {
    organizationId: ORG,
    tenantId: TENANT,
    researchRunId: '66666666-6666-4666-8666-666666666666',
    workspaceId: '33333333-3333-4333-8333-333333333333',
    entityKind: 'company',
    identity: { name: 'Example Dynamics LLC', domain: 'example-dynamics.example' },
    dedupeKey: 'a'.repeat(64),
    fitStatus: 'accepted',
    fitScore: '80',
  })
  em.persist(candidate)
  return candidate
}

describe('reviewCandidate manual override', () => {
  it('applies the verdict and writes an audit event in the same transaction', async () => {
    const em = new FakeEm()
    const candidate = makeCandidate(em)

    const result = await reviewCandidate({
      em,
      candidate,
      verdict: 'rejected',
      reason: 'not in our segment',
      userId: USER,
      requestId: 'req-123',
    })

    expect(result.candidate.fitStatus).toBe('rejected')
    expect(result.candidate.rejectReason).toBe('not in our segment')

    const audits = em.table(GtmAuditEvent)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      organizationId: ORG,
      tenantId: TENANT,
      actor: 'user_id',
      actorUserId: USER,
      action: 'gtm.candidate.review_override',
      objectType: 'gtm_candidate',
      objectId: candidate.id,
      requestId: 'req-123',
    })
    expect(audits[0].metadata).toMatchObject({
      verdict: 'rejected',
      reason: 'not in our segment',
      previous_fit_status: 'accepted',
    })
  })

  it('never leaves a rejected candidate without a reason', async () => {
    const em = new FakeEm()
    const candidate = makeCandidate(em)

    const result = await reviewCandidate({
      em,
      candidate,
      verdict: 'rejected',
      reason: '   ',
      userId: USER,
    })

    expect(result.candidate.rejectReason).toBe(DEFAULT_MANUAL_REJECT_REASON)
    expect(em.table(GtmAuditEvent)[0].metadata).toMatchObject({
      reason: DEFAULT_MANUAL_REJECT_REASON,
    })
  })

  it('clears the reject reason when a human accepts a rejected candidate', async () => {
    const em = new FakeEm()
    const candidate = makeCandidate(em)
    candidate.fitStatus = 'rejected'
    candidate.rejectReason = 'weak_evidence_confidence'

    const result = await reviewCandidate({
      em,
      candidate,
      verdict: 'accepted',
      userId: USER,
    })

    expect(result.candidate.fitStatus).toBe('accepted')
    expect(result.candidate.rejectReason).toBeNull()
    expect(em.table(GtmAuditEvent)[0].metadata).toMatchObject({
      verdict: 'accepted',
      previous_fit_status: 'rejected',
      previous_reject_reason: 'weak_evidence_confidence',
    })
  })
})
