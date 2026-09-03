import { z } from 'zod'
import { chatContentIsBounded, GTM_CHAT_MESSAGE_READ_CAP } from './chat-contract'

const optionalText = z
  .string()
  .trim()
  .max(4000)
  .optional()
  .nullable()
  .transform((value) => (value ? value : null))

// Typed play payload per GTM-SPEC-01 section 3.5. The hub's play type names
// the sourcing hint `source`; SPEC-066 stores it as `source_hint` (the CRM
// `source` column means imported | authored), so both spellings are accepted.
// market_type is a strict enum (review research H13): a free-text label was
// a trusted caller input that selected automated email and skipped the
// consumer policy screen.
export const importedPlaySchema = z.object({
  market_type: z.enum(['b2b', 'b2c', 'mixed']).optional().nullable(),
  audience: optionalText,
  signal: optionalText,
  signal_kind: optionalText,
  provider_query: z.record(z.string(), z.unknown()).optional().nullable(),
  source_hint: optionalText,
  source: optionalText,
  geography: optionalText,
  recency_window: optionalText,
  why_now: optionalText,
  recommended_angle: optionalText,
  supported_channels: z.array(z.string().trim().min(1).max(200)).max(50).optional().nullable(),
  estimated_size: z.record(z.string(), z.unknown()).optional().nullable(),
  entity_unit: optionalText,
  estimate_method: optionalText,
  estimate_basis: z.enum(['measured', 'sampled', 'modeled', 'unknown']).optional().nullable(),
  business_evidence: z
    .array(z.object({
      url: z.string().url().max(4000),
      excerpt: z.string().trim().min(1).max(1000),
    }))
    .max(20)
    .optional()
    .nullable(),
  confidence: optionalText,
  confidence_rationale: optionalText,
})

export const importAudiencePlayBodySchema = z.object({
  noliUserId: z.string().trim().min(1).max(200),
  report_token_hash: z
    .string()
    .trim()
    .min(16)
    .max(128)
    .regex(/^\S+$/, 'report_token_hash must not contain whitespace'),
  play: importedPlaySchema,
  likely_buyer: optionalText,
})

export type ImportedPlayInput = z.infer<typeof importedPlaySchema>
export type ImportAudiencePlayBody = z.infer<typeof importAudiencePlayBodySchema>

// Internal read routes (SPEC-066 section 5): every internal route re-resolves
// noliUserId server-side; the caller never supplies org/tenant identifiers.
export const gtmOverviewBodySchema = z.object({
  noliUserId: z.string().trim().min(1).max(200),
})

// playId is intentionally NOT format-validated here: a malformed id must
// produce the same opaque 404 as a missing/foreign row (checked in the route
// via isUuid), never a distinguishable 400.
export const gtmPlayDetailBodySchema = z.object({
  noliUserId: z.string().trim().min(1).max(200),
  playId: z.string().trim().min(1).max(200),
})

export type GtmOverviewBody = z.infer<typeof gtmOverviewBodySchema>
export type GtmPlayDetailBody = z.infer<typeof gtmPlayDetailBodySchema>

// ---------------------------------------------------------------------------
// Tranche 3: research runs + candidates (SPEC-066 sections 5, 11, 14)
// ---------------------------------------------------------------------------

// Ids are NOT format-validated here: a malformed id must produce the same
// opaque 404 as a missing/foreign row (checked in the route via isUuid).
const idString = z.string().trim().min(1).max(200)

const researchLimitsSchema = z.object({
  targetAccepted: z.number().int().min(1).max(100).optional(),
  maxRawCandidates: z.number().int().min(1).max(100).optional(),
  // Legacy alias retained for current Hub and v1 clients.
  maxCandidates: z.number().int().min(1).max(100).optional(),
  maxCredits: z.number().int().min(1).optional(),
})

