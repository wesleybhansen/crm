import crypto from 'crypto'
import { z } from 'zod'
import {
  REALTOR_BENCHMARK_VERSION,
  realtorBenchmarkLabelSchema,
  type RealtorBenchmarkLabel,
} from './schemas'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export const realtorBenchmarkEvidenceSchema = realtorBenchmarkLabelSchema.pick({
  benchmarkVersion: true,
  playId: true,
  rank: true,
  source: true,
  destinationHash: true,
  destinationKind: true,
  sanitizedContent: true,
  sanitizedObservedLocation: true,
  sourcePublishedAt: true,
  observedAt: true,
  eventStartAt: true,
  systemIntent: true,
  systemDisposition: true,
  criterionEvidence: true,
  sanitized: true,
}).strict()

export type RealtorBenchmarkEvidence = z.infer<typeof realtorBenchmarkEvidenceSchema>

export const independentHumanReviewDecisionSchema = z.object({
  benchmarkVersion: z.literal(REALTOR_BENCHMARK_VERSION),
  reviewId: z.string().regex(/^realtor-[a-z0-9-]+-(?:buyer|seller|local):[1-9][0-9]*$/),
  playId: z.string().regex(/^realtor-[a-z0-9-]+-(?:buyer|seller|local)$/),
  rank: z.number().int().min(1).max(200),
  destinationHash: sha256Schema,
  relevantToPlay: z.boolean(),
  geographyCorrect: z.boolean(),
  intentCorrect: z.boolean(),
  currentWithinWindow: z.boolean(),
  liveAccessible: z.boolean(),
  usefulEnoughToActOn: z.boolean(),
  duplicateOfHash: sha256Schema.nullable(),
  sensitiveTargeting: z.boolean(),
  unsupportedClaim: z.boolean(),
  rejectReasons: z.array(z.string().trim().min(3).max(100)).max(20),
  reviewerName: z.string().trim().min(2).max(120),
  reviewedAt: z.string().datetime(),
  reviewerKind: z.literal('independent_human'),
  attestation: z.literal('HUMAN_REVIEWED'),
}).strict().superRefine((decision, context) => {
  if (decision.reviewId !== `${decision.playId}:${decision.rank}`) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewId'],
      message: 'Review ID must bind the reviewed play and rank.',
    })
  }
  if (decision.duplicateOfHash === decision.destinationHash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['duplicateOfHash'],
      message: 'A destination cannot be a duplicate of itself.',
    })
  }
  const needsReason =
    !decision.relevantToPlay
    || !decision.geographyCorrect
    || !decision.intentCorrect
    || !decision.currentWithinWindow
    || !decision.liveAccessible
    || !decision.usefulEnoughToActOn
    || decision.sensitiveTargeting
    || decision.unsupportedClaim
  if (needsReason && decision.rejectReasons.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rejectReasons'],
      message: 'A reason is required for every negative or unsafe human decision.',
    })
  }
})

export type IndependentHumanReviewDecision = z.infer<typeof independentHumanReviewDecisionSchema>

export const independentHumanReviewBatchSchema = z.object({
  benchmarkVersion: z.literal(REALTOR_BENCHMARK_VERSION),
  sourceSha256: sha256Schema,
  exportedAt: z.string().datetime(),
  reviews: z.array(independentHumanReviewDecisionSchema).min(1).max(200),
}).strict()

export type IndependentHumanReviewBatch = z.infer<typeof independentHumanReviewBatchSchema>

export type ImportedHumanReview = {
  labels: RealtorBenchmarkLabel[]
  audit: {
    benchmarkVersion: typeof REALTOR_BENCHMARK_VERSION
    sourceSha256: string
    decisionSha256: string
    reviewCount: number
    reviewers: string[]
    earliestReviewedAt: string
    latestReviewedAt: string
  }
}

function stableDecisionPayload(decisions: IndependentHumanReviewDecision[]): string {
  return JSON.stringify(
    [...decisions]
      .sort((left, right) => left.reviewId.localeCompare(right.reviewId))
      .map((decision) => ({
        ...decision,
        rejectReasons: [...decision.rejectReasons].sort(),
      })),
  )
}

export function realtorBenchmarkEvidenceSourceSha256(evidence: RealtorBenchmarkEvidence[]): string {
  const stableEvidence = [...evidence]
    .sort((left, right) => {
      const playOrder = left.playId.localeCompare(right.playId)
      return playOrder === 0 ? left.rank - right.rank : playOrder
    })
  return crypto.createHash('sha256').update(JSON.stringify(stableEvidence)).digest('hex')
}

/**
 * Joins blind, independently attested decisions to the frozen system evidence.
 * The reviewer payload cannot alter provider content, system disposition, or
 * criterion evidence, and incomplete review batches remain incomplete when
 * evaluated by the benchmark coverage gate.
 */
export function importIndependentHumanReviews(
  rawEvidence: RealtorBenchmarkEvidence[],
  rawBatch: IndependentHumanReviewBatch,
): ImportedHumanReview {
  const evidence = rawEvidence.map((row) => realtorBenchmarkEvidenceSchema.parse(row))
  const batch = independentHumanReviewBatchSchema.parse(rawBatch)
  const evidenceByKey = new Map<string, RealtorBenchmarkEvidence>()
  for (const row of evidence) {
    const evidenceKey = `${row.playId}:${row.rank}`
    if (evidenceByKey.has(evidenceKey)) {
      throw new Error(`Duplicate frozen benchmark evidence: ${evidenceKey}`)
    }
    evidenceByKey.set(evidenceKey, row)
  }
  const actualSourceSha256 = realtorBenchmarkEvidenceSourceSha256(evidence)
  if (batch.sourceSha256 !== actualSourceSha256) {
    throw new Error('Frozen benchmark evidence source hash does not match the independent review batch.')
  }
  const seenReviewIds = new Set<string>()

  const labels = batch.reviews.map((review) => {
    if (seenReviewIds.has(review.reviewId)) {
      throw new Error(`Duplicate independent review decision: ${review.reviewId}`)
    }
    seenReviewIds.add(review.reviewId)
    const frozen = evidenceByKey.get(review.reviewId)
    if (!frozen) throw new Error(`No frozen evidence for review: ${review.reviewId}`)
    if (frozen.destinationHash !== review.destinationHash) {
      throw new Error(`Destination hash changed for review: ${review.reviewId}`)
    }
    return realtorBenchmarkLabelSchema.parse({
      ...frozen,
      relevantToPlay: review.relevantToPlay,
      geographyCorrect: review.geographyCorrect,
      intentCorrect: review.intentCorrect,
      currentWithinWindow: review.currentWithinWindow,
      liveAccessible: review.liveAccessible,
      usefulEnoughToActOn: review.usefulEnoughToActOn,
      duplicateOfHash: review.duplicateOfHash,
      sensitiveTargeting: review.sensitiveTargeting,
      unsupportedClaim: review.unsupportedClaim,
      rejectReasons: review.rejectReasons,
    })
  })

  const reviewedTimes = batch.reviews.map((review) => review.reviewedAt).sort()
  return {
    labels,
    audit: {
      benchmarkVersion: REALTOR_BENCHMARK_VERSION,
      sourceSha256: actualSourceSha256,
      decisionSha256: crypto.createHash('sha256').update(stableDecisionPayload(batch.reviews)).digest('hex'),
      reviewCount: labels.length,
      reviewers: [...new Set(batch.reviews.map((review) => review.reviewerName))].sort(),
      earliestReviewedAt: reviewedTimes[0],
      latestReviewedAt: reviewedTimes[reviewedTimes.length - 1],
    },
  }
}
