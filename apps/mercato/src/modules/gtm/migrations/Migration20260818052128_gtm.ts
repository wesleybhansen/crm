import { Migration } from '@mikro-orm/migrations';

export class Migration20260818052128_gtm extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "gtm_deletion_requests" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "idempotency_key" text not null, "scope" text not null, "address_hash" text not null, "status" text not null default 'pending', "legal_hold" boolean not null default false, "legal_hold_reason" text null, "requested_at" timestamptz not null, "due_at" timestamptz null, "completed_at" timestamptz null, "result_counts" jsonb null, "last_error" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_deletion_requests_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_deletion_requests_org_tenant_idx" on "gtm_deletion_requests" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_deletion_requests" add constraint "gtm_deletion_requests_org_key_unique" unique ("organization_id", "idempotency_key");`);

    this.addSql(`create table "gtm_dsr_operations" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "deletion_request_id" uuid not null, "provider" text not null, "kind" text not null, "idempotency_key" text not null, "status" text not null default 'pending', "attempt_count" int not null default 0, "next_attempt_at" timestamptz null, "receipt" jsonb null, "last_error" text null, "started_at" timestamptz null, "completed_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_dsr_operations_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_dsr_operations_org_tenant_idx" on "gtm_dsr_operations" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_dsr_operations" add constraint "gtm_dsr_operations_request_org_provider_kind_unique" unique ("deletion_request_id", "organization_id", "provider", "kind");`);

    this.addSql(`create table "gtm_mailbox_cursors" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "mailbox_connection_id" uuid not null, "provider" text not null, "cursor_kind" text not null, "cursor_hash" text null, "sealed_cursor" text null, "last_occurred_at" timestamptz null, "last_message_id" uuid null, "lease_token" uuid null, "lease_expires_at" timestamptz null, "fence" int not null default 0, "status" text not null default 'idle', "last_success_at" timestamptz null, "last_error" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_mailbox_cursors_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_mailbox_cursors_org_tenant_idx" on "gtm_mailbox_cursors" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_mailbox_cursors" add constraint "gtm_mailbox_cursors_mailbox_provider_kind_unique" unique ("organization_id", "tenant_id", "mailbox_connection_id", "provider", "cursor_kind");`);

    this.addSql(`create table "gtm_provider_reconciliation_actions" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "provider_operation_id" uuid not null, "idempotency_key" text not null, "decision" text not null, "expected_status" text not null, "resulting_status" text null, "charged_credits" bigint null, "evidence_hash" text not null, "evidence_redacted" jsonb not null, "actor_user_id" uuid not null, "status" text not null default 'pending', "failure_reason" text null, "completed_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_provider_reconciliation_actions_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_provider_reconciliation_actions_operation_idx" on "gtm_provider_reconciliation_actions" ("organization_id", "tenant_id", "provider_operation_id");`);
    this.addSql(`create index "gtm_provider_reconciliation_actions_org_tenant_idx" on "gtm_provider_reconciliation_actions" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_provider_reconciliation_actions" add constraint "gtm_provider_reconciliation_actions_org_key_unique" unique ("organization_id", "idempotency_key");`);

    this.addSql(`create table "gtm_inbound_events" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "mailbox_connection_id" uuid null, "provider" text not null, "provider_event_id" text not null, "dedupe_key" text not null, "event_kind" text not null, "provider_message_id" text null, "rfc_message_id" text null, "email_message_id" uuid null, "send_attempt_id" uuid null, "enrollment_id" uuid null, "correlation_method" text null, "correlation_confidence" text null, "address_hash" text null, "evidence_redacted" jsonb null, "processing_state" text not null default 'pending', "occurred_at" timestamptz not null, "processed_at" timestamptz null, "last_error" text null, "processing_claim_token" uuid null, "processing_claim_expires_at" timestamptz null, "processing_fence" int not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_inbound_events_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_inbound_events_attempt_idx" on "gtm_inbound_events" ("organization_id", "tenant_id", "send_attempt_id");`);
    this.addSql(`create index "gtm_inbound_events_org_tenant_idx" on "gtm_inbound_events" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_inbound_events" add constraint "gtm_inbound_events_org_tenant_dedupe_unique" unique ("organization_id", "tenant_id", "dedupe_key");`);

    this.addSql(`alter table "gtm_dsr_operations" add constraint "gtm_dsr_operations_deletion_request_id_foreign" foreign key ("deletion_request_id") references "gtm_deletion_requests" ("id") on update cascade;`);

    this.addSql(`alter table "gtm_provider_reconciliation_actions" add constraint "gtm_provider_reconciliation_actions_provider_ope_7d44d_foreign" foreign key ("provider_operation_id") references "gtm_provider_operations" ("id") on update cascade;`);

    this.addSql(`alter table "gtm_inbound_events" add constraint "gtm_inbound_events_send_attempt_id_foreign" foreign key ("send_attempt_id") references "gtm_send_attempts" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table "gtm_inbound_events" add constraint "gtm_inbound_events_enrollment_id_foreign" foreign key ("enrollment_id") references "gtm_enrollments" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "gtm_send_attempts" add column "capacity_slot_key" text null;`);
    this.addSql(`alter table "gtm_send_attempts" add constraint "gtm_send_attempts_org_capacity_slot_unique" unique ("organization_id", "capacity_slot_key");`);

    this.addSql(`alter table "gtm_replies" add column "inbound_event_id" uuid null, add column "event_kind" text null, add column "correlation_confidence" text null;`);
    this.addSql(`alter table "gtm_replies" add constraint "gtm_replies_org_tenant_social_step_unique" unique ("organization_id", "tenant_id", "enrollment_id", "step_id");`);
    this.addSql(`alter table "gtm_replies" add constraint "gtm_replies_org_tenant_message_unique" unique ("organization_id", "tenant_id", "email_message_id");`);
    this.addSql(`alter table "gtm_replies" add constraint "gtm_replies_org_tenant_event_unique" unique ("organization_id", "tenant_id", "inbound_event_id");`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "gtm_dsr_operations" drop constraint if exists "gtm_dsr_operations_deletion_request_id_foreign";`);

    this.addSql(`alter table "gtm_send_attempts" drop constraint if exists "gtm_send_attempts_org_capacity_slot_unique";`);
    this.addSql(`alter table "gtm_send_attempts" drop column "capacity_slot_key";`);

    this.addSql(`alter table "gtm_replies" drop constraint if exists "gtm_replies_org_tenant_social_step_unique";`);
    this.addSql(`alter table "gtm_replies" drop constraint if exists "gtm_replies_org_tenant_message_unique";`);
    this.addSql(`alter table "gtm_replies" drop constraint if exists "gtm_replies_org_tenant_event_unique";`);
    this.addSql(`alter table "gtm_replies" drop column "inbound_event_id", drop column "event_kind", drop column "correlation_confidence";`);
  }

}