export const gtmResearchRunsBodySchema = z.discriminatedUnion('op', [
  // Workspace-wide run history for the hub UI: org+tenant self-scoped,
  // soft-deleted excluded, capped at 50, newest first (lib/listing.ts).
  z.object({
    op: z.literal('list'),
    noliUserId: idString,
    workspaceId: idString.optional(),
    playId: idString.optional(),
  }),
  z.object({
    op: z.literal('plan'),
    noliUserId: idString,
    playId: idString,
    limits: researchLimitsSchema.optional(),
  }),
  z.object({
    op: z.literal('create'),
    noliUserId: idString,
    playId: idString,
    limits: researchLimitsSchema.optional(),
    expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    op: z.literal('execute'),
    noliUserId: idString,
    runId: idString,
    expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    op: z.literal('status'),
    noliUserId: idString,
    runId: idString,
  }),
  z.object({
    op: z.literal('requalify'),
    noliUserId: idString,
    runId: idString,
  }),
  // Tranche 4: retention sweep exposed as a service-caller op (no in-app
  // worker convention exists; see lib/retention/sweep.ts).
  z.object({
    op: z.literal('retention-sweep'),
    noliUserId: idString,
  }),
])

// ---------------------------------------------------------------------------
// Tranche 4: enrichment + verification waterfall (SPEC-066 sections 4, 11.2)
// ---------------------------------------------------------------------------

// Exactly one of runId | workspaceId scopes the operation; the route enforces
// the at-least-one rule so both shapes share the union discriminator.
export const gtmEnrichBodySchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('plan'),
    noliUserId: idString,
    runId: idString.optional(),
    workspaceId: idString.optional(),
    playId: idString.optional(),
  }),
  z.object({
    op: z.literal('run'),
    noliUserId: idString,
    runId: idString.optional(),
    workspaceId: idString.optional(),
    playId: idString.optional(),
    maxCredits: z.number().int().min(1).optional(),
    expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    op: z.literal('status'),
    noliUserId: idString,
    runId: idString.optional(),
    workspaceId: idString.optional(),
    playId: idString.optional(),
  }),
])

export type GtmEnrichBody = z.infer<typeof gtmEnrichBodySchema>

const decisionMakerPlanInput = {
  noliUserId: idString,
  runId: idString,
  jobTitles: z.array(z.string().trim().min(1).max(60)).min(1).max(12).optional(),
  maxProfiles: z.number().int().min(1).max(25).optional(),
}

export const gtmDecisionMakersBodySchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('plan'), ...decisionMakerPlanInput }),
  z.object({
    op: z.literal('run'),
    ...decisionMakerPlanInput,
    maxCredits: z.number().int().min(1).optional(),
    expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    op: z.literal('status'),
    noliUserId: idString,
    runId: idString,
  }),
])

export type GtmDecisionMakersBody = z.infer<typeof gtmDecisionMakersBodySchema>

