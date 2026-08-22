import { Migration } from '@mikro-orm/migrations';

export class Migration20260822155644_gtm extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "gtm_candidate_matches" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "workspace_id" uuid not null, "play_id" uuid not null, "research_run_id" uuid not null, "candidate_id" uuid not null, "provider_operation_id" uuid null, "fit_status" text not null default 'unscored', "fit_score" numeric(6,3) null, "reject_reason" text null, "quality_status" text null, "quality_score" numeric(6,3) null, "qualification" jsonb null, "qualification_version" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_candidate_matches_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_candidate_matches_org_tenant_candidate_idx" on "gtm_candidate_matches" ("organization_id", "tenant_id", "candidate_id");`);
    this.addSql(`create index "gtm_candidate_matches_org_tenant_play_idx" on "gtm_candidate_matches" ("organization_id", "tenant_id", "play_id");`);
    this.addSql(`create index "gtm_candidate_matches_org_tenant_run_idx" on "gtm_candidate_matches" ("organization_id", "tenant_id", "research_run_id");`);
    this.addSql(`create index "gtm_candidate_matches_org_tenant_idx" on "gtm_candidate_matches" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_candidate_matches" add constraint "gtm_candidate_matches_run_candidate_unique" unique ("research_run_id", "candidate_id");`);

    this.addSql(`alter table "gtm_candidate_matches" add constraint "gtm_candidate_matches_workspace_id_foreign" foreign key ("workspace_id") references "gtm_workspaces" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "gtm_candidate_matches" add constraint "gtm_candidate_matches_play_id_foreign" foreign key ("play_id") references "gtm_plays" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "gtm_candidate_matches" add constraint "gtm_candidate_matches_research_run_id_foreign" foreign key ("research_run_id") references "gtm_research_runs" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "gtm_candidate_matches" add constraint "gtm_candidate_matches_candidate_id_foreign" foreign key ("candidate_id") references "gtm_candidates" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "gtm_candidate_matches" add constraint "gtm_candidate_matches_provider_operation_id_foreign" foreign key ("provider_operation_id") references "gtm_provider_operations" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "gtm_evidence" add column "research_run_id" uuid null;`);
    this.addSql(`alter table "gtm_evidence" add constraint "gtm_evidence_research_run_id_foreign" foreign key ("research_run_id") references "gtm_research_runs" ("id") on update cascade on delete set null;`);
    this.addSql(`create index "gtm_evidence_org_tenant_run_idx" on "gtm_evidence" ("organization_id", "tenant_id", "research_run_id");`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "gtm_evidence" drop constraint if exists "gtm_evidence_research_run_id_foreign";`);

    this.addSql(`drop index "gtm_evidence_org_tenant_run_idx";`);
    this.addSql(`alter table "gtm_evidence" drop column "research_run_id";`);
  }

}
