import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DEFAULT_ENCRYPTION_MAPS } from '@open-mercato/core/modules/entities/lib/encryptionDefaults'
import { CONTACT_BACKFILL_TABLES } from '@open-mercato/shared/lib/encryption/plaintextBackfill'

/**
 * Raw reads of encrypted-by-design columns must decrypt what they read.
 *
 * Contact, person, company, deal, activity, comment and address fields are
 * AES-GCM envelopes at rest. A raw knex / SQL read returns the envelope, and
 * on 2026-09-24 about 45 places used it as if it were the value: invoices and
 * surveys addressed to ciphertext, AI prompts fed ciphertext, bounce
 * suppression that never matched. Two rules keep that from coming back:
 *
 * 1. No value comparison on an encrypted column in SQL (`where('primary_email',
 *    x)`, `lower(primary_email) = ?`, `display_name ILIKE ...`). It can never
 *    match ciphertext. Match on primary_email_hash / primary_phone_hash via
 *    customers/lib/contact-lookup.ts, or decrypt and compare in memory.
 * 2. A file that selects an encrypted column through raw knex / SQL must also
 *    decrypt (decryptRowFields and friends, decryptEntityPayload, the
 *    *WithDecryption finders, or a local decrypt helper).
 *
 * Rule 2 is per file: it catches the file that never decrypts, not a second
 * read in a file that decrypts elsewhere. Mapped columns come from the
 * encryption defaults, so a newly mapped field is covered automatically.
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

const MAPPED: Record<string, string[]> = {}
for (const { entityId, table } of CONTACT_BACKFILL_TABLES) {
  MAPPED[table] = (DEFAULT_ENCRYPTION_MAPS.find((m) => m.entityId === entityId)?.fields ?? []).map((f) => f.field)
}
const TABLES = Object.keys(MAPPED)
const CONTACT_LOOKUP_COLUMNS = ['primary_email', 'primary_phone', 'display_name']

/** Files that read ciphertext on purpose, each with its reason. */
const ALLOWED: Record<string, string> = {
  'packages/core/src/modules/entities/cli.ts': 'decrypt-database / rotate-encryption-key read the stored envelopes by design',
  'packages/core/src/modules/customers/cli.ts': 'seed/stress CLIs generate rows, never read values for use',
  'packages/shared/src/lib/encryption/plaintextBackfill.ts': 'the backfill classifies stored values (envelope vs plaintext) by design',
  'packages/core/src/modules/customers/lib/contactDataCleanup.ts':
    'passes the already-encrypted comment row (row.body is ciphertext) to its insert; never reads a stored value',
  // The shared lookups: hash first, plaintext arm only for legacy hash-less rows.
  'apps/mercato/src/modules/customers/lib/contact-lookup.ts': 'the lookup helper: hash match plus the legacy plaintext arm',
  'apps/mercato/src/modules/customers/lib/dedup.ts': 'findOrMergeContact / findContactByPhone: hash, legacy arm, then decrypt-scan',
  'apps/mercato/src/modules/email/lib/signature-enrichment.ts':
    'reads primary_phone / job_title only to test presence (fill-if-missing); its writes go through encryptRowForRawWrite',
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '__tests__', 'migrations', 'dist', 'generated'].includes(name) || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full)
  }
}

const lineOf = (src: string, i: number) => src.slice(0, i).split('\n').length

/** Aliases the file gives encrypted tables (`customer_entities as ce` -> ce). */
function encryptedAliases(src: string): Map<string, string> {
  const aliasRe = new RegExp(`['"\`\\s](${TABLES.join('|')})(?:\\s+(?:as\\s+)?(\\w+))?['"\`\\s)]`, 'gi')
  const aliases = new Map<string, string>()
  for (const t of TABLES) aliases.set(t, t)
  for (const m of src.matchAll(aliasRe)) {
    const table = m[1]!.toLowerCase()
    const alias = m[2] && !/^(where|on|set|join|left|inner|order|group|limit|values|select)$/i.test(m[2]) ? m[2] : null
    if (alias) aliases.set(alias, table)
  }
  return aliases
}

