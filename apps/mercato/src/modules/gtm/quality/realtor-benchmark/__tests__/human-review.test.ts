import crypto from 'crypto'
import {
  importIndependentHumanReviews,
  realtorBenchmarkEvidenceSourceSha256,
  type IndependentHumanReviewBatch,
  type RealtorBenchmarkEvidence,
} from '../human-review'
import { REALTOR_BENCHMARK_VERSION } from '../schemas'

const destinationHash = crypto.createHash('sha256').update('destination').digest('hex')

function evidence(): RealtorBenchmarkEvidence {
  return {
    benchmarkVersion: REALTOR_BENCHMARK_VERSION,
    playId: 'realtor-austin-buyer',
    rank: 1,
    researchRunId: '10000000-0000-4000-8000-000000000001',
    candidateMatchId: '20000000-0000-4000-8000-000000000001',
    providerOperationId: '30000000-0000-4000-8000-000000000001',
    source: 'apify-reddit',
    destinationHash,
    destinationKind: 'thread',
    sanitizedContent: 'I am buying my first home in Austin and need help comparing offers.',
    sanitizedObservedLocation: 'Austin, Texas, United States',
    sourcePublishedAt: '2026-08-27T18:00:00.000Z',
    observedAt: '2026-08-28T18:00:00.000Z',
    eventStartAt: null,
    systemIntent: 'buyer_intent',
    systemDisposition: 'accepted',
    criterionEvidence: ['returned content demonstrates buyer intent'],
    sanitized: true,
  }
}

function batch(): IndependentHumanReviewBatch {
  return {
    benchmarkVersion: REALTOR_BENCHMARK_VERSION,
    sourceSha256: realtorBenchmarkEvidenceSourceSha256([evidence()]),
    exportedAt: '2026-08-28T20:00:00.000Z',
    reviews: [{
      benchmarkVersion: REALTOR_BENCHMARK_VERSION,
      reviewId: 'realtor-austin-buyer:1',
      playId: 'realtor-austin-buyer',
      rank: 1,
      destinationHash,
      relevantToPlay: true,
      geographyCorrect: true,
      intentCorrect: true,
      currentWithinWindow: true,
      liveAccessible: true,
      usefulEnoughToActOn: true,
      duplicateOfHash: null,
      sensitiveTargeting: false,
      unsupportedClaim: false,
      rejectReasons: [],
      reviewerName: 'Independent Reviewer',
      reviewedAt: '2026-08-28T19:00:00.000Z',
      reviewerKind: 'independent_human',
      attestation: 'HUMAN_REVIEWED',
    }],
  }
}

describe('independent human realtor benchmark review import', () => {
  it('binds human decisions to immutable frozen evidence and emits an audit digest', () => {
    const result = importIndependentHumanReviews([evidence()], batch())
    expect(result.labels).toHaveLength(1)
    expect(result.labels[0]).toMatchObject({
      sanitizedContent: evidence().sanitizedContent,
      systemDisposition: 'accepted',
      usefulEnoughToActOn: true,
    })
    expect(result.audit).toMatchObject({ reviewCount: 1, reviewers: ['Independent Reviewer'] })
    expect(result.audit.decisionSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects a changed destination hash', () => {
    const changed = batch()
    changed.reviews[0].destinationHash = crypto.createHash('sha256').update('other').digest('hex')
    expect(() => importIndependentHumanReviews([evidence()], changed)).toThrow('Destination hash changed')
  })

  it('rejects decisions bound to a different frozen evidence payload', () => {
    const changed = batch()
    changed.sourceSha256 = crypto.createHash('sha256').update('different evidence').digest('hex')
    expect(() => importIndependentHumanReviews([evidence()], changed)).toThrow(
      'Frozen benchmark evidence source hash does not match',
    )
  })

  it('rejects duplicate frozen evidence rows', () => {
    expect(() => importIndependentHumanReviews([evidence(), evidence()], batch())).toThrow(
      'Duplicate frozen benchmark evidence',
    )
  })

  it('rejects duplicate decisions and non-human attestations', () => {
    const duplicated = batch()
    duplicated.reviews.push({ ...duplicated.reviews[0] })
    expect(() => importIndependentHumanReviews([evidence()], duplicated)).toThrow('Duplicate independent review')

    const invalid = batch() as unknown as { reviews: Array<Record<string, unknown>> }
    invalid.reviews[0].attestation = 'AI_ASSISTED'
    expect(() => importIndependentHumanReviews([evidence()], invalid as never)).toThrow()
  })

  it('requires a reason for any negative or unsafe decision', () => {
    const invalid = batch()
    invalid.reviews[0].liveAccessible = false
    expect(() => importIndependentHumanReviews([evidence()], invalid)).toThrow('reason is required')
  })

  it('accepts an exact destination-hash duplicate when it binds to an earlier frozen row', () => {
    const first = evidence()
    const second: RealtorBenchmarkEvidence = {
      ...first,
      playId: 'realtor-austin-local',
      rank: 2,
      sanitizedContent: 'The same public destination was returned for a second play.',
      systemIntent: 'local_audience',
    }
    const reviews = batch()
    reviews.sourceSha256 = realtorBenchmarkEvidenceSourceSha256([first, second])
    reviews.reviews.push({
      ...reviews.reviews[0],
      reviewId: 'realtor-austin-local:2',
      playId: 'realtor-austin-local',
      rank: 2,
      duplicateOfHash: destinationHash,
    })

    const result = importIndependentHumanReviews([first, second], reviews)

    expect(result.labels[1].duplicateOfHash).toBe(destinationHash)
  })

  it('rejects a duplicate hash that does not bind to an earlier frozen row', () => {
    const invalid = batch()
    invalid.reviews[0].duplicateOfHash = crypto.createHash('sha256').update('missing').digest('hex')

    expect(() => importIndependentHumanReviews([evidence()], invalid)).toThrow(
      'Duplicate hash does not identify an earlier frozen result',
    )
  })

  it('fails closed when frozen evidence does not bind to a real run, match, and provider operation (C1)', () => {
    const unbound = { ...evidence() } as Record<string, unknown>
    delete unbound.researchRunId
    expect(() => importIndependentHumanReviews([unbound as never], batch())).toThrow()
    const malformed = { ...evidence(), candidateMatchId: 'not-a-uuid' }
    expect(() => importIndependentHumanReviews([malformed], batch())).toThrow()
  })

  it('rejects reviewer attempts to overwrite frozen system fields', () => {
    const invalid = batch() as unknown as { reviews: Array<Record<string, unknown>> }
    invalid.reviews[0].systemDisposition = 'rejected'
    expect(() => importIndependentHumanReviews([evidence()], invalid as never)).toThrow()
  })
})
