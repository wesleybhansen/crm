#!/usr/bin/env node
// Raw-SQL organization-filter guard (REPORT-ONLY for now; see the plan
// "one tenant per customer", section 6). With every customer in its own
// tenant, the last line of defence inside a tenant is still the organization
// filter, and raw SQL is where it goes missing.
//
// Scans .ts files for raw SQL: `query(` / `queryOne(` / `knex.raw(` /
// `.execute(` template strings, and `knex('<table>')` chains. A statement that
// touches a table listed in scripts/registry/org-scoped-tables.json (every
// table with an organization_id column) must mention organization_id or
// tenant_id; a knex chain must have a .where on one of them within the chain.
//
// Exemptions:
//   // ORG-FILTER-EXEMPT: <reason>        on the statement's line or the line above
//   // ORG-FILTER-EXEMPT-FILE: <reason>   anywhere in the file (lookups by id or
//                                          public slug that re-scope from the row)
//
// Usage:
//   node scripts/check-org-filter.mjs                 # report on every file (exit 0)
//   node scripts/check-org-filter.mjs --base origin/main   # only files changed since <base>
//   node scripts/check-org-filter.mjs --enforce       # exit 1 on findings (after the report-only week)
//   DATABASE_URL=... node scripts/check-org-filter.mjs --generate-registry
//                                                     # refresh the table list from information_schema

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const REGISTRY = resolve(REPO_ROOT, 'scripts/registry/org-scoped-tables.json')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

async function generateRegistry() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is required for --generate-registry')
    process.exit(2)
  }
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const { rows } = await client.query(
      `select distinct c.table_name from information_schema.columns c
         join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = current_schema() and t.table_type = 'BASE TABLE' and c.column_name = 'organization_id'
        order by 1`,
    )
    const tables = rows.map((r) => r.table_name)
    writeFileSync(REGISTRY, JSON.stringify({ generatedFrom: 'information_schema (organization_id columns)', tables }, null, 2) + '\n')
    console.log(`wrote ${tables.length} tables to ${relative(REPO_ROOT, REGISTRY)}`)
  } finally {
    await client.end()
  }
}

function listFiles() {
  const base = value('--base')
  const roots = ['apps/mercato/src/modules', 'packages']
  const accept = (f) =>
    f.endsWith('.ts') &&
    !f.includes('/__tests__/') &&
    !f.includes('/__integration__/') &&
    !f.includes('/migrations/') &&
    !f.includes('/node_modules/') &&
    !f.includes('/dist/') &&
    !f.endsWith('.test.ts') &&
    !f.endsWith('.d.ts') &&
    (f.startsWith('apps/mercato/src/modules/') || /^packages\/[^/]+\/src\//.test(f))
  if (base) {
    let out = ''
    try {
      out = execSync(`git diff --name-only --diff-filter=AM ${base}...HEAD`, { cwd: REPO_ROOT, encoding: 'utf8' })
    } catch {
      console.log(`[org-filter] base ${base} is not available (shallow checkout?); nothing to scan`)
      return []
    }
    return out.split('\n').filter(Boolean).filter(accept)
  }
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else {
        const rel = relative(REPO_ROOT, p)
        if (accept(rel)) files.push(rel)
      }
    }
  }
  for (const r of roots) if (existsSync(resolve(REPO_ROOT, r))) walk(resolve(REPO_ROOT, r))
  return files
}

const TABLE_REF = /\b(?:from|join|update|into)\s+"?([a-z_][a-z0-9_]*)"?/gi
const SCOPE = /\b(organization_id|tenant_id|organizationId|tenantId)\b/

/** Template-literal / string SQL passed to a raw query call. */
const RAW_CALL = /\b(?:query|queryOne|raw|execute)\s*(?:<[^>]*>)?\s*\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g
/** knex('table') / knex.table('table') / trx('table') chain start. */
const KNEX_CHAIN = /\b(?:knex|trx|tx|db)\s*\(\s*['"`]([a-z_][a-z0-9_]*)['"`]\s*\)/g

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

function exempt(lines, line) {
  const here = lines[line - 1] ?? ''
  const above = lines[line - 2] ?? ''
  return /ORG-FILTER-EXEMPT:/.test(here) || /ORG-FILTER-EXEMPT:/.test(above)
}

function scanFile(file, orgTables) {
  const text = readFileSync(resolve(REPO_ROOT, file), 'utf8')
  if (/ORG-FILTER-EXEMPT-FILE:/.test(text)) return []
  const lines = text.split('\n')
  const findings = []
  for (const m of text.matchAll(RAW_CALL)) {
    const sql = m[1]
    if (!/\b(select|update|delete|insert)\b/i.test(sql)) continue
    const tables = [...sql.matchAll(TABLE_REF)].map((t) => t[1].toLowerCase()).filter((t) => orgTables.has(t))
    if (!tables.length) continue
    if (/^\s*[`'"]\s*insert\b/i.test(sql)) continue // an insert writes its own scope columns
    if (SCOPE.test(sql)) continue
    const line = lineOf(text, m.index)
    if (exempt(lines, line)) continue
    findings.push({ file, line, kind: 'raw sql', tables: [...new Set(tables)] })
  }
  for (const m of text.matchAll(KNEX_CHAIN)) {
    const table = m[1].toLowerCase()
    if (!orgTables.has(table)) continue
    // The chain: up to the end of the statement (first `;` or blank line), capped.
    const rest = text.slice(m.index, m.index + 1500)
    const end = rest.search(/;\s*\n|\n\s*\n/)
    const chain = end >= 0 ? rest.slice(0, end) : rest
    if (/\.insert\s*\(/.test(chain) && !/\.(where|update|del|delete)\s*\(/.test(chain)) continue
    if (SCOPE.test(chain)) continue
    const line = lineOf(text, m.index)
    if (exempt(lines, line)) continue
    findings.push({ file, line, kind: 'knex chain', tables: [table] })
  }
  return findings
}

async function main() {
  if (flag('--generate-registry')) return generateRegistry()
  if (!existsSync(REGISTRY)) {
    console.error(`[org-filter] ${relative(REPO_ROOT, REGISTRY)} missing: run with --generate-registry`)
    process.exit(flag('--enforce') ? 2 : 0)
  }
  const orgTables = new Set(JSON.parse(readFileSync(REGISTRY, 'utf8')).tables)
  const files = listFiles()
  const findings = files.flatMap((f) => scanFile(f, orgTables))
  const byFile = new Map()
  for (const f of findings) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1)
  console.log(`[org-filter] scanned ${files.length} files against ${orgTables.size} org-scoped tables: ${findings.length} statements without an organization/tenant filter in ${byFile.size} files`)
  const limit = Number(value('--limit') ?? 200)
  for (const f of findings.slice(0, limit)) {
    console.log(`  ${f.file}:${f.line}  ${f.kind}  ${f.tables.join(',')}`)
  }
  if (findings.length > limit) console.log(`  ... ${findings.length - limit} more (--limit N)`)
  if (findings.length) {
    console.log('[org-filter] add the org/tenant predicate, or mark a lookup that re-scopes from the row with // ORG-FILTER-EXEMPT: <reason>')
  }
  if (flag('--enforce') && findings.length) process.exit(1)
}

main().catch((err) => {
  console.error('[org-filter] failed:', err?.message ?? err)
  process.exit(flag('--enforce') ? 1 : 0)
})
