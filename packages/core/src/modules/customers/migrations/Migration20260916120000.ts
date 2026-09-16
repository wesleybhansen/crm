import { Migration } from '@mikro-orm/migrations';

/* Onboarding audit quick win (2026-09-16): seeded accounts skip the CRM's
 * 9-step wizard once the hub has filled the profile and pipeline. This
 * records which system finished onboarding on the customer's behalf so the
 * dashboard can show a short "we set this up from your Noli profile" banner
 * instead of the wizard. Also moves the persona default off the retired
 * "Scout" identity now that the CRM's assistant takes the same name the
 * customer gave their Chief of Staff in the hub. */
export class Migration20260916120000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`DO $$ BEGIN ALTER TABLE "business_profiles" ADD COLUMN "seeded_by" text null; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`);
    this.addSql(`ALTER TABLE "business_profiles" ALTER COLUMN "ai_persona_name" SET DEFAULT 'Noli';`);
  }

}
