import { Migration } from '@mikro-orm/migrations';

export class Migration20260824081513_gtm extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "gtm_auto_refill_policies" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "workspace_id" uuid not null, "play_id" uuid not null, "campaign_id" uuid not null, "campaign_version_id" uuid not null, "represented_noli_user_id" uuid not null, "noli_organization_id" uuid not null, "requested_by_user_id" uuid not null, "status" text not null default 'pending_schedule', "policy_hash" text not null, "campaign_content_hash" text not null, "plan_hash" text not null, "target_accepted_per_day" int not null, "max_raw_candidates_per_day" int not null, "max_credits_per_day" int not null, "run_hour_local" int not null, "timezone" text not null, "scheduled_job_id" text not null, "fence" int not null default 0, "blocked_reason" text null, "last_cycle_local_date" text null, "last_cycle_at" timestamptz null, "last_success_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_auto_refill_policies_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_auto_refill_policies_org_tenant_status_idx" on "gtm_auto_refill_policies" ("organization_id", "tenant_id", "status");`);
    this.addSql(`create index "gtm_auto_refill_policies_org_tenant_idx" on "gtm_auto_refill_policies" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_auto_refill_policies" add constraint "gtm_auto_refill_policies_org_tenant_campaign_unique" unique ("organization_id", "tenant_id", "campaign_id");`);

    this.addSql(`create table "gtm_auto_refill_cycles" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "policy_id" uuid not null, "campaign_id" uuid not null, "campaign_version_id" uuid not null, "play_id" uuid not null, "research_run_id" uuid null, "local_date" text not null, "policy_hash" text not null, "campaign_content_hash" text not null, "plan_hash" text not null, "status" text not null default 'planned', "failure_code" text null, "result" jsonb null, "started_at" timestamptz null, "completed_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_auto_refill_cycles_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_auto_refill_cycles_policy_status_idx" on "gtm_auto_refill_cycles" ("policy_id", "status");`);
    this.addSql(`create index "gtm_auto_refill_cycles_org_tenant_idx" on "gtm_auto_refill_cycles" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_auto_refill_cycles" add constraint "gtm_auto_refill_cycles_policy_local_date_unique" unique ("policy_id", "local_date");`);

    this.addSql(`alter table "gtm_auto_refill_policies" add constraint "gtm_auto_refill_policies_workspace_id_foreign" foreign key ("workspace_id") references "gtm_workspaces" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_auto_refill_policies" add constraint "gtm_auto_refill_policies_play_id_foreign" foreign key ("play_id") references "gtm_plays" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_auto_refill_policies" add constraint "gtm_auto_refill_policies_campaign_id_foreign" foreign key ("campaign_id") references "gtm_campaigns" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_auto_refill_policies" add constraint "gtm_auto_refill_policies_campaign_version_id_foreign" foreign key ("campaign_version_id") references "gtm_campaign_versions" ("id") on update cascade;`);

    this.addSql(`alter table "gtm_auto_refill_cycles" add constraint "gtm_auto_refill_cycles_policy_id_foreign" foreign key ("policy_id") references "gtm_auto_refill_policies" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_auto_refill_cycles" add constraint "gtm_auto_refill_cycles_campaign_id_foreign" foreign key ("campaign_id") references "gtm_campaigns" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_auto_refill_cycles" add constraint "gtm_auto_refill_cycles_campaign_version_id_foreign" foreign key ("campaign_version_id") references "gtm_campaign_versions" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_auto_refill_cycles" add constraint "gtm_auto_refill_cycles_play_id_foreign" foreign key ("play_id") references "gtm_plays" ("id") on update cascade;`);
    this.addSql(`alter table "gtm_auto_refill_cycles" add constraint "gtm_auto_refill_cycles_research_run_id_foreign" foreign key ("research_run_id") references "gtm_research_runs" ("id") on update cascade on delete set null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "gtm_auto_refill_cycles" drop constraint if exists "gtm_auto_refill_cycles_policy_id_foreign";`);
  }

}
