import { Migration } from '@mikro-orm/migrations';

export class Migration20260421050000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE IF NOT EXISTS "assistant_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "title" text NOT NULL DEFAULT 'New conversation',
  "messages" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "is_archived" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "assistant_conversations_user_org_idx" ON "assistant_conversations" ("user_id", "organization_id", "updated_at" DESC);`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "assistant_conversations_tenant_idx" ON "assistant_conversations" ("tenant_id");`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "assistant_conversations";`);
  }

}
