/**
 * Migrations must be self-contained.
 *
 * The production runner image loads migration files from source; an import of
 * a sibling lib file (`../lib/...`) fails there with "Cannot find module" and
 * aborts `mercato db migrate` (it broke Migration20260926120000 in rehearsal
 * and Migration20260925120000 before it). So a file under any `migrations/`
 * folder may import only packages (e.g. @mikro-orm/migrations) and relative
 * paths that stay inside its own migrations folder.
 *
 * The two migrations whose SQL is also used by scripts keep an inlined copy;
 * this test pins each copy to its lib source so they cannot drift.
 */
import fs from 'node:fs'
import path from 'node:path'
import { MikroORM } from '@mikro-orm/postgresql'
import { SEARCH_INDEX_DOWN_SQL, SEARCH_INDEX_SCHEMA_SQL, searchIndexPurgeSql } from '../modules/customers/lib/searchIndexSchema'
import { TENANT_SPLIT_SCHEMA_DOWN_SQL, TENANT_SPLIT_SCHEMA_SQL } from '../modules/directory/lib/tenantSplitSchema'
import { Migration20260925120000 } from '../modules/customers/migrations/Migration20260925120000'
import { Migration20260926120000 } from '../modules/directory/migrations/Migration20260926120000'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const SCAN_ROOTS = ['packages', 'apps'].map((d) => path.join(REPO_ROOT, d))

function migrationFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string, inMigrations: boolean) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, inMigrations || entry.name === 'migrations')
      else if (inMigrations && /\.(ts|js|mjs|cjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full)
    }
  }
  for (const root of SCAN_ROOTS) if (fs.existsSync(root)) walk(root, false)
  return out
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g

describe('migrations are self-contained', () => {
  const files = migrationFiles()

  it('finds the migration folders', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('imports nothing outside its own migrations folder', () => {
    const offenders: string[] = []
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      const dir = path.dirname(file)
      const migrationsRoot = dir.slice(0, dir.lastIndexOf(`${path.sep}migrations`) + `${path.sep}migrations`.length)
      for (const m of text.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2]
        if (!spec) continue
        if (spec.startsWith('.')) {
          const target = path.resolve(dir, spec)
          if (!target.startsWith(migrationsRoot + path.sep)) offenders.push(`${path.relative(REPO_ROOT, file)} -> ${spec}`)
        } else if (spec.startsWith('@/') || spec.startsWith('#')) {
          offenders.push(`${path.relative(REPO_ROOT, file)} -> ${spec}`)
        } else if (spec.startsWith('@open-mercato/')) {
          // workspace source imports resolve the same way the runner cannot
          offenders.push(`${path.relative(REPO_ROOT, file)} -> ${spec}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  const sqlOf = async (Cls: any) => {
    const orm = await MikroORM.init({ dbName: 'unused', entities: [], discovery: { warnWhenNoEntities: false }, connect: false } as any)
    try {
      const up = new Cls(orm.em.getDriver(), orm.config)
      await up.up()
      const upSql = up.getQueries().map((q: any) => (typeof q === 'string' ? q : q.sql ?? String(q)))
      const down = new Cls(orm.em.getDriver(), orm.config)
      await down.down()
      const downSql = down.getQueries().map((q: any) => (typeof q === 'string' ? q : q.sql ?? String(q)))
      return { upSql, downSql }
    } finally {
      await orm.close(true)
    }
  }

  it('the inlined blind-search-index SQL matches lib/searchIndexSchema', async () => {
    const { upSql, downSql } = await sqlOf(Migration20260925120000)
    expect(upSql).toEqual([...SEARCH_INDEX_SCHEMA_SQL, ...searchIndexPurgeSql()])
    expect(downSql).toEqual(SEARCH_INDEX_DOWN_SQL)
  })

  it('the inlined tenant-split SQL matches lib/tenantSplitSchema', async () => {
    const { upSql, downSql } = await sqlOf(Migration20260926120000)
    expect(upSql).toEqual(TENANT_SPLIT_SCHEMA_SQL)
    expect(downSql).toEqual(TENANT_SPLIT_SCHEMA_DOWN_SQL)
  })
})
