import { Migration } from '@mikro-orm/migrations';

// Adds a nullable source-mailbox tag to inbox_conversations. The shared IMAP
// ingest lands both the personal mailbox and the Customer Service support
// mailbox into inbox_conversations. Without a tag, CS support mail leaks into the
// personal inbox list. This column lets the personal inbox exclude
// 'customer_service' rows. NULL = personal inbox. The table is created at runtime
// in some environments, so this migration is idempotent and table-guarded.
export class Migration20260615130000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`do $$ begin
      if exists (select 1 from information_schema.tables where table_name = 'inbox_conversations') then
        alter table "inbox_conversations" add column if not exists "source_mailbox_purpose" text null;
      end if;
    end $$;`);
  }

  override async down(): Promise<void> {
    this.addSql(`do $$ begin
      if exists (select 1 from information_schema.tables where table_name = 'inbox_conversations') then
        alter table "inbox_conversations" drop column if exists "source_mailbox_purpose";
      end if;
    end $$;`);
  }

}
