import { Migration } from '@mikro-orm/migrations'

/**
 * credit_packages is a global catalog, but setup-tables.sql seeded it with
 * `ON CONFLICT DO NOTHING` and no unique key, so every deploy added another
 * Starter / Growth / Pro set (Billing showed each package 15 times).
 *
 * Keep one row per package name (an active one first, then the oldest) and add
 * a unique constraint on name, which also makes the existing seeder's
 * `ON CONFLICT DO NOTHING` a real no-op from now on. No table references
 * credit_packages.id, so nothing needs repointing.
 */
export const DEDUPE_CREDIT_PACKAGES_SQL = `
  delete from "credit_packages" cp
  using (
    select "id", row_number() over (
      partition by "name"
      order by "is_active" desc, ("stripe_price_id" is not null) desc, "created_at" asc, "id" asc
    ) as rn
    from "credit_packages"
  ) ranked
  where cp."id" = ranked."id" and ranked.rn > 1;
`

export const UNIQUE_CREDIT_PACKAGE_NAME_SQL = `
  do $$
  begin
    if not exists (
      select 1 from pg_constraint where conname = 'credit_packages_name_unique'
    ) then
      alter table "credit_packages" add constraint "credit_packages_name_unique" unique ("name");
    end if;
  end $$;
`

export class Migration20260925103100_billing extends Migration {
  override async up(): Promise<void> {
    this.addSql(DEDUPE_CREDIT_PACKAGES_SQL)
    this.addSql(UNIQUE_CREDIT_PACKAGE_NAME_SQL)
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "credit_packages" drop constraint if exists "credit_packages_name_unique";`)
  }
}
