/**
 * Build, check and repair the blind search index for encrypted contact,
 * company and deal fields (customer_search_tokens), and purge the plaintext
 * copies the Open Mercato query index / search module kept of those fields.
 *
 * Bundled by the Dockerfile builder stage into /app/scripts/reindex-customer-search.cjs
 * in the runner image (the mercato CLI cannot run there). Relative imports only.
 *
 *   node /app/scripts/reindex-customer-search.cjs                               # dry run: counts only
 *   node /app/scripts/reindex-customer-search.cjs --apply-migration --execute   # create table + triggers, purge leaks (only)
 *   node /app/scripts/reindex-customer-search.cjs --execute                     # backfill tokens
 *   node /app/scripts/reindex-customer-search.cjs --phase index-docs --execute  # encrypt plaintext in index docs
 *   node /app/scripts/reindex-customer-search.cjs --check                       # consistency check (exit 3 on drift)
 *   node /app/scripts/reindex-customer-search.cjs --check --execute             # repair drift + orphans
 *
 * Options: --phase tokens|index-docs|all (default tokens) --tenant <uuid> --org <uuid>
 *          --table customer_entities,customer_people,customer_companies,customer_deals
 *          --after-id <uuid> (resume inside one table) --batch-size <n> (default 200)
 *
 * Every run first prints read-only counts of plaintext-equivalent copies still
 * present (search_tokens, entity_indexes.search_text, vector_search).
 * Never prints a stored value or a token: counts, table names and row ids only.
 * Exit codes: 0 done / in sync, 2 refused (precondition), 3 drift remains or
 * verification failed (batch rolled back), 1 other error.
 */
import { Pool, type PoolClient } from 'pg'
import { createKmsService } from '../packages/shared/src/lib/encryption/kms'
import { TenantDataEncryptionService } from '../packages/shared/src/lib/encryption/tenantDataEncryptionService'
import { BackfillRefusedError, assertBackfillEnvironment } from '../packages/shared/src/lib/encryption/plaintextBackfill'
import { SEARCH_SOURCES, type SearchSql } from '../packages/shared/src/lib/encryption/searchIndex'
import {
  SearchIndexVerificationError,
  formatSearchIndexReport,
  runSearchIndexJob,
  searchIndexDrift,
  type SearchBackfillDb,
} from '../packages/shared/src/lib/encryption/searchIndexBackfill'
import {
  SEARCH_INDEX_MIGRATION_NAME,
  SEARCH_INDEX_SCHEMA_SQL,
  searchIndexLeakCountSql,
  searchIndexPurgeSql,
} from '../packages/core/src/modules/customers/lib/searchIndexSchema'
import { formatIndexDocReport, runIndexDocEncryption } from '../packages/shared/src/lib/encryption/searchIndexDocs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Phase = 'tokens' | 'index-docs' | 'all'

export type Args = {
  execute: boolean
  check: boolean
  applyMigration: boolean
  phase: Phase
  tenantId: string | null
  organizationId: string | null
  tables: string[]
  afterId: string | null
  batchSize: number
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    execute: false, check: false, applyMigration: false, phase: 'tokens',
    tenantId: null, organizationId: null, tables: [], afterId: null, batchSize: 200,
  }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new BackfillRefusedError(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    const [flag, inline] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined]
    const take = () => (inline !== undefined ? inline : value(i++, flag))
    switch (flag) {
      case '--execute': args.execute = true; break
      case '--dry-run': args.execute = false; break
      case '--check': args.check = true; break
      case '--apply-migration': args.applyMigration = true; break
      case '--phase': {
        const p = take()
        if (p !== 'tokens' && p !== 'index-docs' && p !== 'all') throw new BackfillRefusedError('--phase must be tokens, index-docs or all')
        args.phase = p
        break
      }
      case '--tenant': args.tenantId = take(); break
      case '--org': args.organizationId = take(); break
      case '--table': args.tables.push(...take().split(',').map((s) => s.trim()).filter(Boolean)); break
      case '--after-id': args.afterId = take(); break
      case '--batch-size': args.batchSize = Number.parseInt(take(), 10); break
      default: throw new BackfillRefusedError(`Unknown option ${raw}`)
    }
  }
  for (const [name, v] of [['--tenant', args.tenantId], ['--org', args.organizationId], ['--after-id', args.afterId]] as const) {
    if (v && !UUID_RE.test(v)) throw new BackfillRefusedError(`${name} must be a uuid`)
  }
  if (!Number.isFinite(args.batchSize) || args.batchSize < 1 || args.batchSize > 5000) {
    throw new BackfillRefusedError('--batch-size must be 1..5000')
  }
  const known = new Set(SEARCH_SOURCES.map((s) => s.table))
  for (const t of args.tables) if (!known.has(t)) throw new BackfillRefusedError(`Unknown --table ${t}`)
  if (args.afterId && args.tables.length !== 1) throw new BackfillRefusedError('--after-id resumes inside one table: pass exactly one --table')
  return args
}

