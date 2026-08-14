import { z } from "zod";

export const REPLY_QUALITY_SCHEMA_VERSION = "reply-quality.v1" as const;
export const REPLY_CANDIDATE_SCHEMA_VERSION = "reply-candidate.v1" as const;
export const REPLY_BASELINE_SCHEMA_VERSION =
  "reply-quality-baseline.v1" as const;
export const REPLY_RESULT_SCHEMA_VERSION = "reply-quality-result.v1" as const;

export const ReplyQualityScenarioV1Schema = z.enum([
  "sales",
  "support",
  "scheduling",
  "missed_appointment",
  "complaint",
  "refund",
  "ambiguous",
  "escalation",
  "unsupported",
  "sparse_context",
  "contradictory_context",
  "sensitive",
  "opt_out",
  "supplied_voice",
  "learned_voice",
  "human_approval",
  "no_reply",
  "cross_tenant",
  "provider_failure",
  "clarification",
  "template",
  "proactive_followup",
  "automation",
  "mcp_boundary",
  "entitlement_failure",
  "feedback_learning",
  "queue_approval",
]);

export const ReplyChannelV1Schema = z.enum(["email", "sms", "chat"]);
export const ReplyAutomationModeV1Schema = z.enum(["draft", "hybrid", "auto"]);

export const ReplyDispositionV1Schema = z.enum([
  "no_reply",
  "hold",
  "draft",
  "clarify",
  "escalate",
  "schedule",
  "send",
]);

export const ReplyPromptInputV1Schema = z
  .object({
    channel: ReplyChannelV1Schema,
    businessName: z.string().max(200),
    businessDescription: z.string().max(2_000),
    knowledgeBase: z.string().max(12_000),
    knowledgeSection: z.string().max(12_000),
    customInstructions: z.string().max(4_000),
    contactInfo: z.string().max(2_000),
    threadSummarySection: z.string().max(4_000),
    voiceSection: z.string().max(4_000),
    flagSection: z.string().max(2_000),
    transcript: z.string().max(16_000),
  })
  .strict();

export const ReplyCandidateV1Schema = z
  .object({
    schemaVersion: z.literal(REPLY_CANDIDATE_SCHEMA_VERSION),
    subject: z.null(),
    body: z.string().max(8_000),
    disposition: ReplyDispositionV1Schema,
    confidence: z.number().min(0).max(1),
    autoSendSafe: z.boolean(),
    usedFactKeys: z.array(z.string().min(1).max(120)).max(30),
  })
  .strict();

export const GroundedFactV1Schema = z
  .object({
    key: z.string().min(1).max(120),
    value: z.string().min(1).max(2_000),
  })
  .strict();

export const ConversationMessageV1Schema = z
  .object({
    direction: z.enum(["inbound", "outbound"]),
    body: z.string().max(4_000),
  })
  .strict();

export const ReplyExpectedV1Schema = z
  .object({
    disposition: ReplyDispositionV1Schema,
    providerOutputValid: z.boolean(),
    requiredPhrases: z.array(z.string().min(1).max(300)).max(20),
    forbiddenPhrases: z.array(z.string().min(1).max(300)).max(20),
    requiredFactKeys: z.array(z.string().min(1).max(120)).max(20),
    requiresClarification: z.boolean(),
    requiresEscalation: z.boolean(),
    requiresApproval: z.boolean(),
    requiresCriticRejection: z.boolean(),
    preserveEditedText: z.string().max(2_000).nullable(),
    requiredVoiceMarkers: z.array(z.string().min(1).max(120)).max(10),
    forbiddenVoiceMarkers: z.array(z.string().min(1).max(120)).max(10),
    maxWords: z.number().int().positive().max(1_000),
  })
  .strict();

export const ReplyQualityFixtureV1Schema = z
  .object({
    schemaVersion: z.literal(REPLY_QUALITY_SCHEMA_VERSION),
    id: z.string().regex(/^rq-v1-[a-z0-9-]+$/),
    scenario: ReplyQualityScenarioV1Schema,
    description: z.string().min(1).max(500),
    organizationId: z.string().min(1).max(120),
    tenantId: z.string().min(1).max(120),
    foreignScopeTokens: z.array(z.string().min(1).max(300)).max(20),
    sensitiveTokens: z.array(z.string().min(1).max(300)).max(20),
    consent: z
      .object({
        optedOut: z.boolean(),
        channelAllowed: z.boolean(),
      })
      .strict(),
    automationMode: ReplyAutomationModeV1Schema,
    review: z
      .object({
        criticInvoked: z.boolean(),
        criticApproved: z.boolean().nullable(),
      })
      .strict(),
    promptInput: ReplyPromptInputV1Schema,
    conversation: z.array(ConversationMessageV1Schema).min(1).max(20),
    groundedFacts: z.array(GroundedFactV1Schema).max(30),
    candidate: z.unknown(),
    observedDisposition: ReplyDispositionV1Schema,
    expected: ReplyExpectedV1Schema,
  })
  .strict();

