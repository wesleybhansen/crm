import { Migration } from '@mikro-orm/migrations';

/* Onboarding audit follow-up (2026-09-16): the dashboard's confirm-and-go
 * summary card (shown to seeded accounts in place of the old one-line
 * banner) dismisses server-side so it does not reappear on another device
 * or after cookies clear. This records when the member confirmed the
 * summary, alongside the existing seeded_by column from Migration20260916120000.
 */
export class Migration20260916130000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`DO $$ BEGIN ALTER TABLE "business_profiles" ADD COLUMN "seeded_reviewed_at" timestamptz null; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`);
  }

}
