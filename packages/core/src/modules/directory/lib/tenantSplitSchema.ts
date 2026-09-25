/**
 * Schema for one tenant per customer, shared by Migration20260926120000 and
 * the Postgres-backed tests. Every statement is idempotent and contains no
 * `?` (knex would read it as a binding placeholder).
 *
 * tenants.seed_version   How far ensureTenantSeeded (auth/lib/provision-tenant.ts)
 *                        has brought a tenant. Tenants that exist when this runs
 *                        were set up by setupInitialTenant / `mercato init`, so
 *                        they start at 1 (the first versioned seed); tenants the
 *                        split script or sign-in create start at 0 and are
 *                        seeded on first use. Read and written with raw SQL only.
 *
 * organization_tenant_moves  Permanent record of every organization the
 *                        tenant split moved: signed artefacts minted before the
 *                        move (GTM unsubscribe links, platform COS credentials)
 *                        carry the old tenant id and are resolved through it.
 *
 * Relative imports only (bundled into scripts/split-tenants.ts).
 */
export const TENANT_SPLIT_SCHEMA_SQL: string[] = [
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

export const TENANT_SPLIT_SCHEMA_DOWN_SQL: string[] = [
  `drop table if exists "organization_tenant_moves";`,
  `alter table "tenants" drop column if exists "seed_version";`,
]
