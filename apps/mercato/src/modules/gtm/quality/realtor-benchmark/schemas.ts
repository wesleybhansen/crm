import { z } from 'zod'

export const REALTOR_BENCHMARK_VERSION = 'realtor-opportunity-benchmark-v1'

export const realtorBenchmarkPlaySchema = z.object({
  id: z.string().regex(/^realtor-[a-z0-9-]+-(?:buyer|seller|local)$/),
  market: z.string().min(2).max(100),
  geography: z.string().min(2).max(100),
  lane: z.enum(['buyer_intent', 'seller_intent', 'local_audience']),
  audience: z.string().min(10).max(500),
  signal: z.string().min(10).max(500),
  entityUnit: z.enum(['post', 'thread', 'community', 'group', 'forum', 'event', 'audience']),
  recencyWindow: z.string().min(1).max(100),
})

export type RealtorBenchmarkPlay = z.infer<typeof realtorBenchmarkPlaySchema>

export const realtorBenchmarkLabelSchema = z.object({
  benchmarkVersion: z.literal(REALTOR_BENCHMARK_VERSION),
  playId: z.string(),
  rank: z.number().int().min(1).max(200),
  source: z.enum(['apify-linkedin', 'apify-reddit', 'apify-x', 'dataforseo', 'other']),
  destinationHash: z.string().regex(/^[a-f0-9]{64}$/),
  destinationKind: z.enum(['community', 'forum', 'group', 'thread', 'post', 'event', 'creator_audience']),
  sanitizedContent: z.string().min(1).max(2_000),
  sanitizedObservedLocation: z.string().min(1).max(200).nullable(),
  sourcePublishedAt: z.string().datetime().nullable(),
  observedAt: z.string().datetime(),
  eventStartAt: z.string().datetime().nullable(),
  systemIntent: z.enum(['buyer_intent', 'seller_intent', 'local_audience', 'mixed_intent']).nullable(),
  systemDisposition: z.enum(['accepted', 'review', 'rejected']),
  relevantToPlay: z.boolean(),
  geographyCorrect: z.boolean(),
  currentWithinWindow: z.boolean(),
  liveAccessible: z.boolean(),
  usefulEnoughToActOn: z.boolean(),
  duplicateOfHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  sensitiveTargeting: z.boolean(),
  unsupportedClaim: z.boolean(),
  criterionEvidence: z.array(z.string().min(1).max(200)).min(1).max(20),
  rejectReasons: z.array(z.string().min(1).max(100)).max(20),
  sanitized: z.literal(true),
})

export type RealtorBenchmarkLabel = z.infer<typeof realtorBenchmarkLabelSchema>

export type RealtorBenchmarkMetric = {
  value: number
  threshold: number
  operator: '>=' | '<=' | '='
  passed: boolean
}

export type RealtorBenchmarkEvaluation = {
  benchmarkVersion: typeof REALTOR_BENCHMARK_VERSION
  passed: boolean
  coverage: {
    playCount: number
    labeledRows: number
    minimumRowsPerPlay: number
    maximumRowsPerPlay: number
    missingPlayIds: string[]
    duplicateRankKeys: string[]
    valid: boolean
  }
  metrics: {
    precisionAt10: RealtorBenchmarkMetric
    geographyCorrectness: RealtorBenchmarkMetric
    intentCorrectness: RealtorBenchmarkMetric
    liveAccessibleDestinations: RealtorBenchmarkMetric
    duplicateRate: RealtorBenchmarkMetric
    usefulEnoughToActOn: RealtorBenchmarkMetric
    sensitiveOrUnsupportedCount: RealtorBenchmarkMetric
  }
  byPlay: Array<{
    playId: string
    labeledRows: number
    relevantAt10: number
    precisionAt10: number
  }>
}
