import { Migration } from '@mikro-orm/migrations';

// Adds a per-mailbox fetch watermark used by the Customer Service processor's
// dedicated support-inbox fetch pass. The CS cron records cs_last_fetch_at after
// each successful IMAP pull so the next run only fetches newer mail (and the
// first run looks back a fixed window). Only meaningful for
// purpose='customer_service' connections, but the column lives on the shared
// email_connections table.
//
// Idempotent because email_connections may be created at runtime.
export class Migration20260614130000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "email_connections" add column if not exists "cs_last_fetch_at" timestamptz null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "email_connections" drop column if exists "cs_last_fetch_at";`);
  }

}
