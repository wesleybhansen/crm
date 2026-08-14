import { Migration } from '@mikro-orm/migrations'

export class Migration20260814162326_billing extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "credit_balances" ("id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "balance" numeric(10,4) not null default '0', "updated_at" timestamptz not null default now(), constraint "credit_balances_pkey" primary key ("id"));`,
    )
    this.addSql(
      `alter table "credit_balances" add constraint "credit_balances_organization_id_unique" unique ("organization_id");`,
    )
    this.addSql(
      `create index if not exists "credit_balances_org_idx" on "credit_balances" ("organization_id");`,
    )

    this.addSql(
      `create table if not exists "credit_packages" ("id" uuid not null, "name" text not null, "credit_amount" numeric(10,4) not null, "price" numeric(10,2) not null, "stripe_price_id" text null, "is_active" boolean not null default true, "sort_order" int not null default 0, "created_at" timestamptz not null default now(), constraint "credit_packages_pkey" primary key ("id"));`,
    )

    this.addSql(
      `create table if not exists "credit_transactions" ("id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "amount" numeric(10,4) not null, "type" text not null, "description" text not null, "service" text null, "reference_id" text null, "created_at" timestamptz not null default now(), constraint "credit_transactions_pkey" primary key ("id"));`,
    )
    this.addSql(
      `create index if not exists "credit_transactions_org_date_idx" on "credit_transactions" ("organization_id", "created_at");`,
    )
  }
}
