import { Migration } from '@mikro-orm/migrations'

/* team_invites.accepted_at (2026-09-25).
 *
 * Invite accept has always set accepted_at, but no migration (and not the
 * production table) has the column: every accept failed with a 500 AFTER the
 * user was created, leaving the invite 'pending' and the invitee unable to
 * use the link again. Found by TC-TENANT-001's first real run. Adds the
 * column. Self-contained, idempotent; a missing table is skipped. */
export class Migration20260926095000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`DO $$
BEGIN
  IF to_regclass('public.team_invites') IS NULL THEN
    RAISE NOTICE 'skip: table team_invites does not exist';
    RETURN;
  END IF;
  ALTER TABLE public.team_invites ADD COLUMN IF NOT EXISTS accepted_at timestamptz NULL;
END $$;`)
  }

  override async down(): Promise<void> {
    // Kept: it records when an invite was used.
  }
}
