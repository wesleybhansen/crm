import { Migration } from '@mikro-orm/migrations'

/* reminder_deliveries (2026-09-26): once-per-window ledger for booking and
 * event reminders (lib/reminder-runs.ts). A row is claimed before a reminder
 * is sent and removed if the send fails, so the box cron (every few minutes)
 * never sends one twice. Self-contained and idempotent. */
export class Migration20260926160000_calendar extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE IF NOT EXISTS public.reminder_deliveries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  kind text NOT NULL,
  subject_id uuid NOT NULL,
  reminder_window text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reminder_deliveries_pkey PRIMARY KEY (id)
);`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS reminder_deliveries_once_idx
  ON public.reminder_deliveries (organization_id, kind, subject_id, reminder_window);`)
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS public.reminder_deliveries;`)
  }
}
