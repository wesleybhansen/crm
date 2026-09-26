import { Migration } from '@mikro-orm/migrations'

/* automation_scheduled_steps (2026-09-28).
 *
 * Multi-step automation rules park the steps after a delay here
 * (lib/automation-execute.ts executeSteps) and the scheduled run picks them
 * up when execute_at passes (processScheduledSteps). No migration ever created
 * the table, so a rule with a delay threw on its first delay and took the
 * other rules for that event down with it. Self-contained and idempotent. */
export class Migration20260928093000_sequences extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE IF NOT EXISTS public.automation_scheduled_steps (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  rule_id uuid NULL,
  contact_id uuid NULL,
  steps jsonb NOT NULL,
  current_step integer NOT NULL DEFAULT 0,
  context jsonb NULL,
  execute_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_scheduled_steps_pkey PRIMARY KEY (id)
);`)
    this.addSql(`CREATE INDEX IF NOT EXISTS automation_scheduled_steps_due_idx
  ON public.automation_scheduled_steps (status, execute_at);`)
    this.addSql(`CREATE INDEX IF NOT EXISTS automation_scheduled_steps_org_idx
  ON public.automation_scheduled_steps (organization_id, tenant_id);`)
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS public.automation_scheduled_steps;`)
  }
}
