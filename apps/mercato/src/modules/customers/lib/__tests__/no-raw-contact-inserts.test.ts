import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Contact rows must be written through the ORM (createPersonContact or
 * em.create) so the tenant-data encryption subscriber runs. A raw knex insert
 * stores names and emails in plaintext and can never dedupe against encrypted
 * rows. Nine such sites existed on 2026-09-08; this test keeps them from
 * coming back.
 */
const ROOTS = [join(__dirname, '../../../../'), join(__dirname, '../../../../../../../packages/core/src')]
// Three shapes write PII around the encrypting ORM path: the knex builder, a
// transaction/builder variable, and raw SQL. All three are forbidden.
const PATTERN = /(?:(?:knex|trx|\bem\.getKnex\(\))\s*\(\s*(?:'|")customer_(?:entities|people|companies)(?:'|")\s*\)\s*\.insert\(|INSERT\s+INTO\s+customer_(?:entities|people|companies)\b)/i

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full)
  }
}

describe('contact writes go through the ORM', () => {
  it('has no raw knex inserts into the contact tables', () => {
    const files: string[] = []
    for (const root of ROOTS) {
      try { walk(root, files) } catch { /* optional root */ }
    }
    const offenders = files.filter((f) => PATTERN.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