/** `?` placeholders (the shared SQL) to node-postgres `$n`. */
function toPg(sql: string): string {
  let n = 0
  return sql.replace(/\?/g, () => `$${++n}`)
}

function pgDb(pool: Pool): SearchBackfillDb {
  const run = (client: Pool | PoolClient): SearchSql => ({
    async query<T>(sql: string, params: unknown[]): Promise<T[]> {
      const result = await client.query(toPg(sql), params as unknown[])
      return result.rows as T[]
    },
  })
  return {
    ...run(pool),
    async transaction(fn) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const out = await fn(run(client))
        await client.query('commit')
        return out
      } catch (err) {
        try { await client.query('rollback') } catch { /* connection already gone */ }
        throw err
      } finally {
        client.release()
      }
    },
  }
}

/** TenantDataEncryptionService reads its maps with em.getConnection().execute(sql, params) and `?` placeholders. */
function emShim(pool: Pool): unknown {
  return {
    getConnection: () => ({
      async execute(sql: string, params: unknown[] = []) {
        const result = await pool.query(toPg(sql), params)
        return result.rows
      },
    }),
  }
}

/** Errors from pg can carry row values in `detail`; print only the code and names. */
function safeError(err: unknown): string {
  const e = err as { name?: string; code?: string; table?: string; column?: string; constraint?: string; message?: string }
  if (e?.name === 'BackfillRefusedError' || e?.name === 'SearchIndexVerificationError') return `${e.name}: ${e.message}`
  const parts = [`name=${e?.name ?? 'Error'}`]
  if (e?.code) parts.push(`code=${e.code}`)
  if (e?.table) parts.push(`table=${e.table}`)
  if (e?.column) parts.push(`column=${e.column}`)
  if (e?.constraint) parts.push(`constraint=${e.constraint}`)
  return parts.join(' ')
}

async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const { rows } = await pool.query(`select to_regclass($1)::text as t`, [table])
  return Boolean(rows[0]?.t)
}

async function printLeakCounts(pool: Pool): Promise<number> {
  let total = 0
  for (const item of searchIndexLeakCountSql()) {
    if (!(await tableExists(pool, item.requires))) {
      console.log(`[leaks] ${item.label}: table ${item.requires} absent`)
      continue
    }
    try {
      const { rows } = await pool.query(item.sql)
      const n = Number(rows[0]?.n ?? 0)
      total += n
      console.log(`[leaks] ${item.label}: ${n}`)
    } catch (err) {
      console.log(`[leaks] ${item.label}: could not count (${safeError(err)})`)
    }
  }
  return total
}

async function applyMigration(pool: Pool, execute: boolean): Promise<void> {
  const statements = [...SEARCH_INDEX_SCHEMA_SQL, ...searchIndexPurgeSql()]
  if (!execute) {
    console.log(`[migration] ${SEARCH_INDEX_MIGRATION_NAME}: ${statements.length} statements would run (dry run). Re-run with --execute.`)
    return
  }
  const client = await pool.connect()
  try {
    await client.query('begin')
    for (const sql of statements) await client.query(sql)
    // Record it for the migrator, which does not run in the production image.
    if ((await client.query(`select to_regclass('mikro_orm_migrations_customers')::text as t`)).rows[0]?.t) {
      const seen = await client.query(`select 1 from mikro_orm_migrations_customers where name like $1 limit 1`, [`${SEARCH_INDEX_MIGRATION_NAME}%`])
      if (!seen.rowCount) {
        await client.query(`insert into mikro_orm_migrations_customers (name, executed_at) values ($1, now())`, [SEARCH_INDEX_MIGRATION_NAME])
      }
    }
    await client.query('commit')
    console.log(`[migration] ${SEARCH_INDEX_MIGRATION_NAME}: applied (${statements.length} statements, idempotent)`)
  } catch (err) {
    try { await client.query('rollback') } catch { /* gone */ }
    throw err
  } finally {
    client.release()
  }
}

