import { Migration } from '@mikro-orm/migrations';

export class Migration20260614120000 extends Migration {

  override async up(): Promise<void> {
    // Per-user KB key cache. Each noli-core member of a shared CRM org reads
    // their OWN Knowledge Base, so we cache the auto-provisioned KB key under a
    // { noliUserId: key } map instead of one org-level key. The legacy single
    // pkb_api_key column stays as the org-level manual-paste fallback.
    this.addSql(`DO $$ BEGIN ALTER TABLE "business_profiles" ADD COLUMN "pkb_api_keys" jsonb null; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`);
  }

}
