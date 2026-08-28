import crypto from 'crypto'
import {
  importIndependentHumanReviews,
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
    sourceSha256: crypto.createHash('sha256').update('frozen source').digest('hex'),
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

  it('rejects reviewer attempts to overwrite frozen system fields', () => {
    const invalid = batch() as unknown as { reviews: Array<Record<string, unknown>> }
    invalid.reviews[0].systemDisposition = 'rejected'
    expect(() => importIndependentHumanReviews([evidence()], invalid as never)).toThrow()
  })
})
