import { Migration } from '@mikro-orm/migrations';

export class Migration20260614130000 extends Migration {

  override async up(): Promise<void> {
    // Customer Service feature (Phase 1). One row per org holds the recurring
    // drafting engine config. customer_service_settings is created here;
    // inbox_conversations gets a cs_drafted_at marker so the processor never
    // re-drafts the same inquiry. Idempotent: safe to re-run on the box.
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "customer_service_settings" (
        "id" uuid not null default gen_random_uuid(),
        "tenant_id" uuid not null,
        "organization_id" uuid not null,
        "enabled" boolean not null default false,
        "watched_connection_ids" jsonb null,
        "reply_mode" text not null default 'draft',
        "signature" text null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "customer_service_settings_pkey" primary key ("id")
      );
    `);
    this.addSql(`
      DO $$ BEGIN
        ALTER TABLE "customer_service_settings"
          ADD CONSTRAINT "customer_service_settings_organization_id_key" UNIQUE ("organization_id");
      EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;
    `);

    // cs_drafted_at marker on inbox_conversations (table is created at runtime,
    // not by a tracked migration, so guard against it not existing yet).
    this.addSql(`
      DO $$ BEGIN
        ALTER TABLE "inbox_conversations" ADD COLUMN "cs_drafted_at" timestamptz null;
      EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "customer_service_settings" cascade;`);
    this.addSql(`DO $$ BEGIN ALTER TABLE "inbox_conversations" DROP COLUMN "cs_drafted_at"; EXCEPTION WHEN undefined_column THEN NULL; WHEN undefined_table THEN NULL; END $$;`);
  }

}
