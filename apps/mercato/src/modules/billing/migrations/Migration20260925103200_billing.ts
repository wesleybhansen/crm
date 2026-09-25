import { Migration } from '@mikro-orm/migrations'

/**
 * platform_settings holds platform-wide knobs such as the global monthly AI
 * call cap. The admin panel (/api/admin and /api/admin/ai) and the AI gateway
 * read it, but no migration ever created it, so both admin endpoints returned
 * 500 and the gateway silently fell back to its built-in cap.
 *
 * The seeded cap matches the gateway's built-in default (500), so creating the
 * row changes no behavior; it only gives the admin panel something to edit.
 */
export class Migration20260925103200_billing extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "platform_settings" ("id" uuid not null default gen_random_uuid(), "setting_key" text not null, "setting_value" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), constraint "platform_settings_pkey" primary key ("id"));`,
    )
    this.addSql(
      `create unique index if not exists "platform_settings_setting_key_unique" on "platform_settings" ("setting_key");`,
    )
    this.addSql(
      `insert into "platform_settings" ("setting_key", "setting_value") values ('global_ai_monthly_cap', '500') on conflict ("setting_key") do nothing;`,
    )
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "platform_settings";`)
  }
}