/** Rule 1: value comparisons on encrypted contact columns. */
function valueLookups(src: string): string[] {
  const hits: string[] = []
  const aliases = encryptedAliases(src)
  const cols = CONTACT_LOOKUP_COLUMNS.join('|')
  const patterns: RegExp[] = [
    // knex builder: .where('primary_email', x) / .where('ce.primary_email', ...) / whereIn / orWhere / whereILike
    new RegExp(`\\.(?:where|andWhere|orWhere|whereIn|whereNot|whereILike|whereLike)\\(\\s*['"\`](?:\\w+\\.)?(?:${cols})['"\`]\\s*,`, 'g'),
    // SQL text: lower(primary_email) =, primary_email = ?, display_name ilike, regexp_replace(primary_phone
    new RegExp(`lower\\(\\s*(?:\\w+\\.)?(?:${cols})\\s*\\)\\s*(?:=|in\\b|like|ilike)`, 'gi'),
    new RegExp(`(?:^|[\\s(,])(?:\\w+\\.)?(?:${cols})\\s+(?:i?like)\\b`, 'gim'),
    new RegExp(`(?:^|[\\s(])(?:\\w+\\.)?(?:${cols})\\s*=\\s*(?:\\?|\\$\\d)`, 'gim'),
    new RegExp(`regexp_replace\\(\\s*(?:coalesce\\()?\\s*(?:\\w+\\.)?primary_phone`, 'gi'),
    // SQL concatenation inside a LIKE pattern: '%' || ce.primary_email || '%'
    new RegExp(`'%'\\s*\\|\\|\\s*(?:\\w+\\.)?(?:${cols})\\b`, 'gi'),
  ]
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const i = m.index!
      // A qualified column of a table that is not encrypted (inbox_conversations.display_name).
      const qual = new RegExp(`(\\w+)\\.(?:${cols})\\b`).exec(m[0])
      if (qual && !aliases.has(qual[1]!)) continue
      // An assignment in UPDATE ... SET col = $1 (the write guard covers writes).
      const before = src.slice(Math.max(0, i - 200), i)
      const set = before.search(/\bSET\b(?![\s\S]*\bWHERE\b)/i)
      if (set >= 0) continue
      // The legacy plaintext arm of a hash lookup: same statement names the hash column.
      if (/_hash\b/.test(src.slice(Math.max(0, i - 400), i + 400))) continue
      hits.push(`line ${lineOf(src, i)}: ${m[0].trim()}`)
    }
  }
  return hits
}

/** Rule 2: does the file select an encrypted column through raw knex / SQL? */
function rawEncryptedSelects(src: string): string[] {
  const hits: string[] = []
  // Presence checks (whereNull / whereNotNull) read no value.
  src = src.replace(/\.(?:whereNull|whereNotNull|orWhereNull|orWhereNotNull)\([^)]*\)/g, '')
  const aliases = encryptedAliases(src)
  for (const t of TABLES) aliases.delete(t)
  // knex builder chains rooted at an encrypted table: .select('col', ...) / .first(...)
  const chainRe = new RegExp(`\\(\\s*['"\`](${TABLES.join('|')})(?:\\s+as\\s+(\\w+))?['"\`]\\s*\\)`, 'g')
  for (const m of src.matchAll(chainRe)) {
    const table = m[1]!
    const after = src.slice(m.index! + m[0].length)
    const end = after.search(/;\s*\n|\n\s*\n/)
    const chain = end >= 0 ? after.slice(0, end) : after
    if (/\.(?:insert|update|del|delete|count|increment|decrement)\(/.test(chain)) continue
    const select = /\.(?:select|first|pluck)\(([^)]*)\)/.exec(chain)
    if (!select) continue
    const args = select[1]!
    for (const col of MAPPED[table]!) {
      if (new RegExp(`['"\`](?:\\w+\\.)?${col}(?:\\s+as\\s+\\w+)?['"\`]`).test(args)) {
        hits.push(`line ${lineOf(src, m.index!)}: ${table}.${col}`)
      }
    }
  }
  // Qualified columns of an aliased encrypted table anywhere (joins, raw SQL, selects).
  for (const [alias, table] of aliases) {
    for (const col of MAPPED[table]!) {
      const re = new RegExp(`['"\`\\s,(]${alias}\\.${col}\\b`, 'g')
      for (const m of src.matchAll(re)) hits.push(`line ${lineOf(src, m.index!)}: ${alias}.${col} (${table})`)
    }
  }
  return hits
}

