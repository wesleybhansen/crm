import { Migration } from '@mikro-orm/migrations';

// Short play names (2026-09-11): gtm_plays.name is a nullable, 3..80 character
// label a founder recognises in a dropdown ("Austin dental practices, 1 to 50
// staff"). Generated best-effort at play creation; existing rows are filled
// by the internal /internal/gtm/plays/name-backfill route. `audience` stays
// the subtitle everywhere the play is listed.
// Applied by hand on the production box like every other GTM migration.
export class Migration20260911120000_gtm extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "gtm_plays" add column if not exists "name" text null;`);
    this.addSql(`do $$ begin if not exists (select 1 from pg_constraint where conname = 'gtm_plays_name_length_check') then alter table "gtm_plays" add constraint "gtm_plays_name_length_check" check ("name" is null or char_length("name") <= 80); end if; end $$;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "gtm_plays" drop constraint if exists "gtm_plays_name_length_check";`);
    this.addSql(`alter table "gtm_plays" drop column if exists "name";`);
  }

}
