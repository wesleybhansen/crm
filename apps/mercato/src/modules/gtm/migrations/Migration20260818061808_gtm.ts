import { Migration } from '@mikro-orm/migrations';

export class Migration20260818061808_gtm extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "gtm_ai_telemetry" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "operation_key" text not null, "surface" text not null, "model" text null, "status" text not null default 'succeeded', "tokens_in" int not null default 0, "tokens_out" int not null default 0, "component_estimates" jsonb null, "latency_ms" int null, "retry_count" int not null default 0, "estimated_cost_microusd" bigint null, "rate_card_version" text null, "failure_code" text null, "request_id" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_ai_telemetry_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_ai_telemetry_org_tenant_surface_idx" on "gtm_ai_telemetry" ("organization_id", "tenant_id", "surface", "created_at");`);
    this.addSql(`create index "gtm_ai_telemetry_org_tenant_idx" on "gtm_ai_telemetry" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_ai_telemetry" add constraint "gtm_ai_telemetry_org_operation_unique" unique ("organization_id", "operation_key");`);

    this.addSql(`create table "gtm_mailbox_health" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "mailbox_connection_id" uuid not null, "policy_version" text not null default 'mailbox-health-v1', "status" text not null default 'healthy', "rolling_window_started_at" timestamptz not null, "accepted_count" int not null default 0, "delivered_count" int not null default 0, "soft_bounce_count" int not null default 0, "hard_bounce_count" int not null default 0, "complaint_count" int not null default 0, "pause_reason" text null, "pause_until" timestamptz null, "last_event_at" timestamptz null, "fence" int not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_mailbox_health_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_mailbox_health_org_tenant_idx" on "gtm_mailbox_health" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_mailbox_health" add constraint "gtm_mailbox_health_org_tenant_mailbox_unique" unique ("organization_id", "tenant_id", "mailbox_connection_id");`);
  }

}
