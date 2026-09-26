import { Migration } from '@mikro-orm/migrations'

/* automation_webhook_secrets (2026-09-30).
 *
 * The signing secret for automation "Webhook" actions, one per business
 * (tenant + organization). lib/automation-webhook.ts signs every request with
 * it (X-Noli-Signature) and stores it sealed with the tenant's key; the
 * automation builder shows it once (revealed_at records that).
 * Self-contained and idempotent. */
export class Migration20260930090000_sequences extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE IF NOT EXISTS public.automation_webhook_secrets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  secret text NOT NULL,
  revealed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_webhook_secrets_pkey PRIMARY KEY (id)
);`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS automation_webhook_secrets_scope_unique
  ON public.automation_webhook_secrets (tenant_id, organization_id);`)
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS public.automation_webhook_secrets;`)
  }
}
