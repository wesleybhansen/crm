import { Migration } from '@mikro-orm/migrations'

/* form_submissions.landing_page_id is nullable (2026-09-25).
 *
 * Standalone Forms submissions (apps/mercato/src/modules/forms/api/public/
 * [slug]/submit) have no landing page. Production's table allows NULL; the
 * table this module's first migration creates on fresh databases did not, so
 * every standalone form submission failed there. Idempotent; a no-op on
 * production. Self-contained. */
export class Migration20260926094500_landing_pages extends Migration {
  override async up(): Promise<void> {
    this.addSql(`DO $$
BEGIN
  IF to_regclass('public.form_submissions') IS NOT NULL THEN
    ALTER TABLE public.form_submissions ALTER COLUMN landing_page_id DROP NOT NULL;
  END IF;
END $$;`)
  }

  override async down(): Promise<void> {
    // Standalone submissions have no landing page; never re-tightened.
  }
}
