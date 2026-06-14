import { Migration } from '@mikro-orm/migrations';

export class Migration20260614140000 extends Migration {

  override async up(): Promise<void> {
    // Customer Service feature (Phase 2): grounding library. MANY rows per org.
    // Each row is a user-supplied model answer or reference document the shared
    // reply drafter injects into the prompt. Idempotent: safe to re-run on the box.
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "customer_service_knowledge" (
        "id" uuid not null default gen_random_uuid(),
        "tenant_id" uuid not null,
        "organization_id" uuid not null,
        "kind" text not null,
        "title" text not null,
        "content" text not null,
        "source_filename" text null,
        "is_active" boolean not null default true,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "customer_service_knowledge_pkey" primary key ("id")
      );
    `);
    this.addSql(`
      CREATE INDEX IF NOT EXISTS "customer_service_knowledge_org_active_idx"
        ON "customer_service_knowledge" ("organization_id", "is_active");
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "customer_service_knowledge" cascade;`);
  }

}
