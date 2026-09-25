import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DEFAULT_ENCRYPTION_MAPS } from '@open-mercato/core/modules/entities/lib/encryptionDefaults'
import { CONTACT_BACKFILL_TABLES } from '@open-mercato/shared/lib/encryption/plaintextBackfill'
import { SEARCH_SOURCES } from '@open-mercato/shared/lib/encryption/searchIndex'

/**
 * Search on encrypted contact / company / deal / activity / comment / address
 * fields goes through the blind index (customer_search_tokens, see
 * customers/lib/blindSearch.ts), never LIKE / ILIKE.
 *
 * Those columns are AES-GCM envelopes with a random IV: `display_name ILIKE
 * '%ann%'` compares ciphertext and matches nothing, so every search written
 * that way silently returned no rows, and the stopgap that replaced it (decrypt
 * an organization's latest 2,000 contacts and filter in memory) missed every
 * older contact. This test fails the build on any LIKE-family match against an
 * encrypted column, in any of the shapes the codebase uses:
 *   - ORM / CRUD filters:  { display_name: { $ilike } }, filters.title = { $like }
 *   - knex builders:       .where('ce.primary_email', 'ilike', x), .whereILike('title', x)
 *   - raw SQL:             `display_name ILIKE ?`, lower(ce.primary_email) like, '%' || title
 * A second rule: a raw writer that encrypts a searchable field
 * (encryptRowForRawWrite on a contact / profile / deal) must refresh that row's
 * blind-index tokens, or search keeps finding the old value.
 */
const APP_SRC = join(__dirname, '../../../../')
const PACKAGES = join(__dirname, '../../../../../../../packages')
const REPO = join(PACKAGES, '..')
const ROOTS = [
  APP_SRC,
  ...readdirSync(PACKAGES)
    .map((name) => join(PACKAGES, name, 'src'))
    .filter((dir) => { try { return statSync(dir).isDirectory() } catch { return false } }),
]

const COLUMNS_BY_TABLE: Record<string, string[]> = {}
const ENTITY_IDS: string[] = []
for (const { entityId, table } of CONTACT_BACKFILL_TABLES) {
  COLUMNS_BY_TABLE[table] = (DEFAULT_ENCRYPTION_MAPS.find((m) => m.entityId === entityId)?.fields ?? []).map((f) => f.field)
  ENTITY_IDS.push(entityId)
}
const TABLES = Object.keys(COLUMNS_BY_TABLE)
const COLUMNS = Array.from(new Set(Object.values(COLUMNS_BY_TABLE).flat()))
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
const FIELD_NAMES = Array.from(new Set([...COLUMNS, ...COLUMNS.map(camel)]))
const ORM_CLASSES = ['CustomerEntity', 'CustomerPersonProfile', 'CustomerCompanyProfile', 'CustomerDeal', 'CustomerActivity', 'CustomerComment', 'CustomerAddress']

/** A file that works with an encrypted entity at all (ORM class, entity id, table). */
const TOUCHES_ENCRYPTED = new RegExp(
  `\\b(?:${ORM_CLASSES.join('|')})\\b|${ENTITY_IDS.map((e) => e.replace(':', '[:.]')).join('|')}|E\\.customers\\.customer_(?:entity|person_profile|company_profile|deal|activity|comment|address)\\b|['"\`\\s](?:${TABLES.join('|')})['"\`\\s]`,
)

const lineOf = (src: string, i: number) => src.slice(0, i).split('\n').length

/** Aliases the file gives encrypted tables (`customer_entities as ce` -> customer_entities). */
function aliases(src: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const t of TABLES) out.set(t, t)
  const re = new RegExp(`['"\`\\s(,](${TABLES.join('|')})(?:\\s+(?:as\\s+)?(\\w+))?['"\`\\s),]`, 'gi')
  for (const m of src.matchAll(re)) {
    const alias = m[2] && !/^(where|on|set|join|left|inner|order|group|limit|values|select|and|or|as)$/i.test(m[2]) ? m[2] : null
    if (alias) out.set(alias, m[1]!.toLowerCase())
  }
  return out
}

/** Is `col` (qualified by `alias` or not) an encrypted column of the table the statement reads? */
function encryptedColumn(src: string, index: number, alias: string | undefined, col: string, known: Map<string, string>): boolean {
  if (alias) {
    const table = known.get(alias)
    return Boolean(table && COLUMNS_BY_TABLE[table]?.includes(col))
  }
  // Unqualified: the statement's own table, looked up in the text just before.
  const before = src.slice(Math.max(0, index - 900), index)
  const stmtStart = Math.max(before.lastIndexOf(';'), before.lastIndexOf('\n\n'))
  const stmt = before.slice(stmtStart + 1)
  const tables = [...stmt.matchAll(new RegExp(`['"\`\\s(](${TABLES.join('|')})\\b`, 'g'))].map((m) => m[1]!)
  return tables.some((t) => COLUMNS_BY_TABLE[t]?.includes(col))
}

