import { Migration } from '@mikro-orm/migrations'

/* Automation run history survives deleting its rule.
 *
 * automation_rule_logs is a legacy table (not created by migrations). Its
 * rule_id was NOT NULL with a plain foreign key to automation_rules, and the
 * delete handler wrote a deleted_rule_name column that never existed, so
 * deleting any automation failed with a 500. This adds the column, lets
 * rule_id be NULL for logs of a deleted rule, and makes the foreign key
 * ON DELETE SET NULL. The delete handler works with or without this
 * migration (without it, the deleted rule's logs are removed).
 *
 * A missing table is skipped with a NOTICE. Idempotent. */
export class Migration20260925143100_sequences extends Migration {
  override async up(): Promise<void> {
    this.addSql(`DO $$
BEGIN
  IF to_regclass('public.automation_rule_logs') IS NULL THEN
    RAISE NOTICE 'skip: table automation_rule_logs does not exist';
    RETURN;
  END IF;
  ALTER TABLE public.automation_rule_logs ADD COLUMN IF NOT EXISTS deleted_rule_name text;
  ALTER TABLE public.automation_rule_logs ALTER COLUMN rule_id DROP NOT NULL;
  IF to_regclass('public.automation_rules') IS NOT NULL THEN
    ALTER TABLE public.automation_rule_logs DROP CONSTRAINT IF EXISTS automation_rule_logs_rule_id_fkey;
    UPDATE public.automation_rule_logs l SET rule_id = NULL
      WHERE l.rule_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.automation_rules r WHERE r.id = l.rule_id);
    ALTER TABLE public.automation_rule_logs
      ADD CONSTRAINT automation_rule_logs_rule_id_fkey
      FOREIGN KEY (rule_id) REFERENCES public.automation_rules(id) ON DELETE SET NULL;
  END IF;
END $$;`)
  }

  override async down(): Promise<void> {
    // Not reversible without losing history rows whose rule was deleted
    // (rule_id NULL); leave the relaxed schema in place.
  }
}
