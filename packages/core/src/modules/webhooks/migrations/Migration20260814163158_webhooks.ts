import { Migration } from '@mikro-orm/migrations'

export class Migration20260814163158_webhooks extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "webhook_deliveries" ("id" uuid not null default gen_random_uuid(), "subscription_id" uuid not null, "event" text not null, "payload" jsonb not null, "status_code" int null, "response_body" text null, "attempt" int not null default 1, "delivered_at" timestamptz null, "failed_at" timestamptz null, "created_at" timestamptz not null default now(), constraint "webhook_deliveries_pkey" primary key ("id"));`,
    )
    this.addSql(
      `create index if not exists "webhook_deliveries_sub_idx" on "webhook_deliveries" ("subscription_id", "created_at");`,
    )

    this.addSql(
      `create table if not exists "webhook_subscriptions" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "event" text not null, "target_url" text not null, "secret" text null, "is_active" boolean not null default true, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), constraint "webhook_subscriptions_pkey" primary key ("id"));`,
    )
    this.addSql(
      `create index if not exists "webhook_subs_org_idx" on "webhook_subscriptions" ("organization_id", "event");`,
    )
  }
}
