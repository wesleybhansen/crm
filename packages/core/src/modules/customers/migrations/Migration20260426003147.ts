import { Migration } from '@mikro-orm/migrations';

export class Migration20260426003147 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "customer_pipeline_automation_rules" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "name" text not null, "trigger_key" text not null, "filters" jsonb not null default '{}', "target_entity" text not null, "target_pipeline_id" uuid null, "target_stage_id" uuid null, "target_lifecycle_stage" text null, "target_action" text not null, "allow_backward" boolean not null default false, "is_active" boolean not null default true, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, constraint "customer_pipeline_automation_rules_pkey" primary key ("id"));`);
    this.addSql(`create index "customer_pipeline_automation_rules_trigger_active_idx" on "customer_pipeline_automation_rules" ("trigger_key") where is_active = true and deleted_at is null;`);
    this.addSql(`create index "customer_pipeline_automation_rules_org_tenant_idx" on "customer_pipeline_automation_rules" ("organization_id", "tenant_id");`);

    this.addSql(`create table "customer_pipeline_automation_runs" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "rule_id" uuid not null, "trigger_event_id" text not null, "trigger_event_key" text not null, "entity_type" text not null, "entity_id" uuid not null, "from_stage" text null, "to_stage" text null, "outcome" text not null, "error" text null, "ran_at" timestamptz not null, constraint "customer_pipeline_automation_runs_pkey" primary key ("id"));`);
    this.addSql(`create index "customer_pipeline_automation_runs_entity_idx" on "customer_pipeline_automation_runs" ("entity_type", "entity_id", "ran_at");`);
    this.addSql(`create index "customer_pipeline_automation_runs_idempotency_idx" on "customer_pipeline_automation_runs" ("rule_id", "entity_id", "trigger_event_id");`);
    this.addSql(`create index "customer_pipeline_automation_runs_org_tenant_idx" on "customer_pipeline_automation_runs" ("organization_id", "tenant_id");`);
  }

}
