import { Migration } from '@mikro-orm/migrations';

/**
 * Tier 0 of the SPEC-061 mercato rebuild — promotes the following tables out
 * of `setup-tables.sql` (raw-knex managed) into ORM-managed customers-module
 * entities:
 *
 *   tasks, contact_notes, contact_attachments, contact_engagement_scores,
 *   contact_open_times, engagement_events, reminders, task_templates,
 *   business_profiles
 *
 * Why this migration is hand-edited (not pure auto-generated):
 *
 * The auto-generated migration produced unconditional `CREATE TABLE` statements
 * because the local dev DB does not contain the legacy `setup-tables.sql`
 * schema. On production those 9 tables already exist (created by deploy.sh
 * applying setup-tables.sql), so a plain `CREATE TABLE` would fail with
 * "relation already exists".
 *
 * To work in BOTH environments — fresh greenfield dev DBs (where the tables
 * do not exist) and the existing prod DB (where they already exist with
 * slightly different schemas) — every statement is idempotent:
 *
 *   - `CREATE TABLE IF NOT EXISTS`        for the table itself
 *   - `CREATE INDEX IF NOT EXISTS`        for indexes
 *   - `ALTER TABLE ADD COLUMN IF NOT EXISTS` for the columns the entities add
 *     beyond what setup-tables.sql defines (deleted_at, tenant_id, etc.)
 *   - `ALTER TABLE ADD CONSTRAINT IF NOT EXISTS` (via DO block) for new uniques
 *
 * On greenfield: the CREATE TABLE creates the full schema with all entity
 * columns; the follow-up ALTER TABLE statements no-op because the columns
 * already exist (just created).
 *
 * On prod: the CREATE TABLE no-ops because the table already exists; the
 * follow-up ALTER TABLE statements add only the columns the entities require
 * that the legacy schema lacked.
 *
 * Schema additions (beyond what setup-tables.sql had):
 *   - tasks: + deleted_at
 *   - contact_notes: + deleted_at
 *   - contact_attachments: + updated_at, + deleted_at
 *   - contact_engagement_scores: + created_at
 *   - engagement_events: + tenant_id (multi-tenant safety fix)
 *   - contact_open_times: + tenant_id (multi-tenant safety fix)
 *   - reminders: + updated_at, + deleted_at
 *   - task_templates: + deleted_at
 *   - business_profiles: no schema changes (kept as-is, ~29 columns)
 *
 * The 2 tenant_id additions are NOT NULL on entity definition. Verified all
 * 9 prod tables had 0 rows before this migration was authored, so adding
 * NOT NULL columns without a backfill is safe. If you ever run this migration
 * against a non-empty database, the tenant_id ALTERs will fail — that is the
 * desired safety behavior.
 */
export class Migration20260409154143 extends Migration {

