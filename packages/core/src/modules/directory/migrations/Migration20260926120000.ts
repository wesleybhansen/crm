import { Migration } from '@mikro-orm/migrations';

/**
 * One tenant per customer: tenants.seed_version and organization_tenant_moves
 * (meaning: lib/tenantSplitSchema.ts). Idempotent: the production box applies
 * it with `mercato db migrate`.
 *
 * SELF-CONTAINED ON PURPOSE: the SQL is inlined, not imported from
 * ../lib/tenantSplitSchema. The runner image loads migrations from source and
 * cannot resolve a sibling lib import. migrationsSelfContained.test.ts asserts
 * this copy matches the lib and that no migration imports outside its folder.
 */
const UP_SQL: string[] = [
  `do $$ begin
    if not exists (select 1 from information_schema.columns
                    where table_schema = current_schema() and table_name = 'tenants' and column_name = 'seed_version') then
      alter table "tenants" add column "seed_version" integer not null default 0;
      update "tenants" set "seed_version" = 1 where "deleted_at" is null;
    end if;
  end $$;`,
  `create table if not exists "organization_tenant_moves" (
    "id" uuid not null default gen_random_uuid() primary key,
    "organization_id" uuid not null,
    "from_tenant_id" uuid not null,
    "to_tenant_id" uuid not null,
    "moved_at" timestamptz not null default now(),
    constraint "organization_tenant_moves_org_from_uniq" unique ("organization_id", "from_tenant_id")
  );`,
]

const DOWN_SQL: string[] = [
  `drop table if exists "organization_tenant_moves";`,
  `alter table "tenants" drop column if exists "seed_version";`,
]

export class Migration20260926120000 extends Migration {

  override async up(): Promise<void> {
    for (const sql of UP_SQL) this.addSql(sql);
  }

  override async down(): Promise<void> {
    for (const sql of DOWN_SQL) this.addSql(sql);
  }

}
