import { Migration } from '@mikro-orm/migrations';

export class Migration20260420120000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`DO $$ BEGIN ALTER TABLE "users" ADD COLUMN "google_sub" text null; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "users_google_sub_unique" ON "users" ("google_sub") WHERE "google_sub" IS NOT NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "users_google_sub_unique";`);
    this.addSql(`ALTER TABLE "users" DROP COLUMN IF EXISTS "google_sub";`);
  }

}
