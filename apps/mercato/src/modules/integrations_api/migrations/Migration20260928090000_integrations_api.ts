import { Migration } from '@mikro-orm/migrations';

/* integrations_api_outbound_events (2026-09-28): the outbox the CRM delivers
 * cross-app events from, starting with `deal.closed` to the marketing app.
 * Self-contained and idempotent. */
export class Migration20260928090000_integrations_api extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "integrations_api_outbound_events" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "event_type" text not null, "subject_id" uuid not null, "event_id" text not null, "target" text not null, "occurred_at" timestamptz not null, "status" text not null default 'pending', "attempts" int not null default 0, "next_attempt_at" timestamptz not null default now(), "last_status_code" int null, "last_error" text null, "delivered_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), constraint "integrations_api_outbound_events_pkey" primary key ("id"));`);
    this.addSql(`create index if not exists "integrations_api_outbound_events_due_idx" on "integrations_api_outbound_events" ("status", "next_attempt_at");`);
    this.addSql(`DO $$ BEGIN
  ALTER TABLE "integrations_api_outbound_events" ADD CONSTRAINT "integrations_api_outbound_events_subject_unique" UNIQUE ("organization_id", "event_type", "subject_id");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;`);
    this.addSql(`DO $$ BEGIN
  ALTER TABLE "integrations_api_outbound_events" ADD CONSTRAINT "integrations_api_outbound_events_event_id_unique" UNIQUE ("event_id");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "integrations_api_outbound_events" cascade;`);
  }

}
