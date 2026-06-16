import { Migration } from '@mikro-orm/migrations';

// Adds an optional signature to the Inbox AI reply assistant settings. The Inbox
// Settings tab lets the user save a signature that is appended to suggested
// drafts. The inbox_ai_settings row is per-organization and created at runtime
// by /api/inbox/ai-settings, so this migration is idempotent and only adds the
// column if the table already exists.
export class Migration20260615120000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`do $$ begin
      if exists (select 1 from information_schema.tables where table_name = 'inbox_ai_settings') then
        alter table "inbox_ai_settings" add column if not exists "signature" text null;
      end if;
    end $$;`);
  }

  override async down(): Promise<void> {
    this.addSql(`do $$ begin
      if exists (select 1 from information_schema.tables where table_name = 'inbox_ai_settings') then
        alter table "inbox_ai_settings" drop column if exists "signature";
      end if;
    end $$;`);
  }

}
