import { Migration } from '@mikro-orm/migrations'

export class Migration20260814162651_email extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "email_accounts" ("id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "email_address" text not null, "display_name" text null, "provider" text not null default 'resend', "config" jsonb null, "is_default" boolean not null default true, "sending_domain" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), constraint "email_accounts_pkey" primary key ("id"));`,
    )

    this.addSql(
      `create table if not exists "email_templates" ("id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "name" text not null, "subject" text not null, "body_html" text not null, "category" text not null default 'transactional', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "email_templates_pkey" primary key ("id"));`,
    )

    this.addSql(
      `create table if not exists "email_unsubscribes" ("id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "email" text not null, "contact_id" uuid null, "created_at" timestamptz not null default now(), constraint "email_unsubscribes_pkey" primary key ("id"));`,
    )
    this.addSql(
      `create index if not exists "email_unsubscribes_org_email_idx" on "email_unsubscribes" ("organization_id", "email");`,
    )
  }
}
