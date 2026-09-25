/* Billing showed each credit package 15 times: the global catalog had no
 * unique key, so every setup-tables.sql run re-seeded it. The migration must
 * dedupe BEFORE it adds the unique constraint, or the constraint fails. */
import {
  Migration20260925103100_billing,
  DEDUPE_CREDIT_PACKAGES_SQL,
  UNIQUE_CREDIT_PACKAGE_NAME_SQL,
} from '../migrations/Migration20260925103100_billing'

describe('Migration20260925103100_billing', () => {
  it('dedupes by name, then adds the unique constraint idempotently', async () => {
    const migration = Object.create(Migration20260925103100_billing.prototype) as Migration20260925103100_billing
    const sql: string[] = []
    ;(migration as unknown as { addSql: (s: string) => void }).addSql = (s: string) => { sql.push(s) }
    await migration.up()
    expect(sql).toEqual([DEDUPE_CREDIT_PACKAGES_SQL, UNIQUE_CREDIT_PACKAGE_NAME_SQL])
    expect(DEDUPE_CREDIT_PACKAGES_SQL).toMatch(/partition by "name"/)
    expect(DEDUPE_CREDIT_PACKAGES_SQL).toMatch(/rn > 1/)
    expect(UNIQUE_CREDIT_PACKAGE_NAME_SQL).toMatch(/if not exists/)
    expect(UNIQUE_CREDIT_PACKAGE_NAME_SQL).toMatch(/unique \("name"\)/)
  })
})
