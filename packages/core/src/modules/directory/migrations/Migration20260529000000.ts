import { Migration } from '@mikro-orm/migrations';

export class Migration20260529000000 extends Migration {

  // Multi-tenancy M5b: link a Mercato org to its noli-core organization so a
  // noli-core team shares ONE Mercato org. Nullable + unique (legacy orgs stay
  // null until lazily backfilled on the owner's next sign-in).
  //
  // NOTE: this column was applied out-of-band on the 2026-05-29 M5b deploy
  // (this migration wasn't aggregated into the app's migrator path via
  // `db:generate`, so `db:migrate` didn't pick it up on startup). This file is
  // therefore IDEMPOTENT so that if a later `db:generate` aggregates it and
  // `db:migrate` runs it, it's a safe no-op rather than a failure.
  override async up(): Promise<void> {
    this.addSql(`alter table "organizations" add column if not exists "noli_org_id" text;`);
    this.addSql(`do $$ begin
      if not exists (select 1 from pg_class where relname = 'organizations_noli_org_id_uniq') then
        alter table "organizations" add constraint "organizations_noli_org_id_uniq" unique ("noli_org_id");
      end if;
    end $$;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "organizations" drop constraint if exists "organizations_noli_org_id_uniq";`);
    this.addSql(`drop index if exists "organizations_noli_org_id_uniq";`);
    this.addSql(`alter table "organizations" drop column if exists "noli_org_id";`);
  }

}
