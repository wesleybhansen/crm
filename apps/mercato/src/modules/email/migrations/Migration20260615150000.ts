import { Migration } from '@mikro-orm/migrations';

// Personal Inbox AI desk grounding library. MANY rows per org. Each row is a
// user-supplied model answer, an uploaded reference document, or an ingested web
// page that a later reply-drafting phase will draw on. This mirrors the Customer
// Service grounding table (customer_service_knowledge) but is scoped to the
// personal Inbox, so the two libraries stay distinct.
//
// kind is one of 'model_answer' | 'document' | 'web_page'. source_url holds the
// original page address for web_page entries (null otherwise). This is the
// STORAGE phase only: nothing reads these rows to draft replies yet.
//
// Idempotent: CREATE TABLE / INDEX IF NOT EXISTS so it is safe to re-run.
export class Migration20260615150000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "inbox_knowledge" (
        "id" uuid not null default gen_random_uuid(),
        "tenant_id" uuid not null,
        "organization_id" uuid not null,
        "kind" text not null,
        "title" text not null,
        "content" text not null,
        "source_url" text null,
        "is_active" boolean not null default true,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "inbox_knowledge_pkey" primary key ("id")
      );
    `);
    this.addSql(`
      CREATE INDEX IF NOT EXISTS "inbox_knowledge_org_active_idx"
        ON "inbox_knowledge" ("organization_id", "is_active");
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "inbox_knowledge" cascade;`);
  }

}
