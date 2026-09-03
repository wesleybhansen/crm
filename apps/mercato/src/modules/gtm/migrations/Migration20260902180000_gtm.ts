import { Migration } from '@mikro-orm/migrations';

// Official social-platform OAuth connections (Threads keyword search).
// Applied by hand on the production box like every other GTM migration.
export class Migration20260902180000_gtm extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "gtm_social_connections" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "user_id" uuid not null, "provider" text not null, "provider_user_id" text not null, "username" text null, "display_name" text null, "access_token_sealed" text not null, "token_issued_at" timestamptz not null, "token_expires_at" timestamptz null, "last_refreshed_at" timestamptz null, "scopes" jsonb null, "status" text not null default 'active', "status_reason" text null, "query_window_started_at" timestamptz null, "queries_in_window" integer not null default 0, "last_used_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_social_connections_pkey" primary key ("id"));`);
    this.addSql(`create index if not exists "gtm_social_connections_org_tenant_provider_idx" on "gtm_social_connections" ("organization_id", "tenant_id", "provider");`);
    this.addSql(`do $$ begin if not exists (select 1 from pg_constraint where conname = 'gtm_social_connections_org_provider_user_unique') then alter table "gtm_social_connections" add constraint "gtm_social_connections_org_provider_user_unique" unique ("organization_id", "tenant_id", "provider", "provider_user_id"); end if; end $$;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "gtm_social_connections" cascade;`);
  }

}
