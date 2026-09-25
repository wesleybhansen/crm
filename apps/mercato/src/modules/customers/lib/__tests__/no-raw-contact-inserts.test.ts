import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DEFAULT_ENCRYPTION_MAPS } from '@open-mercato/core/modules/entities/lib/encryptionDefaults'
import { CONTACT_BACKFILL_TABLES } from '@open-mercato/shared/lib/encryption/plaintextBackfill'

/**
 * Contact rows must be written through the ORM (createPersonContact or
 * em.create) so the tenant-data encryption subscriber runs. A raw knex insert
 * stores names and emails in plaintext and can never dedupe against encrypted
 * rows. Nine such sites existed on 2026-09-08; this test keeps them from
 * coming back.
 */
const APP_SRC = join(__dirname, '../../../../')
const PACKAGES = join(__dirname, '../../../../../../../packages')
const REPO = join(PACKAGES, '..')
const ROOTS = [
  APP_SRC,
  // Every package, not just core: the AI assistant, MCP tools and enterprise
  // modules can all write contact data.
  ...readdirSync(PACKAGES)
    .map((name) => join(PACKAGES, name, 'src'))
    .filter((dir) => {
      try { return statSync(dir).isDirectory() } catch { return false }
    }),
]
// Three shapes write PII around the encrypting ORM path: the knex builder, a
// transaction/builder variable, and raw SQL. All three are forbidden.
const PATTERN = /(?:(?:knex|trx|\bem\.getKnex\(\))\s*\(\s*(?:'|")customer_(?:entities|people|companies)(?:'|")\s*\)\s*\.insert\(|INSERT\s+INTO\s+customer_(?:entities|people|companies)\b)/i

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'migrations' || name === 'dist' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full)
  }
}

function sourceFiles(): string[] {
  const files: string[] = []
  for (const root of ROOTS) {
    try { walk(root, files) } catch { /* optional root */ }
  }
  return files
}

