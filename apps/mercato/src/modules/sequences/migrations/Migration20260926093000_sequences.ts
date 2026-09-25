import { Migration } from '@mikro-orm/migrations'

/* One active enrollment per contact and sequence (2026-09-25 review, LOW).
 *
 * Production already has enrollments_seq_contact_idx (created by hand with
 * the legacy table); fresh databases (CI, new installs) did not, so the
 * enroll route's check-then-insert could double-enroll there. This creates
 * it where missing. Fails loudly on existing duplicates. A missing table is
 * skipped with a NOTICE. Self-contained, idempotent. */
export class Migration20260926093000_sequences extends Migration {
  override async up(): Promise<void> {
    this.addSql(`DO $$
DECLARE dup_count integer;
BEGIN
  IF to_regclass('public.sequence_enrollments') IS NULL THEN
    RAISE NOTICE 'skip: table sequence_enrollments does not exist';
    RETURN;
  END IF;
  IF to_regclass('public.enrollments_seq_contact_idx') IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT count(*) INTO dup_count FROM (
    SELECT sequence_id, contact_id FROM public.sequence_enrollments
     WHERE status = 'active' GROUP BY 1, 2 HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'sequence_enrollments: % contacts are actively enrolled twice in one sequence; stop the extra enrollments first', dup_count;
  END IF;
  CREATE UNIQUE INDEX IF NOT EXISTS enrollments_seq_contact_idx
    ON public.sequence_enrollments (sequence_id, contact_id) WHERE status = 'active';
END $$;`)
  }

  override async down(): Promise<void> {
    // Kept: production relies on it.
  }
}
