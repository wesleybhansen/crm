import { Migration } from '@mikro-orm/migrations';

export class Migration20260818044006_gtm extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "gtm_audit_events" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "actor" text not null, "actor_user_id" uuid null, "action" text not null, "object_type" text not null, "object_id" uuid null, "object_version" int null, "request_id" text null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_audit_events_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_audit_events_org_tenant_object_idx" on "gtm_audit_events" ("organization_id", "tenant_id", "object_type", "object_id");`);
    this.addSql(`create index "gtm_audit_events_org_tenant_idx" on "gtm_audit_events" ("organization_id", "tenant_id");`);

    this.addSql(`create table "gtm_suppressions" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "scope" text not null default 'org', "channel" text not null, "address_hash" text not null, "address_display" text null, "reason" text not null, "source" jsonb null, "expires_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_suppressions_pkey" primary key ("id"));`);
    this.addSql(`create unique index "gtm_suppressions_global_channel_address_unique" on "gtm_suppressions" ("channel", "address_hash") where scope = 'global';`);
    this.addSql(`create index "gtm_suppressions_org_tenant_idx" on "gtm_suppressions" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_suppressions" add constraint "gtm_suppressions_org_channel_address_unique" unique ("organization_id", "channel", "address_hash");`);

    this.addSql(`create table "gtm_workspaces" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "name" text not null, "status" text not null default 'draft', "business_context" jsonb null, "settings" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_workspaces_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_workspaces_org_tenant_idx" on "gtm_workspaces" ("organization_id", "tenant_id");`);

    this.addSql(`create table "gtm_voice_versions" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "workspace_id" uuid not null, "version" int not null, "content" jsonb not null, "locked" boolean not null default false, "locked_by_user_id" uuid null, "locked_at" timestamptz null, "provenance" jsonb null, "derived_from" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_voice_versions_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_voice_versions_org_tenant_idx" on "gtm_voice_versions" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_voice_versions" add constraint "gtm_voice_versions_workspace_version_unique" unique ("workspace_id", "version");`);

    this.addSql(`create table "gtm_plays" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "workspace_id" uuid not null, "source" text not null, "imported_report_token_hash" text null, "imported_play_key" text null, "market_type" text null, "audience" text null, "signal" text null, "signal_kind" text null, "provider_query" jsonb null, "source_hint" text null, "geography" text null, "recency_window" text null, "why_now" text null, "recommended_angle" text null, "supported_channels" jsonb null, "estimated_size" jsonb null, "entity_unit" text null, "estimate_method" text null, "estimate_basis" text null, "business_evidence" jsonb null, "confidence" text null, "confidence_rationale" text null, "likely_buyer" text null, "execution_eligibility" text not null, "eligibility_reason" text null, "eligibility_evaluated_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_plays_pkey" primary key ("id"));`);
    this.addSql(`create unique index "gtm_plays_org_report_play_key_unique" on "gtm_plays" ("organization_id", "imported_report_token_hash", "imported_play_key") where imported_report_token_hash is not null and imported_play_key is not null and deleted_at is null;`);
    this.addSql(`create index "gtm_plays_org_tenant_workspace_idx" on "gtm_plays" ("organization_id", "tenant_id", "workspace_id");`);
    this.addSql(`create index "gtm_plays_org_tenant_idx" on "gtm_plays" ("organization_id", "tenant_id");`);

    this.addSql(`create table "gtm_research_runs" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "workspace_id" uuid not null, "play_id" uuid not null, "input_snapshot" jsonb null, "provider_plan" jsonb null, "limits" jsonb null, "status" text not null default 'planned', "estimated_credits" numeric(12,4) null, "reconciled_credits" numeric(12,4) null, "started_at" timestamptz null, "completed_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_research_runs_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_research_runs_org_tenant_idx" on "gtm_research_runs" ("organization_id", "tenant_id");`);

    this.addSql(`create table "gtm_icp_versions" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "workspace_id" uuid not null, "version" int not null, "content" jsonb not null, "locked" boolean not null default false, "locked_by_user_id" uuid null, "locked_at" timestamptz null, "provenance" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_icp_versions_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_icp_versions_org_tenant_idx" on "gtm_icp_versions" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_icp_versions" add constraint "gtm_icp_versions_workspace_version_unique" unique ("workspace_id", "version");`);

    this.addSql(`create table "gtm_chat_threads" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "workspace_id" uuid not null, "title" text null, "status" text not null default 'active', "last_message_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_chat_threads_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_chat_threads_org_tenant_workspace_idx" on "gtm_chat_threads" ("organization_id", "tenant_id", "workspace_id");`);
    this.addSql(`create index "gtm_chat_threads_org_tenant_idx" on "gtm_chat_threads" ("organization_id", "tenant_id");`);

    this.addSql(`create table "gtm_chat_messages" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "thread_id" uuid not null, "role" text not null, "content" jsonb not null, "tool_ref" text null, "seq" int not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_chat_messages_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_chat_messages_org_tenant_thread_idx" on "gtm_chat_messages" ("organization_id", "tenant_id", "thread_id");`);
    this.addSql(`create index "gtm_chat_messages_org_tenant_idx" on "gtm_chat_messages" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_chat_messages" add constraint "gtm_chat_messages_thread_seq_unique" unique ("thread_id", "seq");`);

    this.addSql(`create table "gtm_candidates" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "research_run_id" uuid not null, "workspace_id" uuid not null, "entity_kind" text not null, "identity" jsonb not null, "dedupe_key" text not null, "fit_status" text not null default 'unscored', "fit_score" numeric(6,3) null, "reject_reason" text null, "quality_status" text null, "quality_score" numeric(6,3) null, "qualification" jsonb null, "qualification_version" text null, "retention_expires_at" timestamptz null, "promoted_contact_id" uuid null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_candidates_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_candidates_org_tenant_run_idx" on "gtm_candidates" ("organization_id", "tenant_id", "research_run_id");`);
    this.addSql(`create index "gtm_candidates_org_tenant_idx" on "gtm_candidates" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_candidates" add constraint "gtm_candidates_org_workspace_dedupe_unique" unique ("organization_id", "workspace_id", "dedupe_key");`);

    this.addSql(`create table "gtm_provider_operations" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "noli_core_operation_id" uuid not null, "research_run_id" uuid null, "candidate_id" uuid null, "kind" text not null, "provider" text not null, "local_status_mirror" text null, "receipt" jsonb null, "requested_at" timestamptz null, "settled_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_provider_operations_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_provider_operations_org_tenant_idx" on "gtm_provider_operations" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_provider_operations" add constraint "gtm_provider_operations_noli_core_operation_unique" unique ("noli_core_operation_id");`);

    this.addSql(`create table "gtm_evidence" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "candidate_id" uuid not null, "claim" text not null, "source_url" text null, "provider_ref" jsonb null, "observed_at" timestamptz null, "retrieved_at" timestamptz null, "confidence" numeric(6,3) null, "license" jsonb null, "quality_status" text null, "quality_issues" jsonb null, "evidence_type" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_evidence_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_evidence_org_tenant_candidate_idx" on "gtm_evidence" ("organization_id", "tenant_id", "candidate_id");`);
    this.addSql(`create index "gtm_evidence_org_tenant_idx" on "gtm_evidence" ("organization_id", "tenant_id");`);

    this.addSql(`create table "gtm_contact_points" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "candidate_id" uuid not null, "channel" text not null, "value" text not null, "verification_state" text not null default 'found', "provider_operation_id" uuid null, "provenance" jsonb null, "verified_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_contact_points_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_contact_points_org_tenant_candidate_idx" on "gtm_contact_points" ("organization_id", "tenant_id", "candidate_id");`);
    this.addSql(`create index "gtm_contact_points_org_tenant_idx" on "gtm_contact_points" ("organization_id", "tenant_id");`);

    this.addSql(`create table "gtm_campaigns" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "workspace_id" uuid not null, "play_id" uuid not null, "name" text not null, "status" text not null default 'draft', "current_version_id" uuid null, "channel_mix" jsonb null, "settings" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_campaigns_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_campaigns_org_tenant_idx" on "gtm_campaigns" ("organization_id", "tenant_id");`);

    this.addSql(`create table "gtm_campaign_versions" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "campaign_id" uuid not null, "version" int not null, "snapshot" jsonb not null, "content_hash" text not null, "approved_by_user_id" uuid null, "approved_at" timestamptz null, "invalidated_at" timestamptz null, "invalidated_reason" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_campaign_versions_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_campaign_versions_org_tenant_idx" on "gtm_campaign_versions" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_campaign_versions" add constraint "gtm_campaign_versions_campaign_version_unique" unique ("campaign_id", "version");`);

    this.addSql(`create table "gtm_steps" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "campaign_version_id" uuid not null, "order" int not null, "channel" text not null, "mode" text not null, "delay_days" int not null default 0, "send_window" jsonb null, "depends_on_step_id" uuid null, "dependency_kind" text not null default 'none', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_steps_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_steps_org_tenant_version_idx" on "gtm_steps" ("organization_id", "tenant_id", "campaign_version_id");`);
    this.addSql(`create index "gtm_steps_org_tenant_idx" on "gtm_steps" ("organization_id", "tenant_id");`);

    this.addSql(`create table "gtm_enrollments" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "campaign_id" uuid not null, "campaign_version_id" uuid not null, "candidate_id" uuid not null, "contact_id" uuid null, "status" text not null default 'active', "stop_reason" text null, "stopped_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_enrollments_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_enrollments_org_tenant_campaign_idx" on "gtm_enrollments" ("organization_id", "tenant_id", "campaign_id");`);
    this.addSql(`create index "gtm_enrollments_org_tenant_idx" on "gtm_enrollments" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_enrollments" add constraint "gtm_enrollments_campaign_candidate_unique" unique ("campaign_id", "candidate_id");`);

    this.addSql(`create table "gtm_rendered_messages" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "campaign_version_id" uuid not null, "enrollment_id" uuid not null, "step_id" uuid not null, "subject" text null, "body_html" text null, "body_text" text null, "content_hash" text not null, "edited_by_user_id" uuid null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_rendered_messages_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_rendered_messages_org_tenant_idx" on "gtm_rendered_messages" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_rendered_messages" add constraint "gtm_rendered_messages_enrollment_step_unique" unique ("enrollment_id", "step_id");`);

    this.addSql(`create table "gtm_send_attempts" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "enrollment_id" uuid not null, "step_id" uuid not null, "rendered_message_id" uuid null, "campaign_version_id" uuid not null, "mailbox_connection_id" uuid null, "state" text not null default 'planned', "claim_token" uuid null, "claim_expires_at" timestamptz null, "fence" int not null default 0, "attempt_no" int not null default 1, "idempotency_key" text not null, "provider_message_id" text null, "rfc_message_id" text null, "provider_receipt" jsonb null, "failure_reason" text null, "ambiguous_at" timestamptz null, "scheduled_for" timestamptz null, "sent_at" timestamptz null, "accepted_at" timestamptz null, "failed_at" timestamptz null, "delivered_at" timestamptz null, "bounced_at" timestamptz null, "complained_at" timestamptz null, "replied_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_send_attempts_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_send_attempts_rfc_message_id_idx" on "gtm_send_attempts" ("rfc_message_id");`);
    this.addSql(`create index "gtm_send_attempts_org_tenant_state_due_idx" on "gtm_send_attempts" ("organization_id", "tenant_id", "state", "scheduled_for");`);
    this.addSql(`create index "gtm_send_attempts_org_tenant_idx" on "gtm_send_attempts" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_send_attempts" add constraint "gtm_send_attempts_org_idempotency_unique" unique ("organization_id", "idempotency_key");`);

    this.addSql(`create table "gtm_replies" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "enrollment_id" uuid not null, "send_attempt_id" uuid null, "step_id" uuid null, "channel" text not null, "direction" text not null default 'inbound', "email_message_id" uuid null, "classification" text null, "classification_source" text null, "draft_response" jsonb null, "draft_status" text not null default 'none', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_replies_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_replies_org_tenant_enrollment_idx" on "gtm_replies" ("organization_id", "tenant_id", "enrollment_id");`);
    this.addSql(`create index "gtm_replies_org_tenant_idx" on "gtm_replies" ("organization_id", "tenant_id");`);

    this.addSql(`alter table "gtm_voice_versions" add constraint "gtm_voice_versions_workspace_id_foreign" foreign key ("workspace_id") references "gtm_workspaces" ("id") on update cascade;`);

    this.addSql(`alter table "gtm_plays" add constraint "gtm_plays_workspace_id_foreign" foreign key ("workspace_id") references "gtm_workspaces" ("id") on update cascade;`);

    this.addSql(`alter table "gtm_research_runs" add constraint "gtm_research_runs_workspace_id_foreign" foreign key ("workspace_id") references "gtm_workspaces" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_research_runs" add constraint "gtm_research_runs_play_id_foreign" foreign key ("play_id") references "gtm_plays" ("id") on update cascade;`);

    this.addSql(`alter table "gtm_icp_versions" add constraint "gtm_icp_versions_workspace_id_foreign" foreign key ("workspace_id") references "gtm_workspaces" ("id") on update cascade;`);

    this.addSql(`alter table "gtm_chat_threads" add constraint "gtm_chat_threads_workspace_id_foreign" foreign key ("workspace_id") references "gtm_workspaces" ("id") on update cascade;`);

    this.addSql(`alter table "gtm_chat_messages" add constraint "gtm_chat_messages_thread_id_foreign" foreign key ("thread_id") references "gtm_chat_threads" ("id") on update cascade;`);

    this.addSql(`alter table "gtm_candidates" add constraint "gtm_candidates_research_run_id_foreign" foreign key ("research_run_id") references "gtm_research_runs" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_candidates" add constraint "gtm_candidates_workspace_id_foreign" foreign key ("workspace_id") references "gtm_workspaces" ("id") on update cascade;`);

    this.addSql(`alter table "gtm_provider_operations" add constraint "gtm_provider_operations_research_run_id_foreign" foreign key ("research_run_id") references "gtm_research_runs" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "gtm_provider_operations" add constraint "gtm_provider_operations_candidate_id_foreign" foreign key ("candidate_id") references "gtm_candidates" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "gtm_evidence" add constraint "gtm_evidence_candidate_id_foreign" foreign key ("candidate_id") references "gtm_candidates" ("id") on update cascade;`);

    this.addSql(`alter table "gtm_contact_points" add constraint "gtm_contact_points_candidate_id_foreign" foreign key ("candidate_id") references "gtm_candidates" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_contact_points" add constraint "gtm_contact_points_provider_operation_id_foreign" foreign key ("provider_operation_id") references "gtm_provider_operations" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "gtm_campaigns" add constraint "gtm_campaigns_workspace_id_foreign" foreign key ("workspace_id") references "gtm_workspaces" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_campaigns" add constraint "gtm_campaigns_play_id_foreign" foreign key ("play_id") references "gtm_plays" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_campaigns" add constraint "gtm_campaigns_current_version_id_foreign" foreign key ("current_version_id") references "gtm_campaign_versions" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "gtm_campaign_versions" add constraint "gtm_campaign_versions_campaign_id_foreign" foreign key ("campaign_id") references "gtm_campaigns" ("id") on update cascade;`);

    this.addSql(`alter table "gtm_steps" add constraint "gtm_steps_campaign_version_id_foreign" foreign key ("campaign_version_id") references "gtm_campaign_versions" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_steps" add constraint "gtm_steps_depends_on_step_id_foreign" foreign key ("depends_on_step_id") references "gtm_steps" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "gtm_enrollments" add constraint "gtm_enrollments_campaign_id_foreign" foreign key ("campaign_id") references "gtm_campaigns" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_enrollments" add constraint "gtm_enrollments_campaign_version_id_foreign" foreign key ("campaign_version_id") references "gtm_campaign_versions" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_enrollments" add constraint "gtm_enrollments_candidate_id_foreign" foreign key ("candidate_id") references "gtm_candidates" ("id") on update cascade;`);

    this.addSql(`alter table "gtm_rendered_messages" add constraint "gtm_rendered_messages_campaign_version_id_foreign" foreign key ("campaign_version_id") references "gtm_campaign_versions" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_rendered_messages" add constraint "gtm_rendered_messages_enrollment_id_foreign" foreign key ("enrollment_id") references "gtm_enrollments" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_rendered_messages" add constraint "gtm_rendered_messages_step_id_foreign" foreign key ("step_id") references "gtm_steps" ("id") on update cascade;`);

    this.addSql(`alter table "gtm_send_attempts" add constraint "gtm_send_attempts_enrollment_id_foreign" foreign key ("enrollment_id") references "gtm_enrollments" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_send_attempts" add constraint "gtm_send_attempts_step_id_foreign" foreign key ("step_id") references "gtm_steps" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_send_attempts" add constraint "gtm_send_attempts_rendered_message_id_foreign" foreign key ("rendered_message_id") references "gtm_rendered_messages" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "gtm_send_attempts" add constraint "gtm_send_attempts_campaign_version_id_foreign" foreign key ("campaign_version_id") references "gtm_campaign_versions" ("id") on update cascade;`);

    this.addSql(`alter table "gtm_replies" add constraint "gtm_replies_enrollment_id_foreign" foreign key ("enrollment_id") references "gtm_enrollments" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_replies" add constraint "gtm_replies_send_attempt_id_foreign" foreign key ("send_attempt_id") references "gtm_send_attempts" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "gtm_replies" add constraint "gtm_replies_step_id_foreign" foreign key ("step_id") references "gtm_steps" ("id") on update cascade on delete set null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "gtm_voice_versions" drop constraint if exists "gtm_voice_versions_workspace_id_foreign";`);

    this.addSql(`alter table "gtm_plays" drop constraint if exists "gtm_plays_workspace_id_foreign";`);

    this.addSql(`alter table "gtm_research_runs" drop constraint if exists "gtm_research_runs_workspace_id_foreign";`);

    this.addSql(`alter table "gtm_icp_versions" drop constraint if exists "gtm_icp_versions_workspace_id_foreign";`);

    this.addSql(`alter table "gtm_chat_threads" drop constraint if exists "gtm_chat_threads_workspace_id_foreign";`);

    this.addSql(`alter table "gtm_candidates" drop constraint if exists "gtm_candidates_workspace_id_foreign";`);

    this.addSql(`alter table "gtm_campaigns" drop constraint if exists "gtm_campaigns_workspace_id_foreign";`);

    this.addSql(`alter table "gtm_research_runs" drop constraint if exists "gtm_research_runs_play_id_foreign";`);

    this.addSql(`alter table "gtm_campaigns" drop constraint if exists "gtm_campaigns_play_id_foreign";`);

    this.addSql(`alter table "gtm_candidates" drop constraint if exists "gtm_candidates_research_run_id_foreign";`);

    this.addSql(`alter table "gtm_provider_operations" drop constraint if exists "gtm_provider_operations_research_run_id_foreign";`);

    this.addSql(`alter table "gtm_chat_messages" drop constraint if exists "gtm_chat_messages_thread_id_foreign";`);

    this.addSql(`alter table "gtm_provider_operations" drop constraint if exists "gtm_provider_operations_candidate_id_foreign";`);

    this.addSql(`alter table "gtm_evidence" drop constraint if exists "gtm_evidence_candidate_id_foreign";`);

    this.addSql(`alter table "gtm_contact_points" drop constraint if exists "gtm_contact_points_candidate_id_foreign";`);

    this.addSql(`alter table "gtm_enrollments" drop constraint if exists "gtm_enrollments_candidate_id_foreign";`);

    this.addSql(`alter table "gtm_contact_points" drop constraint if exists "gtm_contact_points_provider_operation_id_foreign";`);

    this.addSql(`alter table "gtm_campaign_versions" drop constraint if exists "gtm_campaign_versions_campaign_id_foreign";`);

    this.addSql(`alter table "gtm_enrollments" drop constraint if exists "gtm_enrollments_campaign_id_foreign";`);

    this.addSql(`alter table "gtm_campaigns" drop constraint if exists "gtm_campaigns_current_version_id_foreign";`);

    this.addSql(`alter table "gtm_steps" drop constraint if exists "gtm_steps_campaign_version_id_foreign";`);

    this.addSql(`alter table "gtm_enrollments" drop constraint if exists "gtm_enrollments_campaign_version_id_foreign";`);

    this.addSql(`alter table "gtm_rendered_messages" drop constraint if exists "gtm_rendered_messages_campaign_version_id_foreign";`);

    this.addSql(`alter table "gtm_send_attempts" drop constraint if exists "gtm_send_attempts_campaign_version_id_foreign";`);

    this.addSql(`alter table "gtm_steps" drop constraint if exists "gtm_steps_depends_on_step_id_foreign";`);

    this.addSql(`alter table "gtm_rendered_messages" drop constraint if exists "gtm_rendered_messages_step_id_foreign";`);

    this.addSql(`alter table "gtm_send_attempts" drop constraint if exists "gtm_send_attempts_step_id_foreign";`);

    this.addSql(`alter table "gtm_replies" drop constraint if exists "gtm_replies_step_id_foreign";`);

    this.addSql(`alter table "gtm_rendered_messages" drop constraint if exists "gtm_rendered_messages_enrollment_id_foreign";`);

    this.addSql(`alter table "gtm_send_attempts" drop constraint if exists "gtm_send_attempts_enrollment_id_foreign";`);

    this.addSql(`alter table "gtm_replies" drop constraint if exists "gtm_replies_enrollment_id_foreign";`);

    this.addSql(`alter table "gtm_send_attempts" drop constraint if exists "gtm_send_attempts_rendered_message_id_foreign";`);

    this.addSql(`alter table "gtm_replies" drop constraint if exists "gtm_replies_send_attempt_id_foreign";`);
  }

}
