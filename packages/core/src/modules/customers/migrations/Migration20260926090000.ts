import { Migration } from '@mikro-orm/migrations'

/* Event registrations are encrypted like contacts (2026-09-25 review, M11).
 *
 * event_attendees (Migration20260925161500) stores the registrant's name and
 * email, written by public routes (register, event checkout, kiosk, Stripe
 * webhook), in plaintext and outside the encryption maps. This:
 * - adds attendee_email_hash, the per-tenant keyed lookup hash the app now
 *   matches duplicates and check-ins on (the email itself becomes ciphertext);
 * - adds a 'customers:event_attendee' encryption map (attendee_name,
 *   attendee_email) for every live organization that already has encryption
 *   maps, so new registrations are encrypted from the next write. Existing
 *   rows are encrypted by `reencrypt-plaintext-contacts --table event_attendees`.
 *
 * Self-contained (imports only @mikro-orm/migrations). Idempotent. A missing
 * table is skipped with a NOTICE. */
export class Migration20260926090000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`DO $$
BEGIN
  IF to_regclass('public.event_attendees') IS NULL THEN
    RAISE NOTICE 'skip: table event_attendees does not exist';
  ELSE
    ALTER TABLE public.event_attendees ADD COLUMN IF NOT EXISTS attendee_email_hash text NULL;
    CREATE INDEX IF NOT EXISTS event_attendees_event_email_hash_idx
      ON public.event_attendees (event_id, attendee_email_hash) WHERE attendee_email_hash IS NOT NULL;
  END IF;
  IF to_regclass('public.encryption_maps') IS NOT NULL AND to_regclass('public.organizations') IS NOT NULL THEN
    INSERT INTO public.encryption_maps (id, entity_id, tenant_id, organization_id, fields_json, is_active, created_at, updated_at)
    SELECT gen_random_uuid(), 'customers:event_attendee', o.tenant_id, o.id,
           '[{"field":"attendee_name"},{"field":"attendee_email"}]'::jsonb, true, now(), now()
      FROM public.organizations o
     WHERE o.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM public.encryption_maps m
                    WHERE m.organization_id = o.id AND m.is_active AND m.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.encryption_maps m
                        WHERE m.entity_id = 'customers:event_attendee'
                          AND m.tenant_id = o.tenant_id AND m.organization_id = o.id
                          AND m.deleted_at IS NULL);
  END IF;
END $$;`)
  }

  override async down(): Promise<void> {
    // Encrypted values stay encrypted; the map and the hash column are kept so
    // they remain readable.
  }
}
