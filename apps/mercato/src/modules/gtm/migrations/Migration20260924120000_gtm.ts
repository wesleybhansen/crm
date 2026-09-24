import { Migration } from '@mikro-orm/migrations';

// Post replies (2026-09-24): a drafted reply to a public post lead. The owner
// copies it (any platform) or approves it and Noli posts it (Threads only, from
// their connected account). One row per lead per workspace; see GtmPostReply.
// Applied by hand on the production box like every other GTM migration.
export class Migration20260924120000_gtm extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "gtm_post_replies" (
      "id" uuid not null default gen_random_uuid(),
      "organization_id" uuid not null,
      "tenant_id" uuid not null,
      "workspace_id" uuid not null references "gtm_workspaces" ("id") on delete cascade,
      "play_id" uuid not null references "gtm_plays" ("id") on delete cascade,
      "candidate_id" uuid not null references "gtm_candidates" ("id") on delete cascade,
      "platform" text not null,
      "provider_post_id" text null,
      "post_url" text not null,
      "body_text" text not null,
      "model" text null,
      "status" text not null default 'draft',
      "connection_id" uuid null,
      "reply_media_id" text null,
      "reply_url" text null,
      "failure_code" text null,
      "approved_by_user_id" uuid null,
      "posted_at" timestamptz null,
      "retention_expires_at" timestamptz not null,
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      "deleted_at" timestamptz null,
      constraint "gtm_post_replies_pkey" primary key ("id"),
      constraint "gtm_post_replies_status_check" check ("status" in ('draft','copied','posting','posted','failed','unknown','dismissed')),
      constraint "gtm_post_replies_body_length_check" check (char_length("body_text") between 1 and 500)
    );`);
    this.addSql(`create index if not exists "gtm_post_replies_org_tenant_idx" on "gtm_post_replies" ("organization_id", "tenant_id");`);
    this.addSql(`create index if not exists "gtm_post_replies_posted_idx" on "gtm_post_replies" ("organization_id", "tenant_id", "posted_at");`);
    this.addSql(`create unique index if not exists "gtm_post_replies_workspace_candidate_unique" on "gtm_post_replies" ("organization_id", "tenant_id", "workspace_id", "candidate_id");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "gtm_post_replies";`);
  }

}
