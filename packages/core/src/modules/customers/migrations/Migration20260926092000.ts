import { Migration } from '@mikro-orm/migrations'

/* One default deal pipeline per organization (2026-09-25 review, LOW).
 *
 * ensureDefaultDealPipeline was check-then-insert: two first sign-ins (or a
 * sign-in racing the backfill) could each create "Default Pipeline". A partial
 * unique index on (tenant_id, organization_id) WHERE is_default makes the
 * loser fail; the helper then re-reads the winner. Changing the default in the
 * app unsets the old one first, so the index never blocks it.
 *
 * Fails loudly on existing duplicates (production had none on 2026-09-25).
 * Self-contained, idempotent. */
export class Migration20260926092000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`DO $$
DECLARE dup_count integer;
BEGIN
  IF to_regclass('public.customer_pipelines') IS NULL THEN
    RAISE NOTICE 'skip: table customer_pipelines does not exist';
    RETURN;
  END IF;
  SELECT count(*) INTO dup_count FROM (
    SELECT tenant_id, organization_id FROM public.customer_pipelines
     WHERE is_default GROUP BY 1, 2 HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'customer_pipelines: % organizations have more than one default pipeline; keep one default first', dup_count;
  END IF;
  CREATE UNIQUE INDEX IF NOT EXISTS customer_pipelines_one_default_per_org
    ON public.customer_pipelines (tenant_id, organization_id) WHERE is_default;
END $$;`)
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS public.customer_pipelines_one_default_per_org;`)
  }
}
