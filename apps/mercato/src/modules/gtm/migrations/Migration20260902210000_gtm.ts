import { Migration } from '@mikro-orm/migrations';

// Adversarial-review follow-ups (2026-09-02, workers/inbound/data + send path):
//  - gtm_send_attempts.kind: 'campaign' | 'reply' so one-off inbox replies are
//    never claimed by the campaign tick or counted as campaign steps.
//  - gtm_send_attempts.transport_retry_count: bounded reschedule counter for
//    provider rejections that provably happened before the payload was
//    accepted (never bumped for an ambiguous outcome).
//  - indexes for the hot per-send / per-page reads: inbound email scans,
//    provider-operation lookups by research run, suppression lookups by
//    (organization, address_hash) regardless of channel.
// Applied by hand on the production box like every other GTM migration.
export class Migration20260902210000_gtm extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "gtm_send_attempts" add column if not exists "kind" text not null default 'campaign';`);
    this.addSql(`alter table "gtm_send_attempts" add column if not exists "transport_retry_count" int not null default 0;`);
    this.addSql(`update "gtm_send_attempts" set "kind" = 'reply' where "idempotency_key" like 'reply:%' and "kind" <> 'reply';`);
    this.addSql(`create index if not exists "gtm_send_attempts_org_tenant_kind_state_due_idx" on "gtm_send_attempts" ("organization_id", "tenant_id", "kind", "state", "scheduled_for");`);
    this.addSql(`create index if not exists "email_messages_org_tenant_direction_created_idx" on "email_messages" ("organization_id", "tenant_id", "direction", "created_at");`);
    this.addSql(`create index if not exists "email_messages_org_tenant_account_direction_created_idx" on "email_messages" ("organization_id", "tenant_id", "account_id", "direction", "created_at");`);
    this.addSql(`create index if not exists "gtm_provider_operations_research_run_idx" on "gtm_provider_operations" ("research_run_id");`);
    this.addSql(`create index if not exists "gtm_suppressions_org_address_hash_idx" on "gtm_suppressions" ("organization_id", "address_hash");`);
    this.addSql(`create index if not exists "gtm_inbound_events_org_tenant_mailbox_occurred_idx" on "gtm_inbound_events" ("organization_id", "tenant_id", "mailbox_connection_id", "occurred_at");`);
    this.addSql(`create index if not exists "gtm_inbound_events_org_tenant_enrollment_idx" on "gtm_inbound_events" ("organization_id", "tenant_id", "enrollment_id");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "gtm_inbound_events_org_tenant_enrollment_idx";`);
    this.addSql(`drop index if exists "gtm_inbound_events_org_tenant_mailbox_occurred_idx";`);
    this.addSql(`drop index if exists "gtm_suppressions_org_address_hash_idx";`);
    this.addSql(`drop index if exists "gtm_provider_operations_research_run_idx";`);
    this.addSql(`drop index if exists "email_messages_org_tenant_account_direction_created_idx";`);
    this.addSql(`drop index if exists "email_messages_org_tenant_direction_created_idx";`);
    this.addSql(`drop index if exists "gtm_send_attempts_org_tenant_kind_state_due_idx";`);
    this.addSql(`alter table "gtm_send_attempts" drop column if exists "transport_retry_count";`);
    this.addSql(`alter table "gtm_send_attempts" drop column if exists "kind";`);
  }

}
