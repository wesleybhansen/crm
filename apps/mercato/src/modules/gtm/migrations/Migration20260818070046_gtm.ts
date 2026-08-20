import { Migration } from '@mikro-orm/migrations';

export class Migration20260818070046_gtm extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "gtm_mailbox_policies" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "mailbox_connection_id" uuid not null, "policy_version" text not null default 'mailbox-capacity-v1', "daily_cap" int not null default 25, "send_window_start_hour" int not null default 9, "send_window_end_hour" int not null default 17, "timezone" text not null default 'America/New_York', "bound_by_campaign_version_id" uuid not null, "fence" int not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "gtm_mailbox_policies_pkey" primary key ("id"));`);
    this.addSql(`create index "gtm_mailbox_policies_org_tenant_idx" on "gtm_mailbox_policies" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "gtm_mailbox_policies" add constraint "gtm_mailbox_policies_org_tenant_mailbox_unique" unique ("organization_id", "tenant_id", "mailbox_connection_id");`);

    this.addSql(`create index "gtm_send_attempts_mailbox_capacity_idx" on "gtm_send_attempts" ("organization_id", "tenant_id", "mailbox_connection_id", "state", "scheduled_for");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index "gtm_send_attempts_mailbox_capacity_idx";`);
  }

}
