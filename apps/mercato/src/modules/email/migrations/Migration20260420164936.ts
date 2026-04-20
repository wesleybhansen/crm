import { Migration } from '@mikro-orm/migrations';

export class Migration20260420164936 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "email_connections" add column "imap_host" text null, add column "imap_port" int null, add column "imap_secure" boolean null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "email_connections" drop column "imap_host", drop column "imap_port", drop column "imap_secure";`);
  }

}