export const gtmCandidatesBodySchema = z.object({
  noliUserId: idString,
  op: z.enum(['list', 'review', 'detail', 'export']).optional().default('list'),
  // list filters
  runId: idString.optional(),
  playId: idString.optional(),
  workspaceId: idString.optional(),
  fitStatus: z.enum(['unscored', 'accepted', 'review', 'rejected']).optional(),
  // review + detail ops
  candidateId: idString.optional(),
  matchId: idString.optional(),
  verdict: z.enum(['accepted', 'rejected']).optional(),
  reason: z.string().trim().max(2000).optional(),
  // Server-injected from the Hub Idempotency-Key header. Required only by the
  // audited export operation; caller-supplied body copies are stripped.
  idempotency_key: idString.optional(),
}).superRefine((body, issue) => {
  if (body.op !== 'export') return
  for (const key of ['workspaceId', 'playId', 'idempotency_key'] as const) {
    if (!body[key]) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required for export`,
      })
    }
  }
})

export type GtmResearchRunsBody = z.infer<typeof gtmResearchRunsBodySchema>
export type GtmCandidatesBody = z.infer<typeof gtmCandidatesBodySchema>

// SPEC-069 manual-only consumer outreach. No send/dispatch op is accepted.
export const gtmManualOutreachBodySchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('list'),
    noliUserId: idString,
    workspaceId: idString,
    playId: idString.optional(),
    candidateId: idString.optional(),
  }),
  z.object({
    op: z.literal('create'),
    noliUserId: idString,
    workspaceId: idString,
    playId: idString,
    candidateId: idString,
    matchId: idString,
    channel: z.enum(['linkedin', 'x', 'public_profile']),
    // Server-injected from the Idempotency-Key header.
    idempotency_key: idString,
  }),
  z.object({
    op: z.literal('mark'),
    noliUserId: idString,
    draftId: idString,
    action: z.enum(['copied', 'opened', 'dismissed']),
  }),
])

export type GtmManualOutreachBody = z.infer<typeof gtmManualOutreachBodySchema>

// ---------------------------------------------------------------------------
// Tranche 5: campaign drafting + immutable batch approval (SPEC-066
// sections 4, 7, 8, 12)
// ---------------------------------------------------------------------------

const campaignTemplateSchema = z.object({
  subject: z.string().trim().min(1).max(500),
  body: z.string().min(1).max(20000),
})

const campaignChannelMixSchema = z.object({
  emails: z.number().int().min(1).max(3).optional(),
  linkedin: z.boolean().optional(),
  x: z.boolean().optional(),
})

const campaignAutoRefillSchema = z.object({
  enabled: z.boolean().optional(),
  target_accepted_per_day: z.number().int().min(1).max(25).optional(),
  max_raw_candidates_per_day: z.number().int().min(1).max(100).optional(),
  max_credits_per_day: z.number().int().min(1).max(2_500_000).optional(),
  run_hour_local: z.number().int().min(0).max(23).optional(),
  plan_hash: z.string().regex(/^[a-f0-9]{64}$/).optional().nullable(),
}).superRefine((value, ctx) => {
  if (value.enabled === true && !value.plan_hash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['plan_hash'],
      message: 'plan_hash is required when auto-refill is enabled',
    })
  }
  if (
    value.target_accepted_per_day != null
    && value.max_raw_candidates_per_day != null
    && value.target_accepted_per_day > value.max_raw_candidates_per_day
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target_accepted_per_day'],
      message: 'target_accepted_per_day cannot exceed max_raw_candidates_per_day',
    })
  }
})

// daily_cap is deliberately NOT capped here: the campaign library rejects
// values above the hard ceiling with an explicit, testable error code.
const campaignSettingsSchema = z.object({
  daily_cap: z.number().int().min(1).max(10000).optional(),
  send_window: z
    .object({
      start_hour: z.number().int().min(0).max(23).optional(),
      end_hour: z.number().int().min(1).max(24).optional(),
      timezone: z.string().trim().min(1).max(100).optional(),
    })
    .optional(),
  jitter_minutes: z.number().int().min(0).max(120).optional(),
  mailbox_connection_id: idString.optional().nullable(),
  duplicate_override: z.boolean().optional(),
  auto_refill: campaignAutoRefillSchema.optional(),
})

export const gtmCampaignsBodySchema = z.discriminatedUnion('op', [
  // Workspace-wide campaign list for the hub UI: org+tenant self-scoped,
  // soft-deleted excluded, capped at 50, newest first (lib/listing.ts).
  z.object({
    op: z.literal('list'),
    noliUserId: idString,
    workspaceId: idString.optional(),
  }),
  z.object({
    op: z.literal('analytics'),
    noliUserId: idString,
    workspaceId: idString,
  }),
  z.object({
    op: z.literal('create'),
    noliUserId: idString,
    workspaceId: idString,
    playId: idString,
    name: z.string().trim().min(1).max(200),
    channelMix: campaignChannelMixSchema.optional(),
    settings: campaignSettingsSchema.optional(),
  }),
  z.object({
    op: z.literal('draft-state'),
    noliUserId: idString,
    campaignId: idString,
  }),
  z.object({
    op: z.literal('list-senders'),
    noliUserId: idString,
  }),
  z.object({
    op: z.literal('update-sequence'),
    noliUserId: idString,
    campaignId: idString,
    expected_content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    sequence: z.object({
      emails: z.number().int().min(1).max(3),
      email_delay_days: z.array(z.number().int().min(0).max(30)).min(1).max(3),
      linkedin: z.boolean(),
      x: z.boolean(),
    }),
  }),
  z.object({
    op: z.literal('update-settings'),
    noliUserId: idString,
    campaignId: idString,
    expected_content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    settings: z.object({
      daily_cap: z.number().int().min(1).max(10000),
      send_window: z.object({
        start_hour: z.number().int().min(0).max(23),
        end_hour: z.number().int().min(1).max(24),
        timezone: z.string().trim().min(1).max(100),
      }),
      jitter_minutes: z.number().int().min(0).max(120),
      mailbox_connection_id: idString.nullable(),
      duplicate_override: z.boolean(),
      auto_refill: campaignAutoRefillSchema.optional(),
    }),
  }),
  z.object({
    op: z.literal('update-template'),
    noliUserId: idString,
    campaignId: idString,
    template: campaignTemplateSchema,
  }),
  z.object({
    op: z.literal('update-message'),
    noliUserId: idString,
    campaignId: idString,
    candidateId: idString,
    step_key: z.string().trim().min(1).max(200),
    expected_content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    expected_message_hash: z.string().regex(/^[a-f0-9]{64}$/),
    subject: z.string().trim().min(1).max(500),
    body_text: z.string().min(1).max(20_000),
  }),
  z.object({
    op: z.literal('exclude'),
    noliUserId: idString,
    campaignId: idString,
    candidateId: idString,
  }),
  z.object({
    op: z.literal('include'),
    noliUserId: idString,
    campaignId: idString,
    candidateId: idString,
  }),
  z.object({
    op: z.literal('approve'),
    noliUserId: idString,
    campaignId: idString,
    expected_content_hash: z.string().trim().min(16).max(128),
  }),
  z.object({
    op: z.literal('invalidate'),
    noliUserId: idString,
    campaignId: idString,
    reason: z.string().trim().min(1).max(200),
  }),
  z.object({
    op: z.literal('status'),
    noliUserId: idString,
    campaignId: idString,
  }),
  // Re-draft a single recipient with AI in the workspace's locked voice
  // (lib/campaign/ai-draft.ts). Invalidates an approved version like any other
  // draft mutation; falls back to the deterministic template when no locked
  // voice exists or drafting fails.
  z.object({
    op: z.literal('regenerate-message'),
    noliUserId: idString,
    campaignId: idString,
    candidateId: idString,
    // Threaded from the hub Idempotency-Key header; a repeat with the same key
    // returns the stored draft instead of making a second metered AI call.
    idempotency_key: idString,
  }),
  // Workspace-level settings write (CAN-SPAM sender postal address). Length
  // is bounded loosely here; the 300-char cap after trimming is enforced by
  // lib/workspace-settings.ts with a typed error. Empty / null = unset.
  z.object({
    op: z.literal('update-workspace-settings'),
    noliUserId: idString,
    workspaceId: idString,
    postal_address: z.string().max(2000).optional().nullable(),
  }),
])

const autoRefillLimitsSchema = z.object({
  targetAccepted: z.number().int().min(1).max(25),
  maxRawCandidates: z.number().int().min(1).max(100),
  maxCredits: z.number().int().min(1).max(2_500_000),
}).superRefine((value, ctx) => {
  if (value.targetAccepted > value.maxRawCandidates) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetAccepted'],
      message: 'targetAccepted cannot exceed maxRawCandidates',
    })
  }
})

export const gtmAutoRefillBodySchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('plan'),
    noliUserId: idString,
    campaignId: idString,
    limits: autoRefillLimitsSchema,
    run_hour_local: z.number().int().min(0).max(23),
  }),
  z.object({
    op: z.literal('status'),
    noliUserId: idString,
    campaignId: idString,
  }),
  z.object({
    op: z.literal('activate'),
    noliUserId: idString,
    campaignId: idString,
    expected_content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    expected_plan_hash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    op: z.literal('pause'),
    noliUserId: idString,
    campaignId: idString,
  }),
])

export type GtmAutoRefillBody = z.infer<typeof gtmAutoRefillBodySchema>

export type GtmCampaignsBody = z.infer<typeof gtmCampaignsBodySchema>

// ---------------------------------------------------------------------------
// Tranche 6: durable execution, replies, atomic stop (SPEC-066 sections 6,
// 8, 9, 12)
// ---------------------------------------------------------------------------

export const gtmExecutionBodySchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('launch'),
    noliUserId: idString,
    campaignId: idString,
    expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    op: z.literal('pause-campaign'),
    noliUserId: idString,
    campaignId: idString,
    expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    op: z.literal('resume-campaign'),
    noliUserId: idString,
    campaignId: idString,
    expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    op: z.literal('stop-campaign'),
    noliUserId: idString,
    campaignId: idString,
    expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    op: z.literal('complete-campaign'),
    noliUserId: idString,
    campaignId: idString,
    expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    op: z.literal('tick'),
    noliUserId: idString,
    limit: z.number().int().min(1).max(100).optional(),
  }),
  z.object({
    op: z.literal('recover-stuck'),
    noliUserId: idString,
  }),
  z.object({
    op: z.literal('correlate-replies'),
    noliUserId: idString,
    sinceMinutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
  }),
  z.object({
    op: z.literal('cursor-status'),
    noliUserId: idString,
    mailboxConnectionId: idString.optional(),
  }),
  z.object({
    op: z.literal('clear-mailbox-pause'),
    noliUserId: idString,
    mailboxConnectionId: idString,
    expectedFence: z.number().int().min(0),
    reason: z.enum([
      'false_positive',
      'sender_remediated',
      'provider_feedback_resolved',
      'manual_investigation_complete',
    ]),
  }).strict(),
  z.object({
    op: z.literal('enqueue-mailbox-ingestion'),
    noliUserId: idString,
    mailboxConnectionId: idString,
  }).strict(),
  z.object({
    op: z.literal('r4-owned-mailbox-ingest'),
    noliUserId: idString,
    mailboxConnectionId: idString,
    inReplyTo: z.string().regex(/^<[^<>\r\n]{1,990}>$/).optional(),
  }).strict(),
  z.object({
    op: z.literal('status'),
    noliUserId: idString,
    campaignId: idString,
  }),
])

export type GtmExecutionBody = z.infer<typeof gtmExecutionBodySchema>

const replyClassificationSchema = z.enum([
  'interested',
  'neutral_question',
  'not_now',
  'referral',
  'unsubscribe',
  'wrong_person',
  'negative',
])

export const gtmInboxBodySchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('list'),
    noliUserId: idString,
    filter: z.enum(['all', 'unread', 'interested']).optional(),
    // Case-insensitive search over the reply + counterparty fields (route
    // self-scopes; a blank/absent query returns the unfiltered list).
    query: z.string().trim().max(200).optional(),
  }),
  // Full correlated conversation for one reply: the reply plus the linked
  // inbound email_messages and the enrollment's outbound GTM sends,
  // chronologically ordered (lib/replies/thread.ts).
  z.object({
    op: z.literal('thread'),
    noliUserId: idString,
    replyId: idString,
  }),
  z.object({
    op: z.literal('classify'),
    noliUserId: idString,
    replyId: idString,
    classification: replyClassificationSchema,
  }),
  z.object({
    op: z.literal('record-social-reply'),
    noliUserId: idString,
    enrollmentId: idString,
    stepId: idString,
    note: z.string().trim().max(4000).optional().nullable(),
  }),
  z.object({
    op: z.literal('draft-response'),
    noliUserId: idString,
    replyId: idString,
    draft: z.object({
      subject: z.string().trim().max(500).optional().nullable(),
      body: z.string().min(1).max(20000),
    }),
  }),
  // AI-suggested reply grounded in the thread + classification + the
  // workspace locked voice (lib/replies/ai-reply.ts); stores draft_status
  // 'drafted' with an honest minimal-template fallback.
  z.object({
    op: z.literal('draft-response-ai'),
    noliUserId: idString,
    replyId: idString,
    // Threaded from the hub Idempotency-Key header; a repeat with the same key
    // returns the stored draft instead of making a second metered AI call.
    idempotency_key: idString,
  }),
  // approve-draft approves AND sends in one call, so the caller must echo the
  // sha256 of the draft it reviewed (draft_content_hash on the reply shape).
  // A draft rewritten between review and approval (including by the AI
  // drafter) fails 409 instead of shipping unseen content.
  z.object({
    op: z.literal('approve-draft'),
    noliUserId: idString,
    replyId: idString,
    expected_draft_hash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
])

export type GtmInboxBody = z.infer<typeof gtmInboxBodySchema>

export const gtmPrivacyBodySchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('status'),
    noliUserId: idString,
    requestId: idString,
  }),
  // Operator view of deletion requests that are still partial and approaching
  // (or past) their due date, so blocked DSR work is visible before the
  // statutory window closes.
  z.object({
    op: z.literal('list-partial'),
    noliUserId: idString,
    within_days: z.number().int().min(0).max(365).optional(),
  }),
  // Closes the 'crm_customers' DSR operation by anonymizing the promoted CRM
  // contact(s) recorded in the operation receipt.
  z.object({
    op: z.literal('complete-crm-contact-deletion'),
    noliUserId: idString,
    requestId: idString,
  }),
  z.object({
    op: z.literal('set-legal-hold'),
    noliUserId: idString,
    requestId: idString,
    reason: z.string().trim().min(1).max(2000),
  }),
  z.object({
    op: z.literal('clear-legal-hold'),
    noliUserId: idString,
    requestId: idString,
    reason: z.string().trim().min(1).max(2000),
  }),
])

export type GtmPrivacyBody = z.infer<typeof gtmPrivacyBodySchema>

const reconciliationEvidenceSchema = z.object({
  source: z.string().trim().min(1).max(100),
  reference: z.string().trim().min(1).max(500),
  observedAt: z.string().datetime({ offset: true }),
  summary: z.string().trim().min(1).max(2000),
  details: z.record(z.string(), z.unknown()),
})

const reconciliationDecisionSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('release') }),
  z.object({ outcome: z.literal('refunded'), chargedCredits: z.literal(0).optional() }),
  z.object({
    outcome: z.enum(['charged', 'partially_charged']),
    chargedCredits: z.number().int().min(0),
  }),
])

export const gtmReconciliationBodySchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), noliUserId: idString }),
  z.object({ op: z.literal('history'), noliUserId: idString }),
  z.object({ op: z.literal('catalog'), noliUserId: idString }).strict(),
  z.object({ op: z.literal('ai-telemetry'), noliUserId: idString }).strict(),
  z.object({ op: z.literal('opportunity-quality'), noliUserId: idString }).strict(),
  z.object({
    op: z.literal('repair-run-summaries'),
    noliUserId: idString,
    runIds: z.array(idString).min(1).max(50),
  }).strict(),
  // Bounded, idempotent replay of settlements whose Noli Core call was lost
  // after the provider was paid (adapters-money M5) and of provider rows that
  // were retained in a receipt while settlement was pending (research C2).
  z.object({
    op: z.literal('replay-settlements'),
    noliUserId: idString,
    limit: z.number().int().min(1).max(50).optional(),
  }).strict(),
  z.object({
    op: z.literal('replay-parked-output'),
    noliUserId: idString,
    operationId: idString,
  }).strict(),
  z.object({
    op: z.literal('apply'),
    noliUserId: idString,
    operationId: idString,
    idempotencyKey: z.string().trim().min(8).max(200),
    decision: reconciliationDecisionSchema,
    evidence: reconciliationEvidenceSchema,
  }),
])

export type GtmReconciliationBody = z.infer<typeof gtmReconciliationBodySchema>

// ---------------------------------------------------------------------------
// Tranche 7: manual social tasks + campaign timeline (SPEC-066 sections 9,
// 10, 12) and AMS/KB handoff (section 13)
// ---------------------------------------------------------------------------

// task keys are `task:{versionId}:{enrollmentId}:{stepId}`; malformed keys
// resolve to the same opaque task_not_found the routes return for missing
// rows (never a distinguishable 400).
const taskKeyString = z.string().trim().min(1).max(300)

export const gtmTasksBodySchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('list'),
    noliUserId: idString,
    campaignId: idString,
  }),
  z.object({
    op: z.literal('mark'),
    noliUserId: idString,
    taskKey: taskKeyString,
    outcome: z.enum(['sent', 'skipped', 'replied', 'requested', 'accepted']),
    note: z.string().trim().max(4000).optional().nullable(),
  }),
  z.object({
    op: z.literal('override-dependency'),
    noliUserId: idString,
    taskKey: taskKeyString,
    reason: z.string().trim().min(1).max(2000),
  }),
  z.object({
    op: z.literal('timeline'),
    noliUserId: idString,
    campaignId: idString,
    enrollmentId: idString.optional(),
  }),
])

export type GtmTasksBody = z.infer<typeof gtmTasksBodySchema>

// Asset URLs freeze into the immutable approval snapshot and the KB mirror,
// so only absolute https URLs are accepted (never javascript:/data: or a
// relative path a renderer could resolve unexpectedly).
const httpsUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((value) => value.toLowerCase().startsWith('https://'), {
    message: 'must be an https URL',
  })

const assetRefSchema = z.object({
  id: idString,
  kind: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(500),
  publishedUrl: httpsUrl,
  frozen_url: httpsUrl.optional().nullable(),
})

// Only play-level fields ever leave the CRM in an asset request (AMS handoff
// contract item 6: never prospect PII). An explicit strict shape replaces the
// previous open record so an unknown key cannot smuggle candidate data.
const playContextText = z.string().trim().max(4000).optional().nullable()
const assetPlayContextSchema = z
  .object({
    play_id: idString.optional().nullable(),
    market_type: z.enum(['b2b', 'b2c', 'mixed']).optional().nullable(),
    audience: playContextText,
    signal: playContextText,
    signal_kind: playContextText,
    geography: playContextText,
    recency_window: playContextText,
    why_now: playContextText,
    recommended_angle: playContextText,
    entity_unit: playContextText,
    likely_buyer: playContextText,
    supported_channels: z.array(z.string().trim().min(1).max(200)).max(50).optional().nullable(),
  })
  .strict()

export const gtmHandoffBodySchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('assets-list'),
    noliUserId: idString,
  }),
  z.object({
    op: z.literal('asset-request'),
    noliUserId: idString,
    kind: z.string().trim().min(1).max(100),
    brief: z.string().trim().min(1).max(4000),
    platform: z.string().trim().max(100).optional().nullable(),
    play_context: assetPlayContextSchema,
  }),
  z.object({
    op: z.literal('asset-status'),
    noliUserId: idString,
    requestId: z.string().trim().min(1).max(200),
  }),
  z.object({
    op: z.literal('attach-asset'),
    noliUserId: idString,
    campaignId: idString,
    assetRef: assetRefSchema,
  }),
  z.object({
    op: z.literal('kb-mirror-icp'),
    noliUserId: idString,
    workspaceId: idString,
    icpVersionId: idString,
  }),
  z.object({
    op: z.literal('kb-mirror-campaign'),
    noliUserId: idString,
    campaignId: idString,
  }),
])

export type GtmHandoffBody = z.infer<typeof gtmHandoffBodySchema>

// ---------------------------------------------------------------------------
// ICP + Voice Profile version CRUD, locks, and voice derivation (SPEC-066
// section 4, 4.3). All ops re-resolve identity server-side and self-scope.
// ---------------------------------------------------------------------------

// A version document is an arbitrary JSON object (the reviewable ICP / voice
// content). The library guards object-ness; shape is product-defined.
const versionContentSchema = z.record(z.string(), z.unknown())
const versionProvenanceSchema = z.record(z.string(), z.unknown())
const versionAuthorSchema = z.enum(['user', 'agent'])

// Voice derivation sources: a website URL and/or pasted sample messages. The
// route enforces at least one non-empty source.
const voiceDeriveSourcesSchema = z.object({
  website: z.string().trim().max(2000).optional().nullable(),
  samples: z.array(z.string().trim().min(1).max(20000)).max(20).optional().nullable(),
})

export const gtmStrategyBodySchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('icp-list'), noliUserId: idString, workspaceId: idString }),
  z.object({ op: z.literal('icp-get'), noliUserId: idString, workspaceId: idString, versionId: idString }),
  z.object({
    op: z.literal('icp-create'),
    noliUserId: idString,
    workspaceId: idString,
    content: versionContentSchema,
    provenance: versionProvenanceSchema.optional(),
    author: versionAuthorSchema.optional(),
  }),
  z.object({
    op: z.literal('icp-lock'),
    noliUserId: idString,
    workspaceId: idString,
    versionId: idString,
    locked: z.boolean(),
  }),
  z.object({
    op: z.literal('icp-revert'),
    noliUserId: idString,
    workspaceId: idString,
    sourceVersionId: idString,
    author: versionAuthorSchema.optional(),
  }),
  z.object({ op: z.literal('voice-list'), noliUserId: idString, workspaceId: idString }),
  z.object({ op: z.literal('voice-get'), noliUserId: idString, workspaceId: idString, versionId: idString }),
  z.object({
    op: z.literal('voice-create'),
    noliUserId: idString,
    workspaceId: idString,
    content: versionContentSchema,
    provenance: versionProvenanceSchema.optional(),
    author: versionAuthorSchema.optional(),
    derivedFrom: versionProvenanceSchema.optional().nullable(),
  }),
  z.object({
    op: z.literal('voice-lock'),
    noliUserId: idString,
    workspaceId: idString,
    versionId: idString,
    locked: z.boolean(),
  }),
  z.object({
    op: z.literal('voice-revert'),
    noliUserId: idString,
    workspaceId: idString,
    sourceVersionId: idString,
    author: versionAuthorSchema.optional(),
  }),
  z.object({
    op: z.literal('voice-derive'),
    noliUserId: idString,
    workspaceId: idString,
    sources: voiceDeriveSourcesSchema,
    // Threaded from the hub Idempotency-Key header; a repeat with the same key
    // returns the version derived on the first call instead of making a second
    // metered AI call and a second version.
    idempotency_key: idString,
  }),
])

export type GtmStrategyBody = z.infer<typeof gtmStrategyBodySchema>

// ---------------------------------------------------------------------------
// GTM Strategist chat persistence (GTM-SPEC-04 section 2.3). The hub runs the
// agent loop and persists each turn through these ops; all ops re-resolve
// identity server-side and self-scope by org+tenant.
// ---------------------------------------------------------------------------

// Turn payload is an arbitrary JSON object (message text plus, for assistant
// turns, the structured proposed actions the UI renders as confirm buttons).
// The store guards object-ness; shape is product-defined.
const chatContentSchema = z.record(z.string(), z.unknown()).refine(chatContentIsBounded, {
  message: 'chat content exceeds the 64 KiB serialized limit',
})

export const gtmChatBodySchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('thread-list'), noliUserId: idString, workspaceId: idString }),
  z.object({
    op: z.literal('thread-create'),
    noliUserId: idString,
    workspaceId: idString,
    title: z.string().trim().max(200).optional().nullable(),
  }),
  z.object({
    op: z.literal('messages'),
    noliUserId: idString,
    threadId: idString,
    limit: z.number().int().min(1).max(GTM_CHAT_MESSAGE_READ_CAP).optional(),
  }),
  z.object({
    op: z.literal('append-message'),
    noliUserId: idString,
    threadId: idString,
    role: z.enum(['user', 'assistant', 'tool']),
    content: chatContentSchema,
    toolRef: z.string().trim().max(200).optional().nullable(),
  }),
])

export type GtmChatBody = z.infer<typeof gtmChatBodySchema>

// ---------------------------------------------------------------------------
// Official social-platform connections (Threads keyword search)
// ---------------------------------------------------------------------------

export const gtmSocialConnectionsBodySchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('list'),
    noliUserId: idString,
  }),
  z.object({
    op: z.literal('threads-connect-start'),
    noliUserId: idString,
    // Absolute https URL on an owned Noli browser domain the callback may
    // return the user to. Validated again server-side before use.
    return_to: z.string().trim().url().max(2000),
  }),
  z.object({
    op: z.literal('disconnect'),
    noliUserId: idString,
    connectionId: idString,
  }),
])

export type GtmSocialConnectionsBody = z.infer<typeof gtmSocialConnectionsBodySchema>
