import { Migration } from '@mikro-orm/migrations';

export class Migration20260614160000 extends Migration {

  override async up(): Promise<void> {
    // Customer Service feature (Phase 3b): per-source (per-mailbox) reply modes.
    // source_modes is a jsonb map keyed by email_connection id, e.g.
    //   { "<connectionId>": { "mode": "draft"|"auto"|"hybrid", "threshold": 0.8 } }
    // It overrides the global reply_mode / hybrid_confidence_threshold for that
    // specific watched mailbox. Sources without an entry fall back to the global
    // default. Idempotent: safe to re-run on the box.
    this.addSql(`
      DO $$ BEGIN
        ALTER TABLE "customer_service_settings"
          ADD COLUMN "source_modes" jsonb null;
      EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DO $$ BEGIN ALTER TABLE "customer_service_settings" DROP COLUMN "source_modes"; EXCEPTION WHEN undefined_column THEN NULL; WHEN undefined_table THEN NULL; END $$;`);
  }

}
