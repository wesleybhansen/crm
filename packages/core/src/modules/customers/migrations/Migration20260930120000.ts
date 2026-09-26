import { Migration } from '@mikro-orm/migrations'

/* Text-message opt-outs per business (2026-09-26).
 *
 * sms_opt_outs records, for one organization and tenant, a phone number
 * (E.164) whose owner replied STOP (or another standard opt-out word) to the
 * business's own Twilio number, or that Twilio refused with error 21610.
 * A START / UNSTOP / YES reply sets opted_in_at; opted_in_at NULL is an
 * active opt-out. One row per business and number (unique index), kept after
 * an opt-in as the record of when consent was withdrawn and restored.
 *
 * Separate from email_unsubscribes on purpose (text and email consent are
 * independent). Self-contained and idempotent: safe to re-run on the box. */
export class Migration20260930120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE IF NOT EXISTS public.sms_opt_outs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  phone_number text NOT NULL,
  contact_id uuid NULL,
  source text NOT NULL DEFAULT 'reply',
  keyword text NULL,
  opted_out_at timestamptz NOT NULL DEFAULT now(),
  opted_in_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_opt_outs_pkey PRIMARY KEY (id)
);`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS sms_opt_outs_org_phone_uq ON public.sms_opt_outs (organization_id, tenant_id, phone_number);`)
    this.addSql(`CREATE INDEX IF NOT EXISTS sms_opt_outs_contact_idx ON public.sms_opt_outs (organization_id, tenant_id, contact_id) WHERE contact_id IS NOT NULL;`)
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS public.sms_opt_outs;`)
  }
}
