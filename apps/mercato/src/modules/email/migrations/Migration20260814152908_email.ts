import { Migration } from '@mikro-orm/migrations'

export class Migration20260814152908_email extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "email_campaigns" ("id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "name" text not null, "template_id" uuid null, "subject" text null, "body_html" text null, "status" text not null default 'draft', "segment_filter" jsonb null, "category" text null, "scheduled_at" timestamptz null, "scheduled_for" timestamptz null, "stats" jsonb not null default '{}', "created_at" timestamptz not null default now(), "updated_at" timestamptz null, "sent_at" timestamptz null, "deleted_at" timestamptz null, constraint "email_campaigns_pkey" primary key ("id"));`,
    )

    this.addSql(
      `create table if not exists "email_campaign_recipients" ("id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "campaign_id" uuid not null, "contact_id" uuid not null, "email" text not null, "status" text not null default 'pending', "sent_at" timestamptz null, "opened_at" timestamptz null, "clicked_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "email_campaign_recipients_pkey" primary key ("id"));`,
    )
    this.addSql(
      `create index if not exists "email_campaign_recipients_idx" on "email_campaign_recipients" ("campaign_id", "contact_id");`,
    )

    this.addSql(
      `create table if not exists "email_messages" ("id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "account_id" uuid null, "direction" text not null, "from_address" text not null, "to_address" text not null, "cc" text null, "bcc" text null, "subject" text not null, "body_html" text not null, "body_text" text null, "thread_id" text null, "contact_id" uuid null, "deal_id" uuid null, "campaign_id" uuid null, "status" text not null default 'draft', "tracking_id" uuid not null, "opened_at" timestamptz null, "clicked_at" timestamptz null, "bounced_at" timestamptz null, "metadata" jsonb null, "sentiment" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "sent_at" timestamptz null, "deleted_at" timestamptz null, constraint "email_messages_pkey" primary key ("id"));`,
    )
    this.addSql(`create index if not exists "email_messages_tracking_idx" on "email_messages" ("tracking_id");`)
    this.addSql(
      `create index if not exists "email_messages_org_contact_idx" on "email_messages" ("organization_id", "contact_id");`,
    )
  }
}
