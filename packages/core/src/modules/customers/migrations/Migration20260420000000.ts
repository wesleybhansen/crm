import { Migration } from '@mikro-orm/migrations';

export class Migration20260420000000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`DO $$ BEGIN ALTER TABLE "business_profiles" ADD COLUMN "ams_url" text null; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`);
    this.addSql(`DO $$ BEGIN ALTER TABLE "business_profiles" ADD COLUMN "ams_webhook_secret" text null; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`);
  }

}
