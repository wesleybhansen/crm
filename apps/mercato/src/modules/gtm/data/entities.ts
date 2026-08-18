import { Entity, Index, ManyToOne, OptionalProps, PrimaryKey, Property, Unique } from '@mikro-orm/core'

/*
 * GTM Engineer durable domain (SPEC-066 section 4, Tranche 2).
 *
 * Conventions shared by every table:
 * - uuid PK with gen_random_uuid() default
 * - organization_id + tenant_id uuid NOT NULL, composite index starting
 *   (organization_id, tenant_id)
 * - created_at / updated_at timestamptz, deleted_at nullable (soft delete)
 * - status/state columns are text (no PG enums) so the value sets stay
 *   additive-friendly; the frozen value sets are documented inline
 * - noli-core and other-module references are plain uuid columns so this
 *   module never takes migration ownership of another module's tables;
 *   intra-GTM references use mapToPk relations so the generated migration
 *   carries real foreign-key constraints while callers keep UUID strings
 */

@Entity({ tableName: 'gtm_workspaces' })
@Index({ name: 'gtm_workspaces_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
export class GtmWorkspace {
  [OptionalProps]?: 'id' | 'status' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ type: 'text' })
  name!: string

  // draft | active | archived
  @Property({ type: 'text', default: 'draft' })
  status: string = 'draft'

  @Property({ name: 'business_context', type: 'jsonb', nullable: true })
  businessContext?: Record<string, unknown> | null

  @Property({ type: 'jsonb', nullable: true })
  settings?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

// Rows are immutable after insert (SPEC-066 section 4).
@Entity({ tableName: 'gtm_icp_versions' })
@Index({ name: 'gtm_icp_versions_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'gtm_icp_versions_workspace_version_unique', properties: ['workspaceId', 'version'] })
export class GtmIcpVersion {
  [OptionalProps]?: 'id' | 'locked' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> gtm_workspaces.id
  @ManyToOne(() => GtmWorkspace, { fieldName: 'workspace_id', mapToPk: true })
  workspaceId!: string

  @Property({ type: 'integer' })
  version!: number

  @Property({ type: 'jsonb' })
  content!: Record<string, unknown>

  @Property({ type: 'boolean', default: false })
  locked: boolean = false

  @Property({ name: 'locked_by_user_id', type: 'uuid', nullable: true })
  lockedByUserId?: string | null

  @Property({ name: 'locked_at', type: 'timestamptz', nullable: true })
  lockedAt?: Date | null

  // { author: 'user' | 'agent', source refs }
  @Property({ type: 'jsonb', nullable: true })
  provenance?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

// Same shape as ICP versions; rows immutable after insert.
@Entity({ tableName: 'gtm_voice_versions' })
@Index({ name: 'gtm_voice_versions_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'gtm_voice_versions_workspace_version_unique', properties: ['workspaceId', 'version'] })
export class GtmVoiceVersion {
  [OptionalProps]?: 'id' | 'locked' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> gtm_workspaces.id
  @ManyToOne(() => GtmWorkspace, { fieldName: 'workspace_id', mapToPk: true })
  workspaceId!: string

  @Property({ type: 'integer' })
  version!: number

  @Property({ type: 'jsonb' })
  content!: Record<string, unknown>

  @Property({ type: 'boolean', default: false })
  locked: boolean = false

  @Property({ name: 'locked_by_user_id', type: 'uuid', nullable: true })
  lockedByUserId?: string | null

  @Property({ name: 'locked_at', type: 'timestamptz', nullable: true })
  lockedAt?: Date | null

  // { author: 'user' | 'agent', source refs }
  @Property({ type: 'jsonb', nullable: true })
  provenance?: Record<string, unknown> | null

  // website / sent-mail / pasted / social provenance
  @Property({ name: 'derived_from', type: 'jsonb', nullable: true })
  derivedFrom?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_plays' })
@Index({ name: 'gtm_plays_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'gtm_plays_org_tenant_workspace_idx', properties: ['organizationId', 'tenantId', 'workspaceId'] })
// Race-safe import idempotency: one live imported play per
// (org, report token hash, stable play key). A report contains several plays.
@Index({
  name: 'gtm_plays_org_report_play_key_unique',
  expression:
    `create unique index "gtm_plays_org_report_play_key_unique" on "gtm_plays" ("organization_id", "imported_report_token_hash", "imported_play_key") where imported_report_token_hash is not null and imported_play_key is not null and deleted_at is null`,
})
export class GtmPlay {
  [OptionalProps]?: 'id' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> gtm_workspaces.id
  @ManyToOne(() => GtmWorkspace, { fieldName: 'workspace_id', mapToPk: true })
  workspaceId!: string

  // imported | authored
  @Property({ type: 'text' })
  source!: string

  @Property({ name: 'imported_report_token_hash', type: 'text', nullable: true })
  importedReportTokenHash?: string | null

  @Property({ name: 'imported_play_key', type: 'text', nullable: true })
  importedPlayKey?: string | null

  // Typed play fields per GTM-SPEC-01 section 3.5
  // b2b | b2c | mixed | unknown
  @Property({ name: 'market_type', type: 'text', nullable: true })
  marketType?: string | null

  @Property({ type: 'text', nullable: true })
  audience?: string | null

  @Property({ type: 'text', nullable: true })
  signal?: string | null

  @Property({ name: 'signal_kind', type: 'text', nullable: true })
  signalKind?: string | null

  @Property({ name: 'provider_query', type: 'jsonb', nullable: true })
  providerQuery?: Record<string, unknown> | null

  @Property({ name: 'source_hint', type: 'text', nullable: true })
  sourceHint?: string | null

  @Property({ type: 'text', nullable: true })
  geography?: string | null

  @Property({ name: 'recency_window', type: 'text', nullable: true })
  recencyWindow?: string | null

  @Property({ name: 'why_now', type: 'text', nullable: true })
  whyNow?: string | null

  @Property({ name: 'recommended_angle', type: 'text', nullable: true })
  recommendedAngle?: string | null

  @Property({ name: 'supported_channels', type: 'jsonb', nullable: true })
  supportedChannels?: unknown[] | null

  @Property({ name: 'estimated_size', type: 'jsonb', nullable: true })
  estimatedSize?: Record<string, unknown> | null

  @Property({ name: 'entity_unit', type: 'text', nullable: true })
  entityUnit?: string | null

  @Property({ name: 'estimate_method', type: 'text', nullable: true })
  estimateMethod?: string | null

  @Property({ name: 'estimate_basis', type: 'text', nullable: true })
  estimateBasis?: string | null

  @Property({ name: 'business_evidence', type: 'jsonb', nullable: true })
  businessEvidence?: unknown[] | null

  // low | medium | high
  @Property({ type: 'text', nullable: true })
  confidence?: string | null

  // Model rationale for the confidence grade (additive to SPEC-066 section 4)
  @Property({ name: 'confidence_rationale', type: 'text', nullable: true })
  confidenceRationale?: string | null

  // Buyer persona carried alongside the imported play (additive to SPEC-066 section 4)
  @Property({ name: 'likely_buyer', type: 'text', nullable: true })
  likelyBuyer?: string | null

  // executable | strategy_only | unsupported (server-side computed, SPEC-066 section 7)
  @Property({ name: 'execution_eligibility', type: 'text' })
  executionEligibility!: string

  @Property({ name: 'eligibility_reason', type: 'text', nullable: true })
  eligibilityReason?: string | null

  @Property({ name: 'eligibility_evaluated_at', type: 'timestamptz', nullable: true })
  eligibilityEvaluatedAt?: Date | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_research_runs' })
@Index({ name: 'gtm_research_runs_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
export class GtmResearchRun {
  [OptionalProps]?: 'id' | 'status' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> gtm_workspaces.id
  @ManyToOne(() => GtmWorkspace, { fieldName: 'workspace_id', mapToPk: true })
  workspaceId!: string

  // -> gtm_plays.id
  @ManyToOne(() => GtmPlay, { fieldName: 'play_id', mapToPk: true })
  playId!: string

  @Property({ name: 'input_snapshot', type: 'jsonb', nullable: true })
  inputSnapshot?: Record<string, unknown> | null

  @Property({ name: 'provider_plan', type: 'jsonb', nullable: true })
  providerPlan?: Record<string, unknown> | null

  // { max_candidates, max_credits }
  @Property({ type: 'jsonb', nullable: true })
  limits?: Record<string, unknown> | null

  // planned | priced | running | completed | failed | cancelled
  @Property({ type: 'text', default: 'planned' })
  status: string = 'planned'

  @Property({ name: 'estimated_credits', type: 'decimal', precision: 12, scale: 4, nullable: true })
  estimatedCredits?: string | null

  @Property({ name: 'reconciled_credits', type: 'decimal', precision: 12, scale: 4, nullable: true })
  reconciledCredits?: string | null

  @Property({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt?: Date | null

  @Property({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt?: Date | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_candidates' })
@Index({ name: 'gtm_candidates_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'gtm_candidates_org_tenant_run_idx', properties: ['organizationId', 'tenantId', 'researchRunId'] })
@Unique({ name: 'gtm_candidates_org_workspace_dedupe_unique', properties: ['organizationId', 'workspaceId', 'dedupeKey'] })
export class GtmCandidate {
  [OptionalProps]?: 'id' | 'fitStatus' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> gtm_research_runs.id
  @ManyToOne(() => GtmResearchRun, { fieldName: 'research_run_id', mapToPk: true })
  researchRunId!: string

  // -> gtm_workspaces.id
  @ManyToOne(() => GtmWorkspace, { fieldName: 'workspace_id', mapToPk: true })
  workspaceId!: string

  // person | company
  @Property({ name: 'entity_kind', type: 'text' })
  entityKind!: string

  // { name, company, title, urls }
  @Property({ type: 'jsonb' })
  identity!: Record<string, unknown>

  // normalized identity hash
  @Property({ name: 'dedupe_key', type: 'text' })
  dedupeKey!: string

  // unscored | accepted | review | rejected
  @Property({ name: 'fit_status', type: 'text', default: 'unscored' })
  fitStatus: string = 'unscored'

  @Property({ name: 'fit_score', type: 'decimal', precision: 6, scale: 3, nullable: true })
  fitScore?: string | null

  @Property({ name: 'reject_reason', type: 'text', nullable: true })
  rejectReason?: string | null

  @Property({ name: 'quality_status', type: 'text', nullable: true })
  qualityStatus?: string | null

  @Property({ name: 'quality_score', type: 'decimal', precision: 6, scale: 3, nullable: true })
  qualityScore?: string | null

  @Property({ type: 'jsonb', nullable: true })
  qualification?: Record<string, unknown> | null

  @Property({ name: 'qualification_version', type: 'text', nullable: true })
  qualificationVersion?: string | null

  @Property({ name: 'retention_expires_at', type: 'timestamptz', nullable: true })
  retentionExpiresAt?: Date | null

  // -> customer_entities.id (cross-module, plain uuid; stays null for rejected candidates)
  @Property({ name: 'promoted_contact_id', type: 'uuid', nullable: true })
  promotedContactId?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_evidence' })
@Index({ name: 'gtm_evidence_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'gtm_evidence_org_tenant_candidate_idx', properties: ['organizationId', 'tenantId', 'candidateId'] })
export class GtmEvidence {
  [OptionalProps]?: 'id' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> gtm_candidates.id
  @ManyToOne(() => GtmCandidate, { fieldName: 'candidate_id', mapToPk: true })
  candidateId!: string

  @Property({ type: 'text' })
  claim!: string

  @Property({ name: 'source_url', type: 'text', nullable: true })
  sourceUrl?: string | null

  // { provider, record id, query snapshot }
  @Property({ name: 'provider_ref', type: 'jsonb', nullable: true })
  providerRef?: Record<string, unknown> | null

  @Property({ name: 'observed_at', type: 'timestamptz', nullable: true })
  observedAt?: Date | null

  @Property({ name: 'retrieved_at', type: 'timestamptz', nullable: true })
  retrievedAt?: Date | null

  @Property({ type: 'decimal', precision: 6, scale: 3, nullable: true })
  confidence?: string | null

  // { export / display constraints }
  @Property({ type: 'jsonb', nullable: true })
  license?: Record<string, unknown> | null

  @Property({ name: 'quality_status', type: 'text', nullable: true })
  qualityStatus?: string | null

  @Property({ name: 'quality_issues', type: 'jsonb', nullable: true })
  qualityIssues?: unknown[] | null

  @Property({ name: 'evidence_type', type: 'text', nullable: true })
  evidenceType?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_contact_points' })
@Index({ name: 'gtm_contact_points_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'gtm_contact_points_org_tenant_candidate_idx', properties: ['organizationId', 'tenantId', 'candidateId'] })
export class GtmContactPoint {
  [OptionalProps]?: 'id' | 'verificationState' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> gtm_candidates.id
  @ManyToOne(() => GtmCandidate, { fieldName: 'candidate_id', mapToPk: true })
  candidateId!: string

  // email | linkedin | x
  @Property({ type: 'text' })
  channel!: string

  // email address / profile URL
  @Property({ type: 'text' })
  value!: string

  // found | verified | risky | catch_all | not_found | unknown | provider_ambiguous
  @Property({ name: 'verification_state', type: 'text', default: 'found' })
  verificationState: string = 'found'

  // -> gtm_provider_operations.id
  @ManyToOne(() => GtmProviderOperation, {
    fieldName: 'provider_operation_id',
    mapToPk: true,
    nullable: true,
  })
  providerOperationId?: string | null

  @Property({ type: 'jsonb', nullable: true })
  provenance?: Record<string, unknown> | null

  @Property({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt?: Date | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_campaigns' })
@Index({ name: 'gtm_campaigns_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
export class GtmCampaign {
  [OptionalProps]?: 'id' | 'status' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> gtm_workspaces.id
  @ManyToOne(() => GtmWorkspace, { fieldName: 'workspace_id', mapToPk: true })
  workspaceId!: string

  // -> gtm_plays.id
  @ManyToOne(() => GtmPlay, { fieldName: 'play_id', mapToPk: true })
  playId!: string

  @Property({ type: 'text' })
  name!: string

  // draft | in_review | approved | launching | active | paused | stopped | completed
  @Property({ type: 'text', default: 'draft' })
  status: string = 'draft'

  // -> gtm_campaign_versions.id
  @ManyToOne(() => GtmCampaignVersion, {
    fieldName: 'current_version_id',
    mapToPk: true,
    nullable: true,
  })
  currentVersionId?: string | null

  @Property({ name: 'channel_mix', type: 'jsonb', nullable: true })
  channelMix?: Record<string, unknown> | null

  // { daily cap, send window, timezone, jitter }
  @Property({ type: 'jsonb', nullable: true })
  settings?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

// Immutable after approval (SPEC-066 section 4).
@Entity({ tableName: 'gtm_campaign_versions' })
@Index({ name: 'gtm_campaign_versions_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'gtm_campaign_versions_campaign_version_unique', properties: ['campaignId', 'version'] })
export class GtmCampaignVersion {
  [OptionalProps]?: 'id' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> gtm_campaigns.id
  @ManyToOne(() => GtmCampaign, { fieldName: 'campaign_id', mapToPk: true })
  campaignId!: string

  @Property({ type: 'integer' })
  version!: number

  // full recipient/step/schedule/exclusion/sender/cap/projected-credit freeze
  @Property({ type: 'jsonb' })
  snapshot!: Record<string, unknown>

  // SHA-256 of canonical snapshot
  @Property({ name: 'content_hash', type: 'text' })
  contentHash!: string

  @Property({ name: 'approved_by_user_id', type: 'uuid', nullable: true })
  approvedByUserId?: string | null

  @Property({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt?: Date | null

  @Property({ name: 'invalidated_at', type: 'timestamptz', nullable: true })
  invalidatedAt?: Date | null

  // e.g. scope_change (SPEC-066 section 7)
  @Property({ name: 'invalidated_reason', type: 'text', nullable: true })
  invalidatedReason?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_enrollments' })
@Index({ name: 'gtm_enrollments_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'gtm_enrollments_org_tenant_campaign_idx', properties: ['organizationId', 'tenantId', 'campaignId'] })
@Unique({ name: 'gtm_enrollments_campaign_candidate_unique', properties: ['campaignId', 'candidateId'] })
export class GtmEnrollment {
  [OptionalProps]?: 'id' | 'status' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> gtm_campaigns.id
  @ManyToOne(() => GtmCampaign, { fieldName: 'campaign_id', mapToPk: true })
  campaignId!: string

  // -> gtm_campaign_versions.id
  @ManyToOne(() => GtmCampaignVersion, { fieldName: 'campaign_version_id', mapToPk: true })
  campaignVersionId!: string

  // -> gtm_candidates.id
  @ManyToOne(() => GtmCandidate, { fieldName: 'candidate_id', mapToPk: true })
  candidateId!: string

  // -> customer_entities.id (cross-module, plain uuid)
  @Property({ name: 'contact_id', type: 'uuid', nullable: true })
  contactId?: string | null

  // active | stopped | completed
  @Property({ type: 'text', default: 'active' })
  status: string = 'active'

  // email_reply | social_reply | unsubscribe | bounce | complaint | manual | campaign_stopped
  @Property({ name: 'stop_reason', type: 'text', nullable: true })
  stopReason?: string | null

  @Property({ name: 'stopped_at', type: 'timestamptz', nullable: true })
  stoppedAt?: Date | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_steps' })
@Index({ name: 'gtm_steps_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'gtm_steps_org_tenant_version_idx', properties: ['organizationId', 'tenantId', 'campaignVersionId'] })
export class GtmStep {
  [OptionalProps]?: 'id' | 'delayDays' | 'dependencyKind' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> gtm_campaign_versions.id
  @ManyToOne(() => GtmCampaignVersion, { fieldName: 'campaign_version_id', mapToPk: true })
  campaignVersionId!: string

  @Property({ name: 'order', type: 'integer' })
  order!: number

  // email | linkedin | x
  @Property({ type: 'text' })
  channel!: string

  // automated_email | manual_social
  @Property({ type: 'text' })
  mode!: string

  @Property({ name: 'delay_days', type: 'integer', default: 0 })
  delayDays: number = 0

  @Property({ name: 'send_window', type: 'jsonb', nullable: true })
  sendWindow?: Record<string, unknown> | null

  // -> gtm_steps.id
  @ManyToOne(() => GtmStep, {
    fieldName: 'depends_on_step_id',
    mapToPk: true,
    nullable: true,
  })
  dependsOnStepId?: string | null

  // none | linkedin_connection_accepted
  @Property({ name: 'dependency_kind', type: 'text', default: 'none' })
  dependencyKind: string = 'none'

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

// Frozen at approval (SPEC-066 section 4).
@Entity({ tableName: 'gtm_rendered_messages' })
@Index({ name: 'gtm_rendered_messages_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'gtm_rendered_messages_enrollment_step_unique', properties: ['enrollmentId', 'stepId'] })
export class GtmRenderedMessage {
  [OptionalProps]?: 'id' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> gtm_campaign_versions.id
  @ManyToOne(() => GtmCampaignVersion, { fieldName: 'campaign_version_id', mapToPk: true })
  campaignVersionId!: string

  // -> gtm_enrollments.id
  @ManyToOne(() => GtmEnrollment, { fieldName: 'enrollment_id', mapToPk: true })
  enrollmentId!: string

  // -> gtm_steps.id
  @ManyToOne(() => GtmStep, { fieldName: 'step_id', mapToPk: true })
  stepId!: string

  @Property({ type: 'text', nullable: true })
  subject?: string | null

  @Property({ name: 'body_html', type: 'text', nullable: true })
  bodyHtml?: string | null

  @Property({ name: 'body_text', type: 'text', nullable: true })
  bodyText?: string | null

  @Property({ name: 'content_hash', type: 'text' })
  contentHash!: string

  @Property({ name: 'edited_by_user_id', type: 'uuid', nullable: true })
  editedByUserId?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_send_attempts' })
@Index({ name: 'gtm_send_attempts_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'gtm_send_attempts_org_tenant_state_due_idx', properties: ['organizationId', 'tenantId', 'state', 'scheduledFor'] })
@Index({ name: 'gtm_send_attempts_rfc_message_id_idx', properties: ['rfcMessageId'] })
@Index({ name: 'gtm_send_attempts_mailbox_capacity_idx', properties: ['organizationId', 'tenantId', 'mailboxConnectionId', 'state', 'scheduledFor'] })
@Unique({ name: 'gtm_send_attempts_org_idempotency_unique', properties: ['organizationId', 'idempotencyKey'] })
@Unique({ name: 'gtm_send_attempts_org_capacity_slot_unique', properties: ['organizationId', 'capacitySlotKey'] })
export class GtmSendAttempt {
  [OptionalProps]?: 'id' | 'state' | 'fence' | 'attemptNo' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> gtm_enrollments.id
  @ManyToOne(() => GtmEnrollment, { fieldName: 'enrollment_id', mapToPk: true })
  enrollmentId!: string

  // -> gtm_steps.id
  @ManyToOne(() => GtmStep, { fieldName: 'step_id', mapToPk: true })
  stepId!: string

  // -> gtm_rendered_messages.id
  @ManyToOne(() => GtmRenderedMessage, {
    fieldName: 'rendered_message_id',
    mapToPk: true,
    nullable: true,
  })
  renderedMessageId?: string | null

  // -> gtm_campaign_versions.id
  @ManyToOne(() => GtmCampaignVersion, { fieldName: 'campaign_version_id', mapToPk: true })
  campaignVersionId!: string

  // -> email_connections.id (cross-module, plain uuid)
  @Property({ name: 'mailbox_connection_id', type: 'uuid', nullable: true })
  mailboxConnectionId?: string | null

  // SPEC-067 sections 6/19 machine:
  // planned -> rendered -> reviewed -> approved <-> paused -> claimed -> provider_started
  //   -> accepted | failed | ambiguous, then accepted -> delivered | bounced | complained | replied
  @Property({ type: 'text', default: 'planned' })
  state: string = 'planned'

  @Property({ name: 'claim_token', type: 'uuid', nullable: true })
  claimToken?: string | null

  @Property({ name: 'claim_expires_at', type: 'timestamptz', nullable: true })
  claimExpiresAt?: Date | null

  @Property({ type: 'integer', default: 0 })
  fence: number = 0

  @Property({ name: 'attempt_no', type: 'integer', default: 1 })
  attemptNo: number = 1

  @Property({ name: 'idempotency_key', type: 'text' })
  idempotencyKey!: string

  @Property({ name: 'provider_message_id', type: 'text', nullable: true })
  providerMessageId?: string | null

  // our generated RFC Message-ID, persisted before provider contact (section 6 rule 3)
  @Property({ name: 'rfc_message_id', type: 'text', nullable: true })
  rfcMessageId?: string | null

  @Property({ name: 'provider_receipt', type: 'jsonb', nullable: true })
  providerReceipt?: Record<string, unknown> | null

  @Property({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason?: string | null

  @Property({ name: 'ambiguous_at', type: 'timestamptz', nullable: true })
  ambiguousAt?: Date | null

  @Property({ name: 'scheduled_for', type: 'timestamptz', nullable: true })
  scheduledFor?: Date | null

  // v1:mailbox-id:local-date:ordinal, allocated transactionally. Nullable for
  // manual-social and pre-C1 rows; Postgres permits multiple nulls in UNIQUE.
  @Property({ name: 'capacity_slot_key', type: 'text', nullable: true })
  capacitySlotKey?: string | null

  @Property({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt?: Date | null

  // Terminal timestamps
  @Property({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt?: Date | null

  @Property({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt?: Date | null

  @Property({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt?: Date | null

  @Property({ name: 'bounced_at', type: 'timestamptz', nullable: true })
  bouncedAt?: Date | null

  @Property({ name: 'complained_at', type: 'timestamptz', nullable: true })
  complainedAt?: Date | null

  @Property({ name: 'replied_at', type: 'timestamptz', nullable: true })
  repliedAt?: Date | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_replies' })
@Index({ name: 'gtm_replies_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'gtm_replies_org_tenant_enrollment_idx', properties: ['organizationId', 'tenantId', 'enrollmentId'] })
@Unique({ name: 'gtm_replies_org_tenant_event_unique', properties: ['organizationId', 'tenantId', 'inboundEventId'] })
@Unique({ name: 'gtm_replies_org_tenant_message_unique', properties: ['organizationId', 'tenantId', 'emailMessageId'] })
@Unique({ name: 'gtm_replies_org_tenant_social_step_unique', properties: ['organizationId', 'tenantId', 'enrollmentId', 'stepId'] })
export class GtmReply {
  [OptionalProps]?: 'id' | 'direction' | 'draftStatus' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> gtm_enrollments.id
  @ManyToOne(() => GtmEnrollment, { fieldName: 'enrollment_id', mapToPk: true })
  enrollmentId!: string

  // -> gtm_send_attempts.id (email replies)
  @ManyToOne(() => GtmSendAttempt, {
    fieldName: 'send_attempt_id',
    mapToPk: true,
    nullable: true,
  })
  sendAttemptId?: string | null

  // -> gtm_steps.id (social, user-recorded replies)
  @ManyToOne(() => GtmStep, { fieldName: 'step_id', mapToPk: true, nullable: true })
  stepId?: string | null

  // email | linkedin | x
  @Property({ type: 'text' })
  channel!: string

  // inbound
  @Property({ type: 'text', default: 'inbound' })
  direction: string = 'inbound'

  // -> email_messages.id (cross-module, plain uuid)
  @Property({ name: 'email_message_id', type: 'uuid', nullable: true })
  emailMessageId?: string | null

  // -> gtm_inbound_events.id; nullable for legacy/user-recorded social replies.
  @Property({ name: 'inbound_event_id', type: 'uuid', nullable: true })
  inboundEventId?: string | null

  // human_reply | social_reply. Delivery-system events never create a reply.
  @Property({ name: 'event_kind', type: 'text', nullable: true })
  eventKind?: string | null

  // exact_header | provider_message_id | mailbox_counterparty | user_recorded
  @Property({ name: 'correlation_confidence', type: 'text', nullable: true })
  correlationConfidence?: string | null

  // interested | neutral_question | not_now | referral | unsubscribe | wrong_person | negative
  @Property({ type: 'text', nullable: true })
  classification?: string | null

  // model | user_override
  @Property({ name: 'classification_source', type: 'text', nullable: true })
  classificationSource?: string | null

  @Property({ name: 'draft_response', type: 'jsonb', nullable: true })
  draftResponse?: Record<string, unknown> | null

  // none | drafted | approved | sent
  @Property({ name: 'draft_status', type: 'text', default: 'none' })
  draftStatus: string = 'none'

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_suppressions' })
@Index({ name: 'gtm_suppressions_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'gtm_suppressions_org_channel_address_unique', properties: ['organizationId', 'channel', 'addressHash'] })
@Index({
  name: 'gtm_suppressions_global_channel_address_unique',
  expression:
    `create unique index "gtm_suppressions_global_channel_address_unique" on "gtm_suppressions" ("channel", "address_hash") where scope = 'global'`,
})
export class GtmSuppression {
  [OptionalProps]?: 'id' | 'scope' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // org | global
  @Property({ type: 'text', default: 'org' })
  scope: string = 'org'

  // email | linkedin | x | all
  @Property({ type: 'text' })
  channel!: string

  // SHA-256 of the lowercased address
  @Property({ name: 'address_hash', type: 'text' })
  addressHash!: string

  @Property({ name: 'address_display', type: 'text', nullable: true })
  addressDisplay?: string | null

  // unsubscribe | hard_bounce | complaint | manual | duplicate | legal
  @Property({ type: 'text' })
  reason!: string

  @Property({ type: 'jsonb', nullable: true })
  source?: Record<string, unknown> | null

  @Property({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt?: Date | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

// Shadow only: never a balance, never a source of charge truth (SPEC-066 section 4).
@Entity({ tableName: 'gtm_provider_operations' })
@Index({ name: 'gtm_provider_operations_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'gtm_provider_operations_noli_core_operation_unique', properties: ['noliCoreOperationId'] })
export class GtmProviderOperation {
  [OptionalProps]?: 'id' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // canonical noli-core credit-ledger operation id (cross-app, plain uuid)
  @Property({ name: 'noli_core_operation_id', type: 'uuid' })
  noliCoreOperationId!: string

  // -> gtm_research_runs.id
  @ManyToOne(() => GtmResearchRun, {
    fieldName: 'research_run_id',
    mapToPk: true,
    nullable: true,
  })
  researchRunId?: string | null

  // -> gtm_candidates.id
  @ManyToOne(() => GtmCandidate, { fieldName: 'candidate_id', mapToPk: true, nullable: true })
  candidateId?: string | null

  @Property({ type: 'text' })
  kind!: string

  @Property({ type: 'text' })
  provider!: string

  @Property({ name: 'local_status_mirror', type: 'text', nullable: true })
  localStatusMirror?: string | null

  @Property({ type: 'jsonb', nullable: true })
  receipt?: Record<string, unknown> | null

  @Property({ name: 'requested_at', type: 'timestamptz', nullable: true })
  requestedAt?: Date | null

  @Property({ name: 'settled_at', type: 'timestamptz', nullable: true })
  settledAt?: Date | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_provider_reconciliation_actions' })
@Index({ name: 'gtm_provider_reconciliation_actions_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'gtm_provider_reconciliation_actions_operation_idx', properties: ['organizationId', 'tenantId', 'providerOperationId'] })
@Unique({ name: 'gtm_provider_reconciliation_actions_org_key_unique', properties: ['organizationId', 'idempotencyKey'] })
export class GtmProviderReconciliationAction {
  [OptionalProps]?: 'id' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @ManyToOne(() => GtmProviderOperation, { fieldName: 'provider_operation_id', mapToPk: true })
  providerOperationId!: string

  @Property({ name: 'idempotency_key', type: 'text' })
  idempotencyKey!: string

  // release | charged | partially_charged | refunded
  @Property({ type: 'text' })
  decision!: string

  @Property({ name: 'expected_status', type: 'text' })
  expectedStatus!: string

  @Property({ name: 'resulting_status', type: 'text', nullable: true })
  resultingStatus?: string | null

  @Property({ name: 'charged_credits', type: 'bigint', nullable: true })
  chargedCredits?: number | null

  @Property({ name: 'evidence_hash', type: 'text' })
  evidenceHash!: string

  @Property({ name: 'evidence_redacted', type: 'jsonb' })
  evidenceRedacted!: Record<string, unknown>

  @Property({ name: 'actor_user_id', type: 'uuid' })
  actorUserId!: string

  // pending -> completed | rejected
  @Property({ type: 'text', default: 'pending' })
  status: string = 'pending'

  @Property({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason?: string | null

  @Property({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt?: Date | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_mailbox_cursors' })
@Index({ name: 'gtm_mailbox_cursors_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'gtm_mailbox_cursors_mailbox_provider_kind_unique', properties: ['organizationId', 'tenantId', 'mailboxConnectionId', 'provider', 'cursorKind'] })
export class GtmMailboxCursor {
  [OptionalProps]?: 'id' | 'fence' | 'status' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> email_connections.id (cross-module, plain uuid)
  @Property({ name: 'mailbox_connection_id', type: 'uuid' })
  mailboxConnectionId!: string

  @Property({ type: 'text' })
  provider!: string

  @Property({ name: 'cursor_kind', type: 'text' })
  cursorKind!: string

  @Property({ name: 'cursor_hash', type: 'text', nullable: true })
  cursorHash?: string | null

  // Tenant-encrypted/codec-sealed opaque value only; never plaintext provider URLs.
  @Property({ name: 'sealed_cursor', type: 'text', nullable: true })
  sealedCursor?: string | null

  @Property({ name: 'last_occurred_at', type: 'timestamptz', nullable: true })
  lastOccurredAt?: Date | null

  @Property({ name: 'last_message_id', type: 'uuid', nullable: true })
  lastMessageId?: string | null

  @Property({ name: 'lease_token', type: 'uuid', nullable: true })
  leaseToken?: string | null

  @Property({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt?: Date | null

  @Property({ type: 'integer', default: 0 })
  fence: number = 0

  // idle | running | error | resync_required
  @Property({ type: 'text', default: 'idle' })
  status: string = 'idle'

  @Property({ name: 'last_success_at', type: 'timestamptz', nullable: true })
  lastSuccessAt?: Date | null

  @Property({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_mailbox_health' })
@Index({ name: 'gtm_mailbox_health_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'gtm_mailbox_health_org_tenant_mailbox_unique', properties: ['organizationId', 'tenantId', 'mailboxConnectionId'] })
export class GtmMailboxHealth {
  [OptionalProps]?: 'id' | 'policyVersion' | 'status' | 'acceptedCount' | 'deliveredCount' | 'softBounceCount' | 'hardBounceCount' | 'complaintCount' | 'fence' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> email_connections.id (cross-module, plain uuid)
  @Property({ name: 'mailbox_connection_id', type: 'uuid' })
  mailboxConnectionId!: string

  @Property({ name: 'policy_version', type: 'text', default: 'mailbox-health-v1' })
  policyVersion: string = 'mailbox-health-v1'

  // healthy | warning | paused
  @Property({ type: 'text', default: 'healthy' })
  status: string = 'healthy'

  @Property({ name: 'rolling_window_started_at', type: 'timestamptz' })
  rollingWindowStartedAt!: Date

  @Property({ name: 'accepted_count', type: 'integer', default: 0 })
  acceptedCount: number = 0

  @Property({ name: 'delivered_count', type: 'integer', default: 0 })
  deliveredCount: number = 0

  @Property({ name: 'soft_bounce_count', type: 'integer', default: 0 })
  softBounceCount: number = 0

  @Property({ name: 'hard_bounce_count', type: 'integer', default: 0 })
  hardBounceCount: number = 0

  @Property({ name: 'complaint_count', type: 'integer', default: 0 })
  complaintCount: number = 0

  @Property({ name: 'pause_reason', type: 'text', nullable: true })
  pauseReason?: string | null

  // Null means an operator must explicitly clear the pause.
  @Property({ name: 'pause_until', type: 'timestamptz', nullable: true })
  pauseUntil?: Date | null

  @Property({ name: 'last_event_at', type: 'timestamptz', nullable: true })
  lastEventAt?: Date | null

  @Property({ type: 'integer', default: 0 })
  fence: number = 0

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_mailbox_policies' })
@Index({ name: 'gtm_mailbox_policies_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'gtm_mailbox_policies_org_tenant_mailbox_unique', properties: ['organizationId', 'tenantId', 'mailboxConnectionId'] })
export class GtmMailboxPolicy {
  [OptionalProps]?: 'id' | 'policyVersion' | 'dailyCap' | 'sendWindowStartHour' | 'sendWindowEndHour' | 'timezone' | 'fence' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string
  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string
  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string
  @Property({ name: 'mailbox_connection_id', type: 'uuid' })
  mailboxConnectionId!: string
  @Property({ name: 'policy_version', type: 'text', default: 'mailbox-capacity-v1' })
  policyVersion: string = 'mailbox-capacity-v1'
  @Property({ name: 'daily_cap', type: 'integer', default: 25 })
  dailyCap: number = 25
  @Property({ name: 'send_window_start_hour', type: 'integer', default: 9 })
  sendWindowStartHour: number = 9
  @Property({ name: 'send_window_end_hour', type: 'integer', default: 17 })
  sendWindowEndHour: number = 17
  @Property({ type: 'text', default: 'America/New_York' })
  timezone: string = 'America/New_York'
  @Property({ name: 'bound_by_campaign_version_id', type: 'uuid' })
  boundByCampaignVersionId!: string
  @Property({ type: 'integer', default: 0 })
  fence: number = 0
  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()
  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()
  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_ai_telemetry' })
@Index({ name: 'gtm_ai_telemetry_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'gtm_ai_telemetry_org_tenant_surface_idx', properties: ['organizationId', 'tenantId', 'surface', 'createdAt'] })
@Unique({ name: 'gtm_ai_telemetry_org_operation_unique', properties: ['organizationId', 'operationKey'] })
export class GtmAiTelemetry {
  [OptionalProps]?: 'id' | 'status' | 'tokensIn' | 'tokensOut' | 'tokenUsageKnown' | 'retryCount' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'operation_key', type: 'text' })
  operationKey!: string

  @Property({ type: 'text' })
  surface!: string

  @Property({ type: 'text', nullable: true })
  model?: string | null

  // succeeded | failed
  @Property({ type: 'text', default: 'succeeded' })
  status: string = 'succeeded'

  @Property({ name: 'tokens_in', type: 'integer', default: 0 })
  tokensIn: number = 0

  @Property({ name: 'tokens_out', type: 'integer', default: 0 })
  tokensOut: number = 0

  // False means the provider failed before returning authoritative usage.
  // In that state zero tokens is an unknown value, never evidence of no cost.
  @Property({ name: 'token_usage_known', type: 'boolean', default: true })
  tokenUsageKnown: boolean = true

  // Counts only: system, tools, history, evidence, provider rows, summary.
  @Property({ name: 'component_estimates', type: 'jsonb', nullable: true })
  componentEstimates?: Record<string, unknown> | null

  @Property({ name: 'latency_ms', type: 'integer', nullable: true })
  latencyMs?: number | null

  @Property({ name: 'retry_count', type: 'integer', default: 0 })
  retryCount: number = 0

  @Property({ name: 'estimated_cost_microusd', type: 'bigint', nullable: true })
  estimatedCostMicrousd?: number | null

  @Property({ name: 'rate_card_version', type: 'text', nullable: true })
  rateCardVersion?: string | null

  @Property({ name: 'failure_code', type: 'text', nullable: true })
  failureCode?: string | null

  @Property({ name: 'request_id', type: 'text', nullable: true })
  requestId?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_inbound_events' })
@Index({ name: 'gtm_inbound_events_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'gtm_inbound_events_attempt_idx', properties: ['organizationId', 'tenantId', 'sendAttemptId'] })
@Unique({ name: 'gtm_inbound_events_org_tenant_dedupe_unique', properties: ['organizationId', 'tenantId', 'dedupeKey'] })
export class GtmInboundEvent {
  [OptionalProps]?: 'id' | 'processingState' | 'processingFence' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'mailbox_connection_id', type: 'uuid', nullable: true })
  mailboxConnectionId?: string | null

  @Property({ type: 'text' })
  provider!: string

  @Property({ name: 'provider_event_id', type: 'text' })
  providerEventId!: string

  // SHA-256(provider, mailbox stream, kind, provider event/message identity).
  @Property({ name: 'dedupe_key', type: 'text' })
  dedupeKey!: string

  // delivered | soft_bounce | hard_bounce | complaint | out_of_office |
  // auto_reply | human_reply | unsubscribe | unknown
  @Property({ name: 'event_kind', type: 'text' })
  eventKind!: string

  @Property({ name: 'provider_message_id', type: 'text', nullable: true })
  providerMessageId?: string | null

  @Property({ name: 'rfc_message_id', type: 'text', nullable: true })
  rfcMessageId?: string | null

  @Property({ name: 'email_message_id', type: 'uuid', nullable: true })
  emailMessageId?: string | null

  @ManyToOne(() => GtmSendAttempt, { fieldName: 'send_attempt_id', mapToPk: true, nullable: true })
  sendAttemptId?: string | null

  @ManyToOne(() => GtmEnrollment, { fieldName: 'enrollment_id', mapToPk: true, nullable: true })
  enrollmentId?: string | null

  @Property({ name: 'correlation_method', type: 'text', nullable: true })
  correlationMethod?: string | null

  @Property({ name: 'correlation_confidence', type: 'text', nullable: true })
  correlationConfidence?: string | null

  @Property({ name: 'address_hash', type: 'text', nullable: true })
  addressHash?: string | null

  @Property({ name: 'evidence_redacted', type: 'jsonb', nullable: true })
  evidenceRedacted?: Record<string, unknown> | null

  // pending -> processed | unmatched | failed
  @Property({ name: 'processing_state', type: 'text', default: 'pending' })
  processingState: string = 'pending'

  @Property({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date

  @Property({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt?: Date | null

  @Property({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null

  @Property({ name: 'processing_claim_token', type: 'uuid', nullable: true })
  processingClaimToken?: string | null

  @Property({ name: 'processing_claim_expires_at', type: 'timestamptz', nullable: true })
  processingClaimExpiresAt?: Date | null

  @Property({ name: 'processing_fence', type: 'integer', default: 0 })
  processingFence: number = 0

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_deletion_requests' })
@Index({ name: 'gtm_deletion_requests_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'gtm_deletion_requests_org_key_unique', properties: ['organizationId', 'idempotencyKey'] })
export class GtmDeletionRequest {
  [OptionalProps]?: 'id' | 'status' | 'legalHold' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'idempotency_key', type: 'text' })
  idempotencyKey!: string

  @Property({ type: 'text' })
  scope!: string

  @Property({ name: 'address_hash', type: 'text' })
  addressHash!: string

  // pending -> processing -> completed | partial | blocked_legal_hold | failed
  @Property({ type: 'text', default: 'pending' })
  status: string = 'pending'

  @Property({ name: 'legal_hold', type: 'boolean', default: false })
  legalHold: boolean = false

  @Property({ name: 'legal_hold_reason', type: 'text', nullable: true })
  legalHoldReason?: string | null

  @Property({ name: 'requested_at', type: 'timestamptz' })
  requestedAt!: Date

  @Property({ name: 'due_at', type: 'timestamptz', nullable: true })
  dueAt?: Date | null

  @Property({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt?: Date | null

  @Property({ name: 'result_counts', type: 'jsonb', nullable: true })
  resultCounts?: Record<string, unknown> | null

  @Property({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_dsr_operations' })
@Index({ name: 'gtm_dsr_operations_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Unique({ name: 'gtm_dsr_operations_request_org_provider_kind_unique', properties: ['deletionRequestId', 'organizationId', 'provider', 'kind'] })
export class GtmDsrOperation {
  [OptionalProps]?: 'id' | 'status' | 'attemptCount' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @ManyToOne(() => GtmDeletionRequest, { fieldName: 'deletion_request_id', mapToPk: true })
  deletionRequestId!: string

  @Property({ type: 'text' })
  provider!: string

  // local_anonymize | provider_delete
  @Property({ type: 'text' })
  kind!: string

  @Property({ name: 'idempotency_key', type: 'text' })
  idempotencyKey!: string

  // pending | blocked_authority | in_progress | completed | not_supported | failed
  @Property({ type: 'text', default: 'pending' })
  status: string = 'pending'

  @Property({ name: 'attempt_count', type: 'integer', default: 0 })
  attemptCount: number = 0

  @Property({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt?: Date | null

  @Property({ type: 'jsonb', nullable: true })
  receipt?: Record<string, unknown> | null

  @Property({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null

  @Property({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt?: Date | null

  @Property({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt?: Date | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

// Durable Strategist chat state (GTM-SPEC-04 section 2.3). A thread is
// workspace-scoped; messages are an append-only, gap-free sequence keyed by
// (thread_id, seq). The hub runs the agent loop statelessly and persists each
// turn here through the /internal/gtm/chat ops.
@Entity({ tableName: 'gtm_chat_threads' })
@Index({ name: 'gtm_chat_threads_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'gtm_chat_threads_org_tenant_workspace_idx', properties: ['organizationId', 'tenantId', 'workspaceId'] })
export class GtmChatThread {
  [OptionalProps]?: 'id' | 'status' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> gtm_workspaces.id
  @ManyToOne(() => GtmWorkspace, { fieldName: 'workspace_id', mapToPk: true })
  workspaceId!: string

  @Property({ type: 'text', nullable: true })
  title?: string | null

  // active | archived
  @Property({ type: 'text', default: 'active' })
  status: string = 'active'

  @Property({ name: 'last_message_at', type: 'timestamptz', nullable: true })
  lastMessageAt?: Date | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

// Append-only turn log. seq is a gap-free 1-based counter within a thread; the
// (thread_id, seq) unique index makes the append-safe allocation race-proof
// (a losing concurrent insert collides and retries). content is the structured
// turn payload (message text plus, for assistant turns, proposed actions).
@Entity({ tableName: 'gtm_chat_messages' })
@Index({ name: 'gtm_chat_messages_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'gtm_chat_messages_org_tenant_thread_idx', properties: ['organizationId', 'tenantId', 'threadId'] })
@Unique({ name: 'gtm_chat_messages_thread_seq_unique', properties: ['threadId', 'seq'] })
export class GtmChatMessage {
  [OptionalProps]?: 'id' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // -> gtm_chat_threads.id
  @ManyToOne(() => GtmChatThread, { fieldName: 'thread_id', mapToPk: true })
  threadId!: string

  // user | assistant | tool
  @Property({ type: 'text' })
  role!: string

  @Property({ type: 'jsonb' })
  content!: Record<string, unknown>

  // optional pointer to the op/tool the turn is about (e.g. a research run id)
  @Property({ name: 'tool_ref', type: 'text', nullable: true })
  toolRef?: string | null

  @Property({ type: 'integer' })
  seq!: number

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'gtm_audit_events' })
@Index({ name: 'gtm_audit_events_org_tenant_idx', properties: ['organizationId', 'tenantId'] })
@Index({ name: 'gtm_audit_events_org_tenant_object_idx', properties: ['organizationId', 'tenantId', 'objectType', 'objectId'] })
export class GtmAuditEvent {
  [OptionalProps]?: 'id' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  // user_id | system | agent
  @Property({ type: 'text' })
  actor!: string

  // resolved user id when actor = 'user_id' (additive to SPEC-066 section 4)
  @Property({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId?: string | null

  @Property({ type: 'text' })
  action!: string

  @Property({ name: 'object_type', type: 'text' })
  objectType!: string

  @Property({ name: 'object_id', type: 'uuid', nullable: true })
  objectId?: string | null

  @Property({ name: 'object_version', type: 'integer', nullable: true })
  objectVersion?: number | null

  @Property({ name: 'request_id', type: 'text', nullable: true })
  requestId?: string | null

  // redacted
  @Property({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: 'timestamptz', defaultRaw: 'now()' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', defaultRaw: 'now()', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt?: Date | null
}
