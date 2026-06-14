import { Migration } from '@mikro-orm/migrations';

export class Migration20260614150000 extends Migration {

  override async up(): Promise<void> {
    // Customer Service feature (Phase 3): reply modes. reply_mode now accepts
    // 'draft' | 'auto' | 'hybrid'. hybrid mode auto-sends a draft only when its
    // confidence is >= hybrid_confidence_threshold AND the drafter flagged it as
    // auto-send-safe. Add the threshold column. Idempotent: safe to re-run.
    this.addSql(`
      DO $$ BEGIN
        ALTER TABLE "customer_service_settings"
          ADD COLUMN "hybrid_confidence_threshold" numeric not null default 0.8;
      EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DO $$ BEGIN ALTER TABLE "customer_service_settings" DROP COLUMN "hybrid_confidence_threshold"; EXCEPTION WHEN undefined_column THEN NULL; WHEN undefined_table THEN NULL; END $$;`);
  }

}
