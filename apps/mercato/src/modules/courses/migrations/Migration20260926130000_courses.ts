import { Migration } from '@mikro-orm/migrations'

/* course_enrollments.welcome_email_sent_at (2026-09-25).
 *
 * The "You're enrolled!" email is sent at most once per enrollment, decided by
 * this column (courses/lib/enrollment-email.ts claims it NULL -> now() before
 * sending). Existing enrollments stay NULL: the email is only ever attempted
 * right after an enrollment is created, so old rows are never emailed.
 *
 * course_enrollments is a legacy table no migration creates, so a database
 * without it is skipped with a NOTICE. Self-contained. Idempotent. */
export class Migration20260926130000_courses extends Migration {
  override async up(): Promise<void> {
    this.addSql(`DO $$
BEGIN
  IF to_regclass('public.course_enrollments') IS NULL THEN
    RAISE NOTICE 'skip welcome_email_sent_at: table course_enrollments does not exist';
    RETURN;
  END IF;
  ALTER TABLE "course_enrollments" ADD COLUMN IF NOT EXISTS "welcome_email_sent_at" timestamptz NULL;
END $$;`)
  }

  override async down(): Promise<void> {
    this.addSql(`DO $$
BEGIN
  IF to_regclass('public.course_enrollments') IS NOT NULL THEN
    ALTER TABLE "course_enrollments" DROP COLUMN IF EXISTS "welcome_email_sent_at";
  END IF;
END $$;`)
  }
}
