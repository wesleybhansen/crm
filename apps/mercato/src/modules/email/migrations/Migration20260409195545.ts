import { Migration } from '@mikro-orm/migrations';

/**
 * Tier 1 of the SPEC-061 mercato rebuild — promotes the following tables out
 * of the legacy raw-knex world (currently defined in setup-tables.sql) into
 * ORM-managed entities under the email module:
 *
 *   email_preference_categories, email_preferences, email_style_templates,
 *   email_connections, esp_connections, esp_sender_addresses, email_lists,
 *   email_list_members, email_routing, email_intelligence_settings
 *
 * Plus schema fixes for already-managed tables:
 *   - email_messages: + sentiment, + updated_at, + deleted_at
 *   - email_campaigns: + category, + scheduled_for, + updated_at
 *   - email_campaign_recipients: + tenant_id, + organization_id, + created_at,
 *     + updated_at, + deleted_at  (multi-tenant safety fix)
 *
 * Why this migration is hand-edited (not pure auto-generated):
 *
 * Same reason as the tier 0 migration. The auto-generated migration produced
 * unconditional `CREATE TABLE` statements because mikro-orm's snapshot didn't
 * know about these tables. On production those 10 new tables already exist
 * (created by setup-tables.sql at deploy time, except email_intelligence_settings
 * which was lazy-created by /api/email-intelligence/settings/route.ts on first
 * GET), so a plain `CREATE TABLE` would fail with "relation already exists".
 *
 * Every statement is idempotent:
 *
 *   - `CREATE TABLE IF NOT EXISTS`        for the table itself
 *   - `CREATE INDEX IF NOT EXISTS`        for indexes
 *   - `ALTER TABLE ADD COLUMN IF NOT EXISTS` for the columns the entities add
 *     beyond what setup-tables.sql defines (deleted_at, tenant_id, etc.)
 *
 * On greenfield: the CREATE TABLE creates the full schema with all entity
 * columns; the follow-up ALTER TABLE statements no-op because the columns
 * already exist (just created).
 *
 * On prod: the CREATE TABLE no-ops because the table already exists; the
 * follow-up ALTER TABLE statements add only the columns the entities require
 * that the legacy schema lacked.
 *
 * Schema additions vs current prod state (verified column-by-column via
 * `\d <table>` against the live DB):
 *   - email_campaigns: + category, + scheduled_for, + updated_at (these
 *     are already on prod via earlier ALTERs but the entity didn't know
 *     about them — IF NOT EXISTS no-ops)
 *   - email_campaign_recipients: + tenant_id, + organization_id,
 *     + created_at, + updated_at, + deleted_at (multi-tenant safety fix —
 *     prod table is empty so NOT NULL adds are safe)
 *   - email_messages: + sentiment (already on prod), + updated_at,
 *     + deleted_at
 *   - email_preferences: + tenant_id, + created_at, + deleted_at
 *     (multi-tenant safety fix — prod table is empty)
 *   - email_list_members: + tenant_id, + organization_id, + created_at,
 *     + updated_at, + deleted_at (multi-tenant safety fix — prod table
 *     is empty)
 *
 * The 2 NOT NULL `tenant_id` and `organization_id` adds are safe because
 * verified prod row counts are 0 for both email_campaign_recipients and
 * email_list_members. If you ever run this migration against a non-empty
 * version of those tables, the NOT NULL ALTERs will fail loudly — that
 * is the desired safety behavior.
 *
 * The down() migration is intentionally minimal — it does NOT drop the
 * 10 new tables because some predate this migration (created by
 * setup-tables.sql / lazy ENSURE_TABLE) and would lose pre-tier-1 data
 * if rolled back. Use the labeled checkpoint backup for recovery instead.
 */
export class Migration20260409195545 extends Migration {

