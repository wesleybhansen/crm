import { Migration } from '@mikro-orm/migrations';

export class Migration20260614000000 extends Migration {

  override async up(): Promise<void> {
    // Opt-in flags for the ambient AI crons (default on, mirroring digest).
    this.addSql(`DO $$ BEGIN ALTER TABLE "business_profiles" ADD COLUMN "meeting_prep_enabled" boolean null default true; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`);
    this.addSql(`DO $$ BEGIN ALTER TABLE "business_profiles" ADD COLUMN "decay_alerts_enabled" boolean null default true; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`);
    // Idempotency marker for the meeting-prep owner email (set once emailed).
    this.addSql(`DO $$ BEGIN ALTER TABLE "meeting_prep_briefs" ADD COLUMN "emailed_at" timestamptz null; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`);
  }

}
