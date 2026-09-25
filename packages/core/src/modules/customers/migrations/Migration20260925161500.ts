import { Migration } from '@mikro-orm/migrations';

/* Events tables (2026-09-25).
 *
 * The CRM events feature (apps/mercato/src/modules/customers/api/crm-events/**,
 * the public event pages, the kiosk, the Stripe event checkout webhook and
 * the contact timeline) reads and writes the raw-knex tables `events` and
 * `event_attendees`, but no migration ever created them, so production had
 * neither: listing events, publishing an event and every public event page
 * returned 500.
 *
 * Columns match exactly what those handlers insert, update and select.
 * JSON columns are jsonb (handlers write JSON.stringify strings and read
 * either a string or an object). Idempotent: CREATE ... IF NOT EXISTS, and
 * ADD COLUMN IF NOT EXISTS for databases where an older hand-made copy of
 * the tables exists. The global unique slug / kiosk_token indexes repeat
 * Migration20260924200000, which skipped them when the table was missing. */
export const EVENTS_TABLES_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS "events" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "organization_id" uuid NOT NULL,
    "title" text NOT NULL,
    "description" text NULL,
    "slug" text NOT NULL,
    "event_type" text NOT NULL DEFAULT 'in-person',
    "status" text NOT NULL DEFAULT 'draft',
    "location_name" text NULL,
    "location_address" text NULL,
    "virtual_link" text NULL,
    "start_time" timestamptz NOT NULL,
    "end_time" timestamptz NOT NULL,
    "timezone" text NOT NULL DEFAULT 'America/New_York',
    "is_recurring" boolean NOT NULL DEFAULT false,
    "recurrence_rule" jsonb NULL,
    "recurrence_parent_id" uuid NULL,
    "capacity" integer NULL,
    "registration_deadline" timestamptz NULL,
    "price" numeric(12,2) NULL,
    "currency" text NOT NULL DEFAULT 'USD',
    "is_free" boolean NOT NULL DEFAULT true,
    "registration_fields" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "preapproved_emails" jsonb NULL,
    "landing_copy" jsonb NULL,
    "landing_style" text NOT NULL DEFAULT 'warm',
    "terms_text" text NULL,
    "reminder_config" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "attendee_count" integer NOT NULL DEFAULT 0,
    "kiosk_token" text NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    "deleted_at" timestamptz NULL
  );`,
  // Older hand-made copies of the table may lack later columns.
  `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "is_recurring" boolean NOT NULL DEFAULT false;`,
  `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "recurrence_rule" jsonb NULL;`,
  `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "recurrence_parent_id" uuid NULL;`,
  `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "preapproved_emails" jsonb NULL;`,
  `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "landing_copy" jsonb NULL;`,
  `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "landing_style" text NOT NULL DEFAULT 'warm';`,
  `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "terms_text" text NULL;`,
  `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "reminder_config" jsonb NOT NULL DEFAULT '[]'::jsonb;`,
  `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "attendee_count" integer NOT NULL DEFAULT 0;`,
  `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "kiosk_token" text NULL;`,
  `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz NULL;`,
  `CREATE INDEX IF NOT EXISTS "events_org_start_idx" ON "events" ("organization_id", "start_time") WHERE "deleted_at" IS NULL;`,
  `CREATE INDEX IF NOT EXISTS "events_org_status_start_idx" ON "events" ("organization_id", "status", "start_time") WHERE "deleted_at" IS NULL;`,
  `CREATE INDEX IF NOT EXISTS "events_recurrence_parent_idx" ON "events" ("recurrence_parent_id") WHERE "recurrence_parent_id" IS NOT NULL;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "events_slug_global_uniq" ON "events" ("slug") WHERE deleted_at IS NULL;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "events_kiosk_token_global_uniq" ON "events" ("kiosk_token") WHERE kiosk_token IS NOT NULL AND deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS "event_attendees" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "organization_id" uuid NOT NULL,
    "event_id" uuid NOT NULL REFERENCES "events" ("id") ON DELETE CASCADE,
    "contact_id" uuid NULL,
    "attendee_name" text NOT NULL,
    "attendee_email" text NOT NULL,
    "status" text NOT NULL DEFAULT 'registered',
    "ticket_quantity" integer NOT NULL DEFAULT 1,
    "guest_details" jsonb NULL,
    "registration_data" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "accepted_terms" boolean NOT NULL DEFAULT false,
    "payment_id" text NULL,
    "checked_in_at" timestamptz NULL,
    "checkin_source" text NULL,
    "registered_at" timestamptz NOT NULL DEFAULT now(),
    "cancelled_at" timestamptz NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NULL
  );`,
  `ALTER TABLE "event_attendees" ADD COLUMN IF NOT EXISTS "payment_id" text NULL;`,
  `ALTER TABLE "event_attendees" ADD COLUMN IF NOT EXISTS "checked_in_at" timestamptz NULL;`,
  `ALTER TABLE "event_attendees" ADD COLUMN IF NOT EXISTS "checkin_source" text NULL;`,
  `ALTER TABLE "event_attendees" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamptz NULL;`,
  `CREATE INDEX IF NOT EXISTS "event_attendees_event_email_idx" ON "event_attendees" ("event_id", "attendee_email");`,
  `CREATE INDEX IF NOT EXISTS "event_attendees_org_event_idx" ON "event_attendees" ("organization_id", "event_id", "registered_at");`,
  `CREATE INDEX IF NOT EXISTS "event_attendees_contact_idx" ON "event_attendees" ("contact_id") WHERE "contact_id" IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS "idx_event_attendees_event_checkin" ON "event_attendees" ("event_id", "checked_in_at");`,
];

export class Migration20260925161500 extends Migration {

  override async up(): Promise<void> {
    for (const sql of EVENTS_TABLES_SQL) this.addSql(sql);
  }

  override async down(): Promise<void> {
    // Dropping would destroy customer event data; the tables stay.
  }

}
