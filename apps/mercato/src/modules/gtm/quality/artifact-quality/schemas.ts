import { z } from 'zod'

export const GTM_ARTIFACT_RUBRIC_VERSION = 'gtm-artifact-quality-v2'

const opportunityQualityLabelSchema = z.object({
  source: z.enum(['synthetic', 'sanitized_live']),
  playAudience: z.string().min(1).max(500),
  playGeography: z.string().min(1).max(200),
  expectedIntent: z.enum(['buyer_intent', 'seller_intent', 'local_audience', 'mixed_intent']),
  observedContent: z.string().min(1).max(2_000),
  observedLocation: z.string().min(1).max(200).nullable(),
  observedAt: z.string().datetime(),
  referenceTime: z.string().datetime(),
  eventStartAt: z.string().datetime().nullable().default(null),
  liveAccessible: z.boolean(),
  usefulEnoughToActOn: z.boolean(),
  duplicateOf: z.string().max(200).nullable().default(null),
  expectedReasons: z.array(z.string().min(1).max(100)).max(20).default([]),
})

export const gtmArtifactFixtureSchema = z.object({
  id: z.string().regex(/^gtm-q-v[12]-[a-z0-9-]+$/),
  kind: z.enum([
    'audience_play',
    'qualification',
    'research_plan',
    'sequence',
    'reply_draft',
    'manual_outreach',
    'opportunity',
    'failure_honesty',
  ]),
  scenario: z.string().min(1).max(500),
  trustedFacts: z.array(z.string().min(1).max(500)).max(30),
  foreignCanary: z.string().min(8).max(200),
  prohibitedClaims: z.array(z.string().min(1).max(500)).max(30),
  expectedDisposition: z.enum(['deliver', 'review', 'suppress', 'blocked']),
  artifact: z.record(z.string(), z.unknown()),
  opportunityQualityLabel: opportunityQualityLabelSchema.optional(),
  minimumScore: z.number().int().min(0).max(100).default(80),
})

export type GtmArtifactFixture = z.infer<typeof gtmArtifactFixtureSchema>

export type GtmArtifactEvaluation = {
  fixtureId: string
  rubricVersion: typeof GTM_ARTIFACT_RUBRIC_VERSION
  passed: boolean
  hardFailures: string[]
  score: number
  qualityFailures: string[]
}
