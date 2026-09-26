import { Migration } from '@mikro-orm/migrations'

/* customer_service_settings.assisted_config (2026-09-28).
 *
 * Settings for the Assisted reply mode (reply_mode = 'assisted'): which
 * channels and inquiry types may send on their own, the confidence floor,
 * send hours and the per-contact daily limit. NULL = never configured, which
 * the app reads as the defaults (every channel off). Self-contained and
 * idempotent; a missing table is skipped. */
export class Migration20260928091000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`DO $$
BEGIN
  IF to_regclass('public.customer_service_settings') IS NULL THEN
    RAISE NOTICE 'skip: table customer_service_settings does not exist';
    RETURN;
  END IF;
  ALTER TABLE public.customer_service_settings ADD COLUMN IF NOT EXISTS assisted_config jsonb NULL;
END $$;`)
  }

  override async down(): Promise<void> {
    this.addSql(`DO $$
BEGIN
  IF to_regclass('public.customer_service_settings') IS NULL THEN
    RETURN;
  END IF;
  ALTER TABLE public.customer_service_settings DROP COLUMN IF EXISTS assisted_config;
END $$;`)
  }
}
