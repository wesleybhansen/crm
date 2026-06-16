import { Migration } from '@mikro-orm/migrations';

// Records WHY the inbox AI engine produced no draft for a conversation (e.g.
// 'automated' = a newsletter / no-reply message it deliberately skipped), so the
// inbox can show a short explanation instead of a silent empty composer.
// Idempotent + table-guarded: only adds the column if the table already exists.
export class Migration20260616120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`do $$ begin
      if exists (select 1 from information_schema.tables where table_name = 'inbox_conversations') then
        alter table "inbox_conversations" add column if not exists "inbox_draft_skip_reason" text null;
      end if;
    end $$;`);
  }

  override async down(): Promise<void> {
    this.addSql(`do $$ begin
      if exists (select 1 from information_schema.tables where table_name = 'inbox_conversations') then
        alter table "inbox_conversations" drop column if exists "inbox_draft_skip_reason";
      end if;
    end $$;`);
  }
}
