import { Migration } from '@mikro-orm/migrations'

/* Public links resolve by slug/token with no organisation in the URL, and
 * every Noli customer shares one tenant, so the existing per-organisation
 * uniqueness let one customer's public link resolve to another customer's
 * record. These are global unique indexes on the public lookup columns.
 *
 * Each index first checks the live data: if any duplicate exists the
 * migration FAILS LOUDLY (RAISE EXCEPTION) naming the table, column and a
 * duplicate value, instead of silently skipping. Resolve duplicates first
 * (scripts/sql/public-slug-duplicates.sql lists them), then re-run.
 * A table or column that does not exist in this database is skipped with a
 * NOTICE (these legacy tables are not created by migrations). Idempotent. */
function globalUniqueIndexSql(opts: { table: string; column: string; index: string; where?: string }): string {
  const where = opts.where ? ` WHERE ${opts.where}` : ''
  return `DO $$
DECLARE dup record;
BEGIN
  IF to_regclass('public.${opts.table}') IS NULL THEN
    RAISE NOTICE 'skip ${opts.index}: table ${opts.table} does not exist';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${opts.table}' AND column_name = '${opts.column}') THEN
    RAISE NOTICE 'skip ${opts.index}: column ${opts.table}.${opts.column} does not exist';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = '${opts.index}') THEN
    RETURN;
  END IF;
  SELECT "${opts.column}"::text AS value, count(*) AS n INTO dup
    FROM "${opts.table}"${where}
    GROUP BY "${opts.column}" HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Cannot add global unique index ${opts.index}: ${opts.table}.${opts.column} has duplicate value "%" (% rows). Public links would be ambiguous across organizations; resolve the duplicates (scripts/sql/public-slug-duplicates.sql) and re-run.', dup.value, dup.n;
  END IF;
  CREATE UNIQUE INDEX "${opts.index}" ON "${opts.table}" ("${opts.column}")${where};
END $$;`
}

export class Migration20260924200000_landing_pages extends Migration {
  override async up(): Promise<void> {
    this.addSql(globalUniqueIndexSql({ table: 'landing_pages', column: 'slug', index: 'landing_pages_slug_global_uniq', where: 'deleted_at IS NULL' }))
    this.addSql(globalUniqueIndexSql({ table: 'funnels', column: 'slug', index: 'funnels_slug_global_uniq' }))
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "landing_pages_slug_global_uniq";`)
    this.addSql(`DROP INDEX IF EXISTS "funnels_slug_global_uniq";`)
  }
}
