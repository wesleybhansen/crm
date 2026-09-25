import { Migration } from '@mikro-orm/migrations'

/* The forms table (2026-09-25).
 *
 * The Forms feature (apps/mercato/src/modules/forms/**, the public form
 * pages, the AI-wizard Forms copy) reads and writes the raw-knex table
 * `forms`, but no migration ever created it: production has a hand-made copy,
 * and every fresh database (CI, new installs) answered 500 on form create.
 * TC-TENANT-001, which creates a form per customer, found it the first time it
 * actually ran.
 *
 * Columns, defaults and indexes match production (ops/backup/schema-snapshot.sql).
 * form_submissions.landing_page_id is relaxed by landing_pages
 * Migration20260926094500 (that module creates the table). The global slug index repeats
 * Migration20260924200000_forms, which skipped it when the table was missing.
 *
 * Self-contained (imports only @mikro-orm/migrations). Idempotent: every
 * statement is IF NOT EXISTS, so production (which has all of it) is unchanged. */
export class Migration20260926094000_forms extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE IF NOT EXISTS "forms" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "tenant_id" uuid NOT NULL,
      "organization_id" uuid NOT NULL,
      "name" text NOT NULL,
      "slug" text NOT NULL,
      "description" text NULL,
      "template_id" text NULL,
      "fields" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "theme" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "status" text NOT NULL DEFAULT 'draft',
      "owner_user_id" uuid NULL,
      "view_count" integer NOT NULL DEFAULT 0,
      "submission_count" integer NOT NULL DEFAULT 0,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      "published_at" timestamptz NULL,
      "deleted_at" timestamptz NULL,
      "is_active" boolean NOT NULL DEFAULT true
    );`)
    this.addSql(`ALTER TABLE "forms" ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true;`)
    this.addSql(`ALTER TABLE "forms" ADD COLUMN IF NOT EXISTS "template_id" text NULL;`)
    this.addSql(`ALTER TABLE "forms" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid NULL;`)
    this.addSql(`ALTER TABLE "forms" ADD COLUMN IF NOT EXISTS "published_at" timestamptz NULL;`)
    this.addSql(`ALTER TABLE "forms" ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz NULL;`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "forms_org_slug_idx" ON "forms" ("organization_id", "slug");`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "forms_org_status_idx" ON "forms" ("organization_id", "status");`)
    this.addSql(`DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'forms_slug_global_uniq') THEN
    IF EXISTS (SELECT 1 FROM "forms" GROUP BY slug HAVING count(*) > 1) THEN
      RAISE EXCEPTION 'Cannot add forms_slug_global_uniq: forms.slug has duplicates; resolve them (scripts/sql/public-slug-duplicates.sql) and re-run.';
    END IF;
    CREATE UNIQUE INDEX "forms_slug_global_uniq" ON "forms" ("slug");
  END IF;
END $$;`)
  }

  override async down(): Promise<void> {
    // Production data lives here; never dropped by a down migration.
  }
}
