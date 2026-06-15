import { Migration } from '@mikro-orm/migrations';

export class Migration20260615120000 extends Migration {

  override async up(): Promise<void> {
    // Customer Service feature (Phase 4): SMS as a support channel.
    // cs_sms_number holds the org's DEDICATED customer-service Twilio number
    // (E.164, e.g. +14155550123). It must be a DISTINCT number from any number
    // used by the unified Inbox: inbound SMS to this number is routed into the
    // Customer Service drafting flow, while inbound SMS to other connected
    // numbers keeps the existing inbox-only behavior. Nullable: orgs that do not
    // run SMS support leave it empty. Idempotent: safe to re-run on the box.
    this.addSql(`
      DO $$ BEGIN
        ALTER TABLE "customer_service_settings"
          ADD COLUMN "cs_sms_number" text null;
      EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DO $$ BEGIN ALTER TABLE "customer_service_settings" DROP COLUMN "cs_sms_number"; EXCEPTION WHEN undefined_column THEN NULL; WHEN undefined_table THEN NULL; END $$;`);
  }

}