export const ReplyQualityFixtureSetV1Schema = z
  .object({
    schemaVersion: z.literal(REPLY_QUALITY_SCHEMA_VERSION),
    fixtureSetVersion: z.literal("v1"),
    fixtures: z.array(ReplyQualityFixtureV1Schema).min(20),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const fixture of value.fixtures) {
      if (ids.has(fixture.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate fixture id: ${fixture.id}`,
          path: ["fixtures"],
        });
      }
      ids.add(fixture.id);
    }
  });

export const CriterionStatusSchema = z.enum(["passed", "failed", "skipped"]);

export const CriterionResultSchema = z
  .object({
    criterionId: z.string().min(1),
    kind: z.enum(["hard", "quality"]),
    status: CriterionStatusSchema,
    reason: z.string().min(1),
  })
  .strict();

export const FixtureEvaluationResultSchema = z
  .object({
    fixtureId: z.string().min(1),
    scenario: ReplyQualityScenarioV1Schema,
    passed: z.boolean(),
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    promptLength: z.number().int().nonnegative(),
    criteria: z.array(CriterionResultSchema).min(1),
  })
  .strict();

export const ReplyQualityBaselineV1Schema = z
  .object({
    schemaVersion: z.literal(REPLY_BASELINE_SCHEMA_VERSION),
    fixtureSetVersion: z.literal("v1"),
    fixtureCount: z.number().int().min(20),
    minimumOverallPassRate: z.number().min(0).max(1),
    hardCriteriaMustPass: z.boolean(),
    criterionMinimumPassRates: z.record(z.string(), z.number().min(0).max(1)),
    referenceOverallPassRate: z.number().min(0).max(1),
    referenceCriterionPassRates: z.record(z.string(), z.number().min(0).max(1)),
  })
  .strict();

export const CriterionAggregateSchema = z
  .object({
    criterionId: z.string().min(1),
    kind: z.enum(["hard", "quality"]),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    passRate: z.number().min(0).max(1).nullable(),
    baselinePassRate: z.number().min(0).max(1).nullable(),
    delta: z.number().min(-1).max(1).nullable(),
    minimumPassRate: z.number().min(0).max(1).nullable(),
  })
  .strict();

export const DryRunResultSchema = z
  .object({
    schemaVersion: z.literal(REPLY_RESULT_SCHEMA_VERSION),
    mode: z.literal("dry-run"),
    status: z.enum(["passed", "failed"]),
    fixtureSetVersion: z.literal("v1"),
    generatedAt: z.string().datetime(),
    summary: z
      .object({
        fixtureCount: z.number().int().nonnegative(),
        passedFixtures: z.number().int().nonnegative(),
        failedFixtures: z.number().int().nonnegative(),
        overallPassRate: z.number().min(0).max(1),
        baselineDelta: z.number().min(-1).max(1),
      })
      .strict(),
    criteria: z.array(CriterionAggregateSchema),
    fixtures: z.array(FixtureEvaluationResultSchema),
    failures: z.array(z.string()),
  })
  .strict();

export const ScoredCriterionSchema = z.enum([
  "grounding",
  "context_use",
  "tone_voice",
  "concision",
  "escalation_review",
]);

export const ScoredJudgeOutputSchema = z
  .object({
    scores: z.record(ScoredCriterionSchema, z.number().int().min(1).max(5)),
    reasons: z.record(ScoredCriterionSchema, z.string().min(1).max(500)),
  })
  .strict();

export const ScoredCaseResultSchema = z
  .object({
    fixtureId: z.string().min(1),
    status: z.enum(["scored", "rejected", "error"]),
    passed: z.boolean().nullable(),
    scores: z
      .record(ScoredCriterionSchema, z.number().int().min(1).max(5))
      .nullable(),
    reasons: z
      .record(ScoredCriterionSchema, z.string().min(1).max(500))
      .nullable(),
    error: z.string().max(500).nullable(),
    deterministicFailures: z.array(z.string().min(1).max(200)).max(30),
    callsMade: z.number().int().min(0).max(2),
    candidate: ReplyCandidateV1Schema.nullable(),
  })
  .strict();

export const ScoredRunResultSchema = z
  .object({
    schemaVersion: z.literal(REPLY_RESULT_SCHEMA_VERSION),
    mode: z.literal("scored"),
    status: z.enum(["passed", "failed", "skipped"]),
    reason: z.enum(["credential_missing"]).nullable(),
    generatedAt: z.string().datetime(),
    model: z.string().min(1),
    maxCases: z.number().int().min(1).max(20),
    callsPerCaseLimit: z.literal(2),
    callsMade: z.number().int().min(0).max(40),
    thresholds: z
      .object({
        minimumCriterionScore: z.literal(3),
        minimumCaseAverage: z.literal(4),
      })
      .strict(),
    summary: z
      .object({
        scoredCases: z.number().int().nonnegative(),
        errorCases: z.number().int().nonnegative(),
        passedCases: z.number().int().nonnegative(),
        failedCases: z.number().int().nonnegative(),
        criterionAverages: z
          .record(ScoredCriterionSchema, z.number().min(1).max(5))
          .nullable(),
      })
      .strict(),
    deterministic: DryRunResultSchema,
    cases: z.array(ScoredCaseResultSchema).max(20),
  })
  .strict();

export type ReplyQualityFixtureV1 = z.infer<typeof ReplyQualityFixtureV1Schema>;
export type ReplyQualityFixtureSetV1 = z.infer<
  typeof ReplyQualityFixtureSetV1Schema
>;
export type ReplyCandidateV1 = z.infer<typeof ReplyCandidateV1Schema>;
export type ReplyPromptInputV1 = z.infer<typeof ReplyPromptInputV1Schema>;
export type ReplyDispositionV1 = z.infer<typeof ReplyDispositionV1Schema>;
export type CriterionResult = z.infer<typeof CriterionResultSchema>;
export type FixtureEvaluationResult = z.infer<
  typeof FixtureEvaluationResultSchema
>;
export type ReplyQualityBaselineV1 = z.infer<
  typeof ReplyQualityBaselineV1Schema
>;
export type DryRunResult = z.infer<typeof DryRunResultSchema>;
export type ScoredJudgeOutput = z.infer<typeof ScoredJudgeOutputSchema>;
export type ScoredRunResult = z.infer<typeof ScoredRunResultSchema>;
