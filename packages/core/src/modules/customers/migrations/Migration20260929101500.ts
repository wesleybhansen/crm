import { Migration } from '@mikro-orm/migrations'

/* Customer Service mailbox selection + response templates (2026-09-29).
 *
 * 1. customer_service_settings.watched_connection_ids: an empty selection now
 *    means NO mailbox (it used to mean every connected mailbox, which drafted
 *    replies to personal mail). Settings saved under the old meaning (NULL or
 *    a JSON null) are pointed at the org's connected support inboxes, which is
 *    what the settings page promised ("leave everything unchecked to watch
 *    every support inbox"). Orgs with no support inbox keep NULL = none.
 * 2. response_templates: created by hand on production long ago and never by a
 *    migration; created here if missing so fresh databases have it.
 *
 * Self-contained and idempotent; a missing table is skipped. down() is empty:
 * the backfill cannot be told apart from a later choice, and the templates
 * table predates this migration on production. */
export class Migration20260929101500 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`DO $$
BEGIN
  IF to_regclass('public.customer_service_settings') IS NULL OR to_regclass('public.email_connections') IS NULL THEN
    RAISE NOTICE 'skip: customer_service_settings or email_connections does not exist';
    RETURN;
  END IF;
  UPDATE public.customer_service_settings s
     SET watched_connection_ids = support.ids,
         updated_at = now()
    FROM (
      SELECT c.organization_id, c.tenant_id, jsonb_agg(c.id::text ORDER BY c.created_at) AS ids
        FROM public.email_connections c
       WHERE c.purpose = 'customer_service'
         AND c.is_active = true
         AND c.deleted_at IS NULL
       GROUP BY c.organization_id, c.tenant_id
    ) support
   WHERE (s.watched_connection_ids IS NULL OR s.watched_connection_ids = 'null'::jsonb)
     AND support.organization_id = s.organization_id
     AND support.tenant_id = s.tenant_id;
END $$;`)

    this.addSql(`CREATE TABLE IF NOT EXISTS public.response_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  name text NOT NULL,
  subject text NULL,
  body_text text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT response_templates_pkey PRIMARY KEY (id)
);`)
    this.addSql(`CREATE INDEX IF NOT EXISTS response_templates_org_idx ON public.response_templates (organization_id, category);`)
  }

  override async down(): Promise<void> {
    // Intentionally empty (see the header).
  }
}