  override async up(): Promise<void> {
    // ----- business_profiles -----
    this.addSql(`create table if not exists "business_profiles" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "business_name" text null, "business_type" text null, "business_description" text null, "main_offer" text null, "ideal_clients" text null, "team_size" text null, "client_sources" jsonb null, "pipeline_stages" jsonb null, "ai_persona_name" text null default 'Scout', "ai_persona_style" text null default 'professional', "ai_custom_instructions" text null, "website_url" text null, "brand_colors" jsonb null, "social_links" jsonb null, "detected_services" jsonb null, "pipeline_mode" text null default 'deals', "digest_frequency" text null default 'weekly', "digest_day" int null default 1, "email_intake_mode" text null default 'suggest', "interface_mode" text null default 'simple', "onboarding_complete" boolean null default false, "brand_voice_profile" jsonb null, "brand_voice_updated_at" timestamptz null, "brand_voice_source" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), constraint "business_profiles_pkey" primary key ("id"));`);
    this.addSql(`do $$ begin if not exists (select 1 from pg_constraint where conname = 'business_profiles_organization_id_key') then alter table "business_profiles" add constraint "business_profiles_organization_id_key" unique ("organization_id"); end if; end $$;`);

    // ----- contact_attachments -----
    this.addSql(`create table if not exists "contact_attachments" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "contact_id" uuid not null, "filename" text not null, "file_url" text not null, "file_size" int not null default 0, "mime_type" text null, "uploaded_by" uuid null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "contact_attachments_pkey" primary key ("id"));`);
    this.addSql(`alter table "contact_attachments" add column if not exists "updated_at" timestamptz not null default now();`);
    this.addSql(`alter table "contact_attachments" add column if not exists "deleted_at" timestamptz null;`);
    this.addSql(`create index if not exists "attachments_contact_idx" on "contact_attachments" ("contact_id", "created_at" desc);`);

    // ----- contact_engagement_scores -----
    this.addSql(`create table if not exists "contact_engagement_scores" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "contact_id" uuid not null, "score" int not null default 0, "last_activity_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), constraint "contact_engagement_scores_pkey" primary key ("id"));`);
    this.addSql(`alter table "contact_engagement_scores" add column if not exists "created_at" timestamptz not null default now();`);
    this.addSql(`create index if not exists "engagement_scores_org_score_idx" on "contact_engagement_scores" ("organization_id", "score" desc);`);
    this.addSql(`do $$ begin if not exists (select 1 from pg_constraint where conname = 'engagement_scores_contact_idx') and not exists (select 1 from pg_indexes where indexname = 'engagement_scores_contact_idx') then alter table "contact_engagement_scores" add constraint "engagement_scores_contact_idx" unique ("contact_id"); end if; end $$;`);

    // ----- contact_notes -----
    this.addSql(`create table if not exists "contact_notes" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "contact_id" uuid not null, "content" text not null, "author_user_id" uuid null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "contact_notes_pkey" primary key ("id"));`);
    this.addSql(`alter table "contact_notes" add column if not exists "deleted_at" timestamptz null;`);
    this.addSql(`create index if not exists "contact_notes_contact_idx" on "contact_notes" ("contact_id", "created_at");`);

    // ----- contact_open_times -----
    // Adds tenant_id (was missing — multi-tenant safety fix). Safe because the
    // legacy table is empty on prod; would fail loudly on a populated table.
    this.addSql(`create table if not exists "contact_open_times" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "contact_id" uuid not null, "organization_id" uuid not null, "hour_of_day" int not null, "day_of_week" int not null, "opened_at" timestamptz not null, "created_at" timestamptz not null default now(), constraint "contact_open_times_pkey" primary key ("id"));`);
    this.addSql(`alter table "contact_open_times" add column if not exists "tenant_id" uuid not null;`);
    this.addSql(`create index if not exists "open_times_contact_idx" on "contact_open_times" ("contact_id");`);

    // ----- engagement_events -----
    // Adds tenant_id (was missing — multi-tenant safety fix).
    this.addSql(`create table if not exists "engagement_events" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "contact_id" uuid not null, "organization_id" uuid not null, "event_type" text not null, "points" int not null, "metadata" jsonb null, "created_at" timestamptz not null default now(), constraint "engagement_events_pkey" primary key ("id"));`);
    this.addSql(`alter table "engagement_events" add column if not exists "tenant_id" uuid not null;`);
    this.addSql(`create index if not exists "engagement_events_contact_idx" on "engagement_events" ("contact_id", "created_at" desc);`);

    // ----- reminders -----
    this.addSql(`create table if not exists "reminders" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "user_id" uuid not null, "entity_type" text not null, "entity_id" uuid not null, "message" text not null, "remind_at" timestamptz not null, "sent" boolean not null default false, "sent_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "reminders_pkey" primary key ("id"));`);
    this.addSql(`alter table "reminders" add column if not exists "updated_at" timestamptz not null default now();`);
    this.addSql(`alter table "reminders" add column if not exists "deleted_at" timestamptz null;`);
    this.addSql(`create index if not exists "reminders_org_idx" on "reminders" ("organization_id", "user_id");`);
    this.addSql(`create index if not exists "reminders_due_idx" on "reminders" ("remind_at", "sent") where sent = false;`);

    // ----- tasks -----
    this.addSql(`create table if not exists "tasks" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "title" text not null, "description" text null, "contact_id" uuid null, "deal_id" uuid null, "due_date" timestamptz null, "is_done" boolean not null default false, "completed_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "tasks_pkey" primary key ("id"));`);
    this.addSql(`alter table "tasks" add column if not exists "deleted_at" timestamptz null;`);
    this.addSql(`create index if not exists "tasks_org_done_idx" on "tasks" ("organization_id", "is_done", "due_date");`);

    // ----- task_templates -----
    this.addSql(`create table if not exists "task_templates" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "name" text not null, "description" text null, "trigger_type" text not null default 'manual', "trigger_config" jsonb null, "tasks" jsonb not null default '[]', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "task_templates_pkey" primary key ("id"));`);
    this.addSql(`alter table "task_templates" add column if not exists "deleted_at" timestamptz null;`);
    this.addSql(`create index if not exists "task_templates_org_idx" on "task_templates" ("organization_id");`);
  }

}
