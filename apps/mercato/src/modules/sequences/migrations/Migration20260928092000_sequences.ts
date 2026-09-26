import { Migration } from '@mikro-orm/migrations'

/* automation_trigger_dispatches (2026-09-28).
 *
 * The once-per-event ledger for automation triggers (deal won, deal stage
 * change, invoice paid, booking created): lib/automation-dispatch.ts claims
 * (organization, trigger, event key) before running any rule, so a replayed or
 * duplicated event runs nothing. Self-contained and idempotent. */
export class Migration20260928092000_sequences extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE IF NOT EXISTS public.automation_trigger_dispatches (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  trigger_type text NOT NULL,
  event_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_trigger_dispatches_pkey PRIMARY KEY (id)
);`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS automation_trigger_dispatches_event_unique
  ON public.automation_trigger_dispatches (organization_id, trigger_type, event_key);`)
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS public.automation_trigger_dispatches;`)
  }
}