  override async up(): Promise<void> {
    // ----- email_connections -----
    this.addSql(`create table if not exists "email_connections" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "user_id" uuid not null, "provider" text not null, "email_address" text not null, "access_token" text null, "refresh_token" text null, "token_expiry" timestamptz null, "smtp_host" text null, "smtp_port" int null, "smtp_user" text null, "smtp_pass" text null, "is_primary" boolean not null default false, "is_active" boolean not null default true, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "email_connections_pkey" primary key ("id"));`);
    this.addSql(`alter table "email_connections" add column if not exists "deleted_at" timestamptz null;`);
    this.addSql(`do $$ begin if not exists (select 1 from pg_indexes where indexname = 'email_conn_org_user_provider_idx') then create unique index "email_conn_org_user_provider_idx" on "email_connections" ("organization_id", "user_id", "provider"); end if; end $$;`);

    // ----- email_intelligence_settings -----
    // This table was previously lazy-created by /api/email-intelligence/settings/route.ts
    // ENSURE_TABLE block (race condition on cron). Now ORM-managed; the lazy
    // block can be deleted in tier 1 cutover Chunk C.
    this.addSql(`create table if not exists "email_intelligence_settings" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "user_id" uuid not null, "is_enabled" boolean not null default false, "auto_create_contacts" boolean not null default true, "auto_update_timeline" boolean not null default true, "auto_update_engagement" boolean not null default true, "auto_advance_stage" boolean not null default true, "last_gmail_history_id" text null, "last_outlook_delta_link" text null, "last_sync_at" timestamptz null, "last_sync_status" text null, "last_sync_error" text null, "emails_processed_total" int not null default 0, "contacts_created_total" int not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), constraint "email_intelligence_settings_pkey" primary key ("id"));`);
    this.addSql(`do $$ begin if not exists (select 1 from pg_constraint where conname = 'email_intelligence_settings_organization_id_user_id_key') then alter table "email_intelligence_settings" add constraint "email_intelligence_settings_organization_id_user_id_key" unique ("organization_id", "user_id"); end if; end $$;`);

    // ----- email_lists -----
    this.addSql(`create table if not exists "email_lists" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "name" text not null, "description" text null, "source_type" text not null default 'manual', "source_id" uuid null, "member_count" int not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz null, "deleted_at" timestamptz null, constraint "email_lists_pkey" primary key ("id"));`);
    this.addSql(`alter table "email_lists" add column if not exists "deleted_at" timestamptz null;`);
    this.addSql(`create index if not exists "email_lists_org_idx" on "email_lists" ("organization_id");`);

    // ----- email_list_members -----
    // Adds tenant_id, organization_id, created_at, updated_at, deleted_at
    // (multi-tenant safety fix). Safe because verified prod table is empty.
    this.addSql(`create table if not exists "email_list_members" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "list_id" uuid not null references "email_lists"("id") on delete cascade, "contact_id" uuid not null, "added_at" timestamptz not null default now(), "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "email_list_members_pkey" primary key ("id"));`);
    this.addSql(`alter table "email_list_members" add column if not exists "tenant_id" uuid not null;`);
    this.addSql(`alter table "email_list_members" add column if not exists "organization_id" uuid not null;`);
    this.addSql(`alter table "email_list_members" add column if not exists "created_at" timestamptz not null default now();`);
    this.addSql(`alter table "email_list_members" add column if not exists "updated_at" timestamptz not null default now();`);
    this.addSql(`alter table "email_list_members" add column if not exists "deleted_at" timestamptz null;`);
    this.addSql(`create index if not exists "email_list_members_list_idx" on "email_list_members" ("list_id");`);

    // ----- email_preferences -----
    // Adds tenant_id (multi-tenant safety fix), created_at, deleted_at.
    // Safe because verified prod table is empty.
    this.addSql(`create table if not exists "email_preferences" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "contact_id" uuid not null, "category_slug" text not null, "opted_in" boolean not null default true, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "email_preferences_pkey" primary key ("id"));`);
    this.addSql(`alter table "email_preferences" add column if not exists "tenant_id" uuid not null;`);
    this.addSql(`alter table "email_preferences" add column if not exists "created_at" timestamptz not null default now();`);
    this.addSql(`alter table "email_preferences" add column if not exists "deleted_at" timestamptz null;`);
    this.addSql(`do $$ begin if not exists (select 1 from pg_indexes where indexname = 'email_pref_contact_cat_idx') then create unique index "email_pref_contact_cat_idx" on "email_preferences" ("contact_id", "organization_id", "category_slug"); end if; end $$;`);

    // ----- email_preference_categories -----
    this.addSql(`create table if not exists "email_preference_categories" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "name" text not null, "slug" text not null, "description" text null, "is_default" boolean not null default false, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "email_preference_categories_pkey" primary key ("id"));`);
    this.addSql(`alter table "email_preference_categories" add column if not exists "updated_at" timestamptz not null default now();`);
    this.addSql(`alter table "email_preference_categories" add column if not exists "deleted_at" timestamptz null;`);
    this.addSql(`do $$ begin if not exists (select 1 from pg_indexes where indexname = 'pref_cat_org_slug_idx') then create unique index "pref_cat_org_slug_idx" on "email_preference_categories" ("organization_id", "slug"); end if; end $$;`);

    // ----- email_routing -----
    this.addSql(`create table if not exists "email_routing" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "purpose" text not null, "provider_type" text not null, "provider_id" uuid not null, "from_name" text null, "from_address" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "email_routing_pkey" primary key ("id"));`);
    this.addSql(`alter table "email_routing" add column if not exists "deleted_at" timestamptz null;`);
    this.addSql(`do $$ begin if not exists (select 1 from pg_indexes where indexname = 'email_routing_org_purpose_idx') then create unique index "email_routing_org_purpose_idx" on "email_routing" ("organization_id", "purpose"); end if; end $$;`);

    // ----- email_style_templates -----
    this.addSql(`create table if not exists "email_style_templates" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "name" text not null, "category" text not null default 'general', "html_template" text not null, "thumbnail_url" text null, "is_default" boolean not null default false, "created_by" uuid null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "email_style_templates_pkey" primary key ("id"));`);
    this.addSql(`alter table "email_style_templates" add column if not exists "deleted_at" timestamptz null;`);
    this.addSql(`create index if not exists "email_templates_org_idx" on "email_style_templates" ("organization_id", "category");`);

    // ----- esp_connections -----
    this.addSql(`create table if not exists "esp_connections" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "provider" text not null, "api_key" text not null, "sending_domain" text null, "default_sender_email" text null, "default_sender_name" text null, "is_active" boolean not null default true, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "esp_connections_pkey" primary key ("id"));`);
    this.addSql(`alter table "esp_connections" add column if not exists "deleted_at" timestamptz null;`);
    this.addSql(`do $$ begin if not exists (select 1 from pg_indexes where indexname = 'esp_conn_org_provider_idx') then create unique index "esp_conn_org_provider_idx" on "esp_connections" ("organization_id", "provider"); end if; end $$;`);

    // ----- esp_sender_addresses -----
    this.addSql(`create table if not exists "esp_sender_addresses" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "esp_connection_id" uuid not null, "sender_name" text null, "sender_email" text not null, "is_default" boolean not null default false, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "esp_sender_addresses_pkey" primary key ("id"));`);
    this.addSql(`alter table "esp_sender_addresses" add column if not exists "updated_at" timestamptz not null default now();`);
    this.addSql(`alter table "esp_sender_addresses" add column if not exists "deleted_at" timestamptz null;`);
    this.addSql(`do $$ begin if not exists (select 1 from pg_indexes where indexname = 'esp_sender_addr_org_email_idx') then create unique index "esp_sender_addr_org_email_idx" on "esp_sender_addresses" ("organization_id", "sender_email"); end if; end $$;`);

    // ----- email_campaigns: schema additions -----
    // category, scheduled_for, and updated_at all already exist on prod
    // (added via earlier ALTERs the entity didn't know about). IF NOT EXISTS
    // makes these no-ops. Greenfield will get them via the ALTER on the
    // table that the existing tier 0 / pre-tier-1 migrations created.
    this.addSql(`alter table "email_campaigns" add column if not exists "category" text null;`);
    this.addSql(`alter table "email_campaigns" add column if not exists "scheduled_for" timestamptz null;`);
    this.addSql(`alter table "email_campaigns" add column if not exists "updated_at" timestamptz null;`);

    // ----- email_campaign_recipients: multi-tenant safety fix -----
    // tenant_id and organization_id NOT NULL adds are safe because verified
    // prod row count is 0. created_at, updated_at have defaults so they
    // would also work on a populated table.
    this.addSql(`alter table "email_campaign_recipients" add column if not exists "tenant_id" uuid not null;`);
    this.addSql(`alter table "email_campaign_recipients" add column if not exists "organization_id" uuid not null;`);
    this.addSql(`alter table "email_campaign_recipients" add column if not exists "created_at" timestamptz not null default now();`);
    this.addSql(`alter table "email_campaign_recipients" add column if not exists "updated_at" timestamptz not null default now();`);
    this.addSql(`alter table "email_campaign_recipients" add column if not exists "deleted_at" timestamptz null;`);

    // ----- email_messages: schema additions -----
    // sentiment already exists on prod, IF NOT EXISTS no-ops it.
    this.addSql(`alter table "email_messages" add column if not exists "sentiment" text null;`);
    this.addSql(`alter table "email_messages" add column if not exists "updated_at" timestamptz not null default now();`);
    this.addSql(`alter table "email_messages" add column if not exists "deleted_at" timestamptz null;`);
  }

  override async down(): Promise<void> {
    // Minimal down(): only revert the column ADDs to existing tables. The
    // CREATE TABLE IF NOT EXISTS calls don't get reverted because some of
    // those tables predate this migration (created by setup-tables.sql or
    // lazy ENSURE_TABLE) and dropping them would lose pre-tier-1 data.
    // Use the labeled checkpoint backup for full recovery.
    this.addSql(`alter table "email_campaigns" drop column if exists "category", drop column if exists "scheduled_for", drop column if exists "updated_at";`);
    this.addSql(`alter table "email_campaign_recipients" drop column if exists "tenant_id", drop column if exists "organization_id", drop column if exists "created_at", drop column if exists "updated_at", drop column if exists "deleted_at";`);
    this.addSql(`alter table "email_messages" drop column if exists "sentiment", drop column if exists "updated_at", drop column if exists "deleted_at";`);
  }

}