function likeOnEncrypted(src: string, file = ''): string[] {
  const hits: string[] = []
  const known = aliases(src)
  const cols = COLUMNS.join('|')

  // 1. ORM / CRUD filter objects, in files that work with an encrypted entity
  // (an encrypted ORM class, entity id or table, or any file of the customers
  // modules, where display_name / title / ... are the encrypted ones).
  if (TOUCHES_ENCRYPTED.test(src) || /modules\/customers\//.test(file)) {
    const fields = FIELD_NAMES.join('|')
    const objectFilter = new RegExp(
      `(?:['"]?\\b(${fields})['"]?\\s*:\\s*\\{\\s*\\$i?like\\b)|(?:filters?\\s*(?:\\.\\s*(${fields})|\\[\\s*['"](${fields})['"]\\s*\\])\\s*=\\s*\\{\\s*\\$i?like\\b)`,
      'g',
    )
    for (const m of src.matchAll(objectFilter)) hits.push(`line ${lineOf(src, m.index!)}: ${m[0].trim()}`)
  }

  // 2. knex builders.
  const builder = new RegExp(
    `\\.(?:where|andWhere|orWhere|whereNot|orWhereNot)\\(\\s*['"\`](?:(\\w+)\\.)?(${cols})['"\`]\\s*,\\s*['"\`](?:not\\s+)?i?like['"\`]`
      + `|\\.(?:whereILike|whereLike|orWhereILike|orWhereLike|andWhereILike|andWhereLike)\\(\\s*['"\`](?:(\\w+)\\.)?(${cols})['"\`]`,
    'gi',
  )
  for (const m of src.matchAll(builder)) {
    const alias = m[1] ?? m[3]
    const col = (m[2] ?? m[4])!
    if (encryptedColumn(src, m.index!, alias, col, known)) hits.push(`line ${lineOf(src, m.index!)}: ${m[0].trim()}`)
  }

  // 3. SQL text.
  const sql = new RegExp(
    `(?:lower\\(\\s*|unaccent\\(\\s*)?(?:(\\w+)\\.)?\\b(${cols})\\b\\s*\\)?\\s+(?:not\\s+)?i?like\\b`
      + `|'%'\\s*\\|\\|\\s*(?:(\\w+)\\.)?(${cols})\\b`,
    'gi',
  )
  for (const m of src.matchAll(sql)) {
    const alias = m[1] ?? m[3]
    const col = (m[2] ?? m[4])!.toLowerCase()
    if (encryptedColumn(src, m.index!, alias, col, known)) hits.push(`line ${lineOf(src, m.index!)}: ${m[0].trim()}`)
  }
  return hits
}

const SEARCH_SOURCE_IDS = SEARCH_SOURCES.map((s) => s.entityId)
const RAW_SEARCH_WRITE = new RegExp(`encryptRow(?:ForRawWrite)?\\(\\s*['"](?:${SEARCH_SOURCE_IDS.join('|')})['"]`)
const SEARCH_SYNC = /syncSearchTokensForValues|refreshSearchTokensForIds|syncSearch\(/

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '__tests__', '__integration__', 'migrations', 'dist', 'generated'].includes(name) || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full)
  }
}

function sourceFiles(): string[] {
  const files: string[] = []
  for (const root of ROOTS) { try { walk(root, files) } catch { /* optional */ } }
  return files
}

describe('search on encrypted columns uses the blind index, never LIKE', () => {
  it('recognises the shapes', () => {
    // ORM / CRUD filters in a customers file.
    expect(likeOnEncrypted("import { CustomerEntity } from 'x'\nfilters.display_name = { $ilike: `%${q}%` }")).not.toEqual([])
    expect(likeOnEncrypted("const E = 'customers:customer_deal'\nconst f = { title: { $ilike: '%a%' } }")).not.toEqual([])
    expect(likeOnEncrypted("em.find(CustomerTodoLink, { entity: { displayName: { $ilike: q } } })", 'packages/core/src/modules/customers/api/todos/route.ts')).not.toEqual([])
    expect(likeOnEncrypted("em.find(StaffTeamMember, { displayName: { $ilike: q } })", 'packages/core/src/modules/staff/api/x.ts')).toEqual([])
    expect(likeOnEncrypted("import { CustomerEntity } from 'x'\nfilters.primary_email = { $ilike: `${p}%` }")).not.toEqual([])
    // knex and SQL.
    expect(likeOnEncrypted("knex('customer_entities').where('display_name', 'ilike', `%${q}%`)")).not.toEqual([])
    expect(likeOnEncrypted("knex('customer_deals as cd').whereILike('cd.title', q)")).not.toEqual([])
    expect(likeOnEncrypted("query(`SELECT id FROM customer_entities WHERE display_name ILIKE $1`)")).not.toEqual([])
    expect(likeOnEncrypted("knex('customer_entities as ce').whereRaw('lower(ce.primary_email) like ?', [x])")).not.toEqual([])
    expect(likeOnEncrypted("`select * from customer_people p where p.job_title ilike '%' || $1`")).not.toEqual([])
    // Not encrypted: other tables, other entities, equality, hash columns.
    expect(likeOnEncrypted("knex('inbox_conversations').where('inbox_conversations.display_name', 'ilike', q)")).toEqual([])
    expect(likeOnEncrypted("knex('landing_pages').where('title', 'ilike', `%${q}%`)")).toEqual([])
    expect(likeOnEncrypted("em.find(ScheduledJob, { name: { $ilike: q } })")).toEqual([])
    expect(likeOnEncrypted("import { CustomerEntity } from 'x'\nfilters.status = { $ilike: q }")).toEqual([])
    expect(likeOnEncrypted("knex('customer_entities').where('primary_email_hash', h)")).toEqual([])
  })

  it('has no LIKE / ILIKE on an encrypted column anywhere', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8')
      for (const hit of likeOnEncrypted(src, relative(REPO, file))) offenders.push(`${relative(REPO, file)} ${hit}`)
    }
    expect(offenders).toEqual([])
  })

  it('raw writers of searchable fields refresh the blind index', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8')
      if (RAW_SEARCH_WRITE.test(src) && !SEARCH_SYNC.test(src)) offenders.push(relative(REPO, file))
    }
    expect(offenders).toEqual([])
  })
})
