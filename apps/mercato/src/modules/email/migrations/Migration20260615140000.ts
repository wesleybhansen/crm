import { Migration } from '@mikro-orm/migrations';

// Brings the Customer Service reply model to the personal Inbox AI desk. Adds the
// reply-mode columns to the per-organization inbox_ai_settings row so the Inbox
// Settings tab can save: how replies are handled (reply_mode: draft / auto-send /
// hybrid), the hybrid auto-send confidence cutoff (hybrid_confidence_threshold),
// and the flag scenarios to watch for (flag_scenarios: a jsonb array of
// { key, label, enabled, action: 'pause'|'auto_send', instructions }).
//
// This is the SETTINGS + STORAGE phase only. No drafting / auto-send / flag
// enforcement runs off these columns yet; that engine is a later phase.
//
// inbox_ai_settings is per-organization and lazy-created at runtime by
// /api/inbox/ai-settings, so this migration is idempotent and only adds the
// columns if the table already exists.
export class Migration20260615140000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`do $$ begin
      if exists (select 1 from information_schema.tables where table_name = 'inbox_ai_settings') then
        alter table "inbox_ai_settings" add column if not exists "reply_mode" text not null default 'draft';
        alter table "inbox_ai_settings" add column if not exists "hybrid_confidence_threshold" numeric not null default 0.85;
        alter table "inbox_ai_settings" add column if not exists "flag_scenarios" jsonb null;
      end if;
    end $$;`);
  }

  override async down(): Promise<void> {
    this.addSql(`do $$ begin
      if exists (select 1 from information_schema.tables where table_name = 'inbox_ai_settings') then
        alter table "inbox_ai_settings" drop column if exists "reply_mode";
        alter table "inbox_ai_settings" drop column if exists "hybrid_confidence_threshold";
        alter table "inbox_ai_settings" drop column if exists "flag_scenarios";
      end if;
    end $$;`);
  }

}