async function main(): Promise<number> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
    assertBackfillEnvironment(process.env)
  } catch (err) {
    console.error(`[search-index] refused: ${safeError(err)}`)
    return 2
  }
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('[search-index] refused: DATABASE_URL is not set')
    return 2
  }
  const pool = new Pool({ connectionString, max: 3, application_name: 'reindex-customer-search' })
  try {
    console.log(`[search-index] mode=${args.execute ? 'EXECUTE' : 'dry-run'} ${args.check ? 'check' : 'backfill'} phase=${args.phase}`
      + ` tenant=${args.tenantId ?? 'all'} org=${args.organizationId ?? 'all'} batch=${args.batchSize}`)
    if (args.applyMigration) {
      // Schema + purge only; the token backfill is its own, separately verified step.
      await applyMigration(pool, args.execute)
      await printLeakCounts(pool)
      return 0
    }
    await printLeakCounts(pool)
    if (!(await tableExists(pool, 'customer_search_tokens'))) {
      console.error('[search-index] customer_search_tokens does not exist yet. Run with --apply-migration --execute first.')
      return 2
    }
    const service = new TenantDataEncryptionService(emShim(pool) as any, { kms: createKmsService() })
    const db = pgDb(pool)
    let code = 0

    if (args.phase === 'index-docs' || args.phase === 'all') {
      const r = await runIndexDocEncryption(db, service, {
        dryRun: !args.execute, batchSize: args.batchSize, tenantId: args.tenantId, organizationId: args.organizationId,
        log: args.execute ? (l) => console.log(l) : undefined,
      })
      console.log(formatIndexDocReport(r, !args.execute))
      if (args.execute && r.fieldsStillPlaintext > 0) code = 3
    }

    if (args.phase === 'tokens' || args.phase === 'all') {
      const report = await runSearchIndexJob(db, service, {
        mode: args.check ? 'check' : 'backfill',
        dryRun: !args.execute,
        batchSize: args.batchSize,
        tenantId: args.tenantId,
        organizationId: args.organizationId,
        tables: args.tables.length ? args.tables : undefined,
        afterId: args.afterId,
        log: args.execute ? (l) => console.log(l) : undefined,
      })
      for (const line of formatSearchIndexReport(report)) console.log(line)
      const drift = searchIndexDrift(report)
      if (!args.execute) {
        console.log(`[search-index] dry run complete; nothing was written. Entities/orphans out of step: ${drift}.`
          + (drift ? ' Re-run with --execute to write.' : ''))
        if (args.check && drift) code = 3
      } else {
        // Proof: a second read-only pass must find the index in step.
        const verify = await runSearchIndexJob(db, service, {
          mode: 'check', dryRun: true, batchSize: args.batchSize,
          tenantId: args.tenantId, organizationId: args.organizationId,
          tables: args.tables.length ? args.tables : undefined,
          afterId: args.afterId,
        })
        const left = searchIndexDrift(verify)
        console.log(`[search-index] post-run check: out of step=${left}`)
        if (left) code = 3
      }
    }
    return code
  } catch (err) {
    console.error(`[search-index] stopped: ${safeError(err)}`)
    if (err instanceof SearchIndexVerificationError) {
      console.error('[search-index] the failing batch was rolled back; earlier batches are committed and verified. Re-running is safe.')
      return 3
    }
    if (err instanceof BackfillRefusedError) return 2
    console.error('[search-index] the in-flight batch (if any) was rolled back. Re-running is safe.')
    return 1
  } finally {
    await pool.end().catch(() => {})
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code })
}
