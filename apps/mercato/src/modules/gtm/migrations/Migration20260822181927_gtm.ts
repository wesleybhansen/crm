import { Migration } from '@mikro-orm/migrations';

export class Migration20260822181927_gtm extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "gtm_candidate_relations" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "workspace_id" uuid not null, "play_id" uuid not null, "research_run_id" uuid not null, "parent_match_id" uuid not null, "parent_candidate_id" uuid not null, "child_candidate_id" uuid not null, "provider_operation_id" uuid not null, "relationship_kind" text not null, "observed_title" text not null, "confidence" numeric(6,3) not null, "observed_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_candidate_relations_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_candidate_relations_org_tenant_child_idx" on "gtm_candidate_relations" ("organization_id", "tenant_id", "child_candidate_id");`);
    this.addSql(`create index "gtm_candidate_relations_org_tenant_parent_idx" on "gtm_candidate_relations" ("organization_id", "tenant_id", "parent_candidate_id");`);
    this.addSql(`create index "gtm_candidate_relations_org_tenant_run_idx" on "gtm_candidate_relations" ("organization_id", "tenant_id", "research_run_id");`);
    this.addSql(`create index "gtm_candidate_relations_org_tenant_idx" on "gtm_candidate_relations" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_candidate_relations" add constraint "gtm_candidate_relations_run_parent_child_kind_unique" unique ("research_run_id", "parent_candidate_id", "child_candidate_id", "relationship_kind");`);

    this.addSql(`alter table "gtm_candidate_relations" add constraint "gtm_candidate_relations_workspace_id_foreign" foreign key ("workspace_id") references "gtm_workspaces" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "gtm_candidate_relations" add constraint "gtm_candidate_relations_play_id_foreign" foreign key ("play_id") references "gtm_plays" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "gtm_candidate_relations" add constraint "gtm_candidate_relations_research_run_id_foreign" foreign key ("research_run_id") references "gtm_research_runs" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "gtm_candidate_relations" add constraint "gtm_candidate_relations_parent_match_id_foreign" foreign key ("parent_match_id") references "gtm_candidate_matches" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "gtm_candidate_relations" add constraint "gtm_candidate_relations_parent_candidate_id_foreign" foreign key ("parent_candidate_id") references "gtm_candidates" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "gtm_candidate_relations" add constraint "gtm_candidate_relations_child_candidate_id_foreign" foreign key ("child_candidate_id") references "gtm_candidates" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "gtm_candidate_relations" add constraint "gtm_candidate_relations_provider_operation_id_foreign" foreign key ("provider_operation_id") references "gtm_provider_operations" ("id") on update cascade on delete restrict;`);
  }

}