describe('contact writes go through the ORM', () => {
  it('has no raw knex inserts into the contact tables', () => {
    const offenders = sourceFiles().filter((f) => PATTERN.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})

/* ------------------------------------------------------------------------- *
 * Raw writes of encrypted-by-design columns
 *
 * The contact insert rule above is not enough: raw UPDATEs and raw inserts
 * into the related tables (activities, deals, comments, addresses) put the
 * same PII on disk in plaintext. Found on 2026-09-24: signature enrichment
 * (phone, job title), and the activity log written by public forms, landing
 * pages, automations and contact merge (subject, body).
 *
 * A raw write may carry a mapped column only when its row came out of
 * encryptRowForRawWrite (packages/shared/src/lib/encryption/rawWrite.ts). The
 * mapped columns are read from the encryption defaults, so a newly mapped
 * field is covered without touching this test.
 * ------------------------------------------------------------------------- */

const MAPPED_COLUMNS: Record<string, Set<string>> = {}
for (const { entityId, table } of CONTACT_BACKFILL_TABLES) {
  const map = DEFAULT_ENCRYPTION_MAPS.find((m) => m.entityId === entityId)
  MAPPED_COLUMNS[table] = new Set((map?.fields ?? []).map((f) => f.field))
}
const TABLES = Object.keys(MAPPED_COLUMNS)

/** Deliberate plaintext writers. Each needs a reason. */
const ALLOWED: Record<string, string> = {
  // `mercato entities decrypt-database`: turning encryption off for a tenant is its whole job.
  'packages/core/src/modules/entities/cli.ts': 'decrypt-database writes plaintext on purpose',
  // `mercato customers seed-stresstest`: synthetic load-test rows, never customer data.
  'packages/core/src/modules/customers/cli.ts': 'seed-stresstest writes generated fixtures',
  // Legacy-note merge: each customer_comments row comes out of the injected
  // encryptComment (encryptEntityPayload with requireMap, fails closed).
  'packages/core/src/modules/customers/lib/contactDataCleanup.ts': 'merged comment rows are encrypted by the injected fail-closed encryptor',
}

/** Text of the balanced (...) / {...} / [...] group that starts at `open`. */
function balanced(src: string, open: number): string {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' }
  const stack: string[] = []
  let quote: string | null = null
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (pairs[ch]) stack.push(pairs[ch]!)
    else if (stack.length && ch === stack[stack.length - 1]) {
      stack.pop()
      if (!stack.length) return src.slice(open, i + 1)
    }
  }
  return src.slice(open)
}

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length

function encryptedNearby(src: string, index: number): boolean {
  const before = src.slice(Math.max(0, src.lastIndexOf('\n', index - 1) - 1200), index)
  return /encryptRow(?:ForRawWrite)?\s*\(/.test(before)
}

function findRawMappedWrites(file: string, src: string): string[] {
  const hits: string[] = []
  const tableAlt = TABLES.join('|')

  // knex builder: knex('customer_x')....insert({...}) / .update({...})
  const builder = new RegExp(`\\(\\s*['"\`](${tableAlt})['"\`]\\s*\\)`, 'g')
  for (const m of src.matchAll(builder)) {
    const table = m[1]!
    const after = src.slice(m.index! + m[0].length)
    const chainEnd = after.search(/;\s*\n|\n\s*\n/)
    const chain = chainEnd >= 0 ? after.slice(0, chainEnd) : after
    const op = /\.(insert|update|batchInsert)\(\s*/.exec(chain)
    if (!op) continue
    const argStart = m.index! + m[0].length + op.index + op[0].length
    const first = src[argStart]
    // A variable argument is checked where it is built (it must come out of
    // encryptRowForRawWrite, which the literal rule below enforces).
    if (first !== '{' && first !== '[') continue
    const literal = balanced(src, argStart)
    for (const column of MAPPED_COLUMNS[table]!) {
      if (new RegExp(`(?:^|[\\s,{])['"]?${column}['"]?\\s*:`).test(literal)) {
        hits.push(`${file}:${lineOf(src, m.index!)} raw ${op[1]} into ${table}.${column}`)
      }
    }
  }

  // raw SQL: INSERT INTO customer_x (cols) / UPDATE customer_x SET col = ...
  const insertSql = new RegExp(`INSERT\\s+INTO\\s+"?(${tableAlt})"?\\s*\\(([^)]*)\\)`, 'gi')
  for (const m of src.matchAll(insertSql)) {
    const table = m[1]!.toLowerCase()
    const cols = m[2]!.split(',').map((c) => c.trim().replace(/"/g, ''))
    for (const column of cols) {
      if (MAPPED_COLUMNS[table]?.has(column) && !encryptedNearby(src, m.index!)) {
        hits.push(`${file}:${lineOf(src, m.index!)} raw SQL insert into ${table}.${column}`)
      }
    }
  }
  const updateSql = new RegExp(`UPDATE\\s+"?(${tableAlt})"?\\s+SET\\s+([\\s\\S]*?)(?:\\bWHERE\\b|\`|'|"\\s*[,)])`, 'gi')
  for (const m of src.matchAll(updateSql)) {
    const table = m[1]!.toLowerCase()
    for (const column of MAPPED_COLUMNS[table] ?? []) {
      if (new RegExp(`(?:^|[\\s,"])${column}"?\\s*=`).test(m[2]!) && !encryptedNearby(src, m.index!)) {
        hits.push(`${file}:${lineOf(src, m.index!)} raw SQL update of ${table}.${column}`)
      }
    }
  }
  return hits
}

describe('encrypted-by-design columns are never written raw in plaintext', () => {
  it('knows the mapped columns for every contact table', () => {
    expect(MAPPED_COLUMNS.customer_entities).toEqual(
      new Set(['display_name', 'primary_email', 'primary_phone', 'next_interaction_name', 'description']),
    )
    expect(MAPPED_COLUMNS.customer_activities).toEqual(new Set(['subject', 'body']))
    expect(MAPPED_COLUMNS.customer_deals).toEqual(new Set(['title', 'description']))
    expect(MAPPED_COLUMNS.customer_people.has('job_title')).toBe(true)
  })

  it('flags the shapes that leaked on 2026-09-24 and passes their fixed forms', () => {
    const leaked = [
      "await knex('customer_activities').insert({ id, tenant_id: t, subject: `x`, body: JSON.stringify(d) })",
      "await trx('customer_activities').insert({\n  organization_id: orgId,\n  subject: `Merged with ${name}`,\n})",
      "await query(`UPDATE customer_entities SET primary_phone = $1, updated_at = now() WHERE id = $2`, [p, id])",
      "await query(`UPDATE customer_people SET job_title = $1 WHERE entity_id = $2`, [t, id])",
      "await knex.raw('INSERT INTO customer_deals (id, title, status) VALUES (?, ?, ?)', [a, b, c])",
      "await knex('customer_deals').where('id', id).update({ title: t, updated_at: now })",
    ]
    for (const src of leaked) expect(findRawMappedWrites('x.ts', src)).not.toEqual([])

    const fine = [
      // Encrypted first, inserted by variable.
      "const row = await encryptRowForRawWrite('customers:customer_activity', { subject: s, body: b }, t, o)\nawait knex('customer_activities').insert(row)",
      "const enc = await encryptRow('customers:customer_entity', { primary_phone: p }, t, o)\nawait query(`UPDATE customer_entities SET primary_phone = $1, primary_phone_hash = $2 WHERE id = $3`, [enc.primary_phone, enc.primary_phone_hash, id])",
      // Unmapped columns are fine raw.
      "await knex('customer_entities').where('id', id).update({ lifecycle_stage: s, updated_at: now })",
      "await knex('customer_people').where('entity_id', id).update({ company_entity_id: c })",
      "await knex('customer_entities').update({ ai_summary: summary })",
    ]
    for (const src of fine) expect(findRawMappedWrites('x.ts', src)).toEqual([])
  })

  it('has no raw plaintext write of a mapped column anywhere in the app or packages', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      const rel = relative(REPO, file)
      if (ALLOWED[rel]) continue
      offenders.push(...findRawMappedWrites(rel, readFileSync(file, 'utf8')))
    }
    expect(offenders).toEqual([])
  })
})
