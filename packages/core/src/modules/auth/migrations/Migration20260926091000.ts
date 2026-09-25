import { Migration } from '@mikro-orm/migrations'

/* One account per email inside a tenant (2026-09-25 review, LOW).
 *
 * users.email is encrypted with a random IV, so users_email_unique never
 * catches a duplicate, and invite accept was check-then-insert on email_hash:
 * two accepts racing could create two users with the same email in one
 * tenant. A partial unique index on (tenant_id, email_hash) closes it. The
 * same email in two tenants stays allowed (one person, two customers).
 *
 * Checks the data first and fails loudly (listing counts, never values) on
 * existing duplicates; production had none on 2026-09-25. Self-contained,
 * idempotent. */
export class Migration20260926091000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`DO $$
DECLARE dup_count integer;
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE NOTICE 'skip: table users does not exist';
    RETURN;
  END IF;
  SELECT count(*) INTO dup_count FROM (
    SELECT tenant_id, email_hash FROM public.users
     WHERE deleted_at IS NULL AND email_hash IS NOT NULL
     GROUP BY 1, 2 HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'users: % (tenant_id, email_hash) pairs have more than one live user; merge or soft-delete them first', dup_count;
  END IF;
  CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_email_hash_uniq
    ON public.users (tenant_id, email_hash) WHERE deleted_at IS NULL AND email_hash IS NOT NULL;
END $$;`)
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS public.users_tenant_email_hash_uniq;`)
  }
}
