/**
 * Encrypt contact rows (and their person/company/deal/activity/comment/address
 * rows), user emails (users) and event registrations (event_attendees) whose
 * encrypted-by-design fields are still plaintext.
 *
 * Bundled by the Dockerfile builder stage into /app/scripts/reencrypt-plaintext-contacts.cjs
 * in the runner image (the mercato CLI cannot run there). Relative imports only.
 *
 *   node /app/scripts/reencrypt-plaintext-contacts.cjs                 # dry run (default)
 *   node /app/scripts/reencrypt-plaintext-contacts.cjs --execute       # write
 *
 * Options: --tenant <uuid> --org <uuid> --table <name>[,<name>] --after-id <uuid>
 *          --batch-size <n> (default 200) --show-ids --allow-unreadable
 *
 * Never prints a stored value: counts per org/table/field and row ids only.
 * Exit codes: 0 done, 2 refused (precondition), 3 verification failed (batch rolled back), 1 other error.
 */
import { Pool, type PoolClient } from 'pg'
import { createKmsService } from '../packages/shared/src/lib/encryption/kms'
import { TenantDataEncryptionService } from '../packages/shared/src/lib/encryption/tenantDataEncryptionService'
import {
  BackfillRefusedError,
  BackfillVerificationError,
  ENCRYPTED_BACKFILL_TABLES,
  assertBackfillEnvironment,
  assertSafeToWrite,
  formatBackfillReport,
  runPlaintextBackfill,
  type BackfillDb,
  type BackfillQuery,
} from '../packages/shared/src/lib/encryption/plaintextBackfill'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Args = {
  execute: boolean
  tenantId: string | null
  organizationId: string | null
  tables: string[]
  afterId: string | null
  batchSize: number
  showIds: boolean
  allowUnreadable: boolean
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    execute: false,
    tenantId: null,
    organizationId: null,
    tables: [],
    afterId: null,
    batchSize: 200,
    showIds: false,
    allowUnreadable: false,
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
      case '--tenant': args.tenantId = take(); break
      case '--org': args.organizationId = take(); break
      case '--table': args.tables.push(...take().split(',').map((s) => s.trim()).filter(Boolean)); break
      case '--after-id': args.afterId = take(); break
      case '--batch-size': args.batchSize = Number.parseInt(take(), 10); break
      case '--show-ids': args.showIds = true; break
      case '--allow-unreadable': args.allowUnreadable = true; break
      default: throw new BackfillRefusedError(`Unknown option ${raw}`)
    }
  }
  for (const [name, v] of [['--tenant', args.tenantId], ['--org', args.organizationId], ['--after-id', args.afterId]] as const) {
    if (v && !UUID_RE.test(v)) throw new BackfillRefusedError(`${name} must be a uuid`)
  }
  if (!Number.isFinite(args.batchSize) || args.batchSize < 1 || args.batchSize > 5000) {
    throw new BackfillRefusedError('--batch-size must be 1..5000')
  }
  const known = new Set(ENCRYPTED_BACKFILL_TABLES.map((t) => t.table))
  for (const t of args.tables) if (!known.has(t)) throw new BackfillRefusedError(`Unknown --table ${t}`)
  return args
}

function pgDb(pool: Pool): BackfillDb {
  const run = (client: Pool | PoolClient): BackfillQuery => ({
    async query(sql, params) {
      const result = await client.query(sql, params as unknown[] | undefined)
      return { rows: result.rows as any[], rowCount: result.rowCount ?? 0 }
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

/**
 * TenantDataEncryptionService reads its maps with `em.getConnection().execute(sql, params)`
 * and `?` placeholders. This is the only EntityManager surface it touches.
 */
function emShim(pool: Pool): unknown {
  return {
    getConnection: () => ({
      async execute(sql: string, params: unknown[] = []) {
        let n = 0
        const text = sql.replace(/\?/g, () => `$${++n}`)
        const result = await pool.query(text, params)
        return result.rows
      },
    }),
  }
}

/** Errors from pg can carry row values in `detail`; print only the code and names. */
function safeError(err: unknown): string {
  const e = err as { name?: string; code?: string; table?: string; column?: string; constraint?: string; message?: string }
  if (e?.name === 'BackfillRefusedError' || e?.name === 'BackfillVerificationError') return `${e.name}: ${e.message}`
  const parts = [`name=${e?.name ?? 'Error'}`]
  if (e?.code) parts.push(`code=${e.code}`)
  if (e?.table) parts.push(`table=${e.table}`)
  if (e?.column) parts.push(`column=${e.column}`)
  if (e?.constraint) parts.push(`constraint=${e.constraint}`)
  return parts.join(' ')
}

async function main(): Promise<number> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
    assertBackfillEnvironment(process.env)
  } catch (err) {
    console.error(`[reencrypt] refused: ${safeError(err)}`)
    return 2
  }
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('[reencrypt] refused: DATABASE_URL is not set')
    return 2
  }
  const pool = new Pool({ connectionString, max: 2, application_name: 'reencrypt-plaintext-contacts' })
  try {
    const service = new TenantDataEncryptionService(emShim(pool) as any, { kms: createKmsService() })
    const db = pgDb(pool)
    const common = {
      batchSize: args.batchSize,
      tables: args.tables.length ? args.tables : undefined,
      tenantId: args.tenantId,
      organizationId: args.organizationId,
      afterId: args.afterId,
      collectRowIds: args.showIds,
    }
    console.log(`[reencrypt] mode=${args.execute ? 'EXECUTE' : 'dry-run'} tables=${(args.tables.length ? args.tables : ENCRYPTED_BACKFILL_TABLES.map((t) => t.table)).join(',')} tenant=${args.tenantId ?? 'all'} org=${args.organizationId ?? 'all'} batch=${args.batchSize}`)

    // Always a full read-only pass first; a real run only proceeds if it is clean.
    const preflight = await runPlaintextBackfill(db, service, { ...common, dryRun: true, log: args.execute ? undefined : (l) => console.log(l) })
    for (const line of formatBackfillReport(preflight)) console.log(line)
    if (!args.execute) {
      console.log('[reencrypt] dry run complete; nothing was written. Re-run with --execute to encrypt.')
      return 0
    }
    assertSafeToWrite(preflight, { allowUnreadable: args.allowUnreadable })

    const result = await runPlaintextBackfill(db, service, { ...common, dryRun: false, log: (l) => console.log(l) })
    for (const line of formatBackfillReport(result)) console.log(line)

    // Proof: a second read-only pass must find no plaintext left in mapped scopes.
    const after = await runPlaintextBackfill(db, service, { ...common, dryRun: true, collectRowIds: false })
    let remaining = 0
    for (const c of after.fields.values()) remaining += c.plaintext - c.tooLong
    console.log(`[reencrypt] post-run check: plaintext values remaining in mapped fields=${remaining}`)
    return remaining === 0 ? 0 : 3
  } catch (err) {
    console.error(`[reencrypt] stopped: ${safeError(err)}`)
    if (err instanceof BackfillVerificationError) {
      console.error('[reencrypt] the failing batch was rolled back; earlier batches are committed and verified. Re-running is safe.')
      return 3
    }
    if (err instanceof BackfillRefusedError) return 2
    console.error('[reencrypt] the in-flight batch (if any) was rolled back. Re-running is safe.')
    return 1
  } finally {
    await pool.end().catch(() => {})
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code })
}
