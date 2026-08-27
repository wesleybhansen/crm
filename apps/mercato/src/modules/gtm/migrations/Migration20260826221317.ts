import { Migration } from '@mikro-orm/migrations';

export class Migration20260826221317 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "gtm_manual_outreach_drafts" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "workspace_id" uuid not null, "play_id" uuid not null, "candidate_id" uuid not null, "match_id" uuid not null, "channel" text not null, "destination_url" text not null, "body_text" text not null, "content_hash" text not null, "evidence_hash" text not null, "model" text null, "provenance" jsonb null, "idempotency_key_hash" text not null, "status" text not null default 'draft', "copied_at" timestamptz null, "opened_at" timestamptz null, "dismissed_at" timestamptz null, "retention_expires_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_manual_outreach_drafts_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_manual_outreach_drafts_scope_idx" on "gtm_manual_outreach_drafts" ("organization_id", "tenant_id", "workspace_id", "play_id", "candidate_id");`);
    this.addSql(`create index "gtm_manual_outreach_drafts_org_tenant_idx" on "gtm_manual_outreach_drafts" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_manual_outreach_drafts" add constraint "gtm_manual_outreach_drafts_org_idempotency_unique" unique ("organization_id", "tenant_id", "idempotency_key_hash");`);

    this.addSql(`alter table "gtm_manual_outreach_drafts" add constraint "gtm_manual_outreach_drafts_workspace_id_foreign" foreign key ("workspace_id") references "gtm_workspaces" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "gtm_manual_outreach_drafts" add constraint "gtm_manual_outreach_drafts_play_id_foreign" foreign key ("play_id") references "gtm_plays" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "gtm_manual_outreach_drafts" add constraint "gtm_manual_outreach_drafts_candidate_id_foreign" foreign key ("candidate_id") references "gtm_candidates" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "gtm_manual_outreach_drafts" add constraint "gtm_manual_outreach_drafts_match_id_foreign" foreign key ("match_id") references "gtm_candidate_matches" ("id") on update cascade on delete cascade;`);

    this.addSql(`alter table "gtm_plays" add column "lead_mode" text null, add column "research_eligibility" text null, add column "research_eligibility_reason" text null, add column "outreach_mode" text null, add column "outreach_policy_reason" text null, add column "policy_flags" jsonb null, add column "policy_evaluated_at" timestamptz null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "gtm_plays" drop column "lead_mode", drop column "research_eligibility", drop column "research_eligibility_reason", drop column "outreach_mode", drop column "outreach_policy_reason", drop column "policy_flags", drop column "policy_evaluated_at";`);
  }

}
