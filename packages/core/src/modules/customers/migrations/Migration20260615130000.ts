import { Migration } from '@mikro-orm/migrations';

export class Migration20260615130000 extends Migration {

  override async up(): Promise<void> {
    // Customer Service feature: configurable "flag scenarios". flag_scenarios is
    // a jsonb array of { key, label, enabled, action: 'pause'|'auto_send',
    // instructions }. When an inbound support message matches an enabled
    // scenario the reply is drafted using that scenario's instructions, the
    // proposal is flagged, the action is applied (pause = always queue for
    // review, even in auto mode; auto_send = send the draft), and the org user
    // is emailed an alert. Nullable: when null the settings GET seeds a default
    // scenario set so the UI renders the list. Idempotent: safe to re-run.
    this.addSql(`
      DO $$ BEGIN
        ALTER TABLE "customer_service_settings"
          ADD COLUMN "flag_scenarios" jsonb null;
      EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DO $$ BEGIN ALTER TABLE "customer_service_settings" DROP COLUMN "flag_scenarios"; EXCEPTION WHEN undefined_column THEN NULL; WHEN undefined_table THEN NULL; END $$;`);
  }

}
