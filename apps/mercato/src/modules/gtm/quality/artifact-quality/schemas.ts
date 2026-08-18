import { z } from 'zod'

export const GTM_ARTIFACT_RUBRIC_VERSION = 'gtm-artifact-quality-v1'

export const gtmArtifactFixtureSchema = z.object({
  id: z.string().regex(/^gtm-q-v1-[a-z0-9-]+$/),
  kind: z.enum([
    'audience_play',
    'qualification',
    'research_plan',
    'sequence',
    'reply_draft',
    'failure_honesty',
  ]),
  scenario: z.string().min(1).max(500),
  trustedFacts: z.array(z.string().min(1).max(500)).max(30),
  foreignCanary: z.string().min(8).max(200),
  prohibitedClaims: z.array(z.string().min(1).max(500)).max(30),
  expectedDisposition: z.enum(['deliver', 'review', 'suppress', 'blocked']),
  artifact: z.record(z.string(), z.unknown()),
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