const DECRYPTS = /\bdecrypt\w*\s*\(|find(?:One)?WithDecryption\s*\(|WithDecryption\b/

function sourceFiles(): string[] {
  const files: string[] = []
  for (const root of ROOTS) { try { walk(root, files) } catch { /* optional */ } }
  return files
}

describe('raw reads of encrypted-by-design columns', () => {
  it('flags the shapes that broke on 2026-09-24', () => {
    expect(valueLookups("await knex('customer_entities').where('primary_email', email).update({})")).not.toEqual([])
    expect(valueLookups("q.whereRaw('LOWER(primary_email) = ?', [e])")).not.toEqual([])
    expect(valueLookups("knex('customer_entities as ce').whereRaw('lower(ce.primary_email) = any(?)', [list])")).not.toEqual([])
    expect(valueLookups("`... where display_name ILIKE ?`")).not.toEqual([])
    expect(valueLookups("knex('customer_entities as ce') ... ilike '%' || ce.primary_email || '%'")).not.toEqual([])
    expect(valueLookups("q.whereRaw(\"regexp_replace(primary_phone, '\\\\D', '', 'g') like ?\", [x])")).not.toEqual([])
    // Not encrypted tables, SET assignments and hash-guarded legacy arms pass.
    expect(valueLookups("knex('inbox_conversations').where('inbox_conversations.display_name', n)")).toEqual([])
    expect(valueLookups("`UPDATE customer_entities SET primary_phone = $1, primary_phone_hash = $2 WHERE id = $3`")).toEqual([])
    expect(valueLookups("q.where('primary_email_hash', h).orWhere(function () { this.whereNull('primary_email_hash').whereRaw('lower(primary_email) = ?', [e]) })")).toEqual([])
    expect(valueLookups("whereContactEmail(knex('customer_entities'), email).where('organization_id', o)")).toEqual([])
    expect(valueLookups("q.where('primary_email_hash', h)")).toEqual([])

    expect(rawEncryptedSelects("knex('customer_deals').where('id', id).select('title', 'status')")).not.toEqual([])
    expect(rawEncryptedSelects("knex('x as a').join('customer_entities as ce', 'ce.id', 'a.c').select('ce.display_name as contact_name')")).not.toEqual([])
    expect(rawEncryptedSelects("query(`SELECT ce.primary_email FROM customer_entities ce WHERE ce.id = $1`)")).not.toEqual([])
    expect(rawEncryptedSelects("knex('customer_deals').where('id', id).select('id', 'status')")).toEqual([])
    expect(rawEncryptedSelects("knex('customer_entities').where('id', id).update({ lifecycle_stage: s })")).toEqual([])
  })

  it('has no SQL value comparison on an encrypted contact column', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      const rel = relative(REPO, file)
      if (ALLOWED[rel]) continue
      for (const hit of valueLookups(readFileSync(file, 'utf8'))) offenders.push(`${rel} ${hit}`)
    }
    expect(offenders).toEqual([])
  })

  it('every file that raw-selects an encrypted column also decrypts', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      const rel = relative(REPO, file)
      if (ALLOWED[rel]) continue
      const src = readFileSync(file, 'utf8')
      const hits = rawEncryptedSelects(src)
      if (hits.length && !DECRYPTS.test(src)) offenders.push(`${rel} (${hits.slice(0, 3).join('; ')})`)
    }
    expect(offenders).toEqual([])
  })
})
