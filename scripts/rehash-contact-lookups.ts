/**
 * Rewrite contact lookup hashes (customer_entities.primary_email_hash /
 * primary_phone_hash) to the per-tenant keyed format (2026-09-25 review, M10).
 * See packages/shared/src/lib/encryption/lookupRehash.ts for the rules.
 *
 * Bundled by the Dockerfile builder stage into /app/scripts/rehash-contact-lookups.cjs
 * in the runner image (the mercato CLI cannot run there). Relative imports only.
 *
 *   node /app/scripts/rehash-contact-lookups.cjs                 # dry run (default)
 *   node /app/scripts/rehash-contact-lookups.cjs --execute       # write
 *
 * Options: --tenant <uuid> --batch-size <n> (default 200)
 *
 * Never prints a stored value or hash. Run it after deploying the keyed-hash
 * code (writers already store keyed hashes; readers match both formats), and
 * again after any tenant split. When a post-run dry run reports nothing left,
 * LOOKUP_HASH_LEGACY_READ=0 can switch the legacy read arm off.
 * Exit codes: 0 done (nothing left), 2 refused, 3 something left or a tenant
 * refused, 1 other error.
 */
import { Pool, type PoolClient } from 'pg'
import { createKmsService } from '../packages/shared/src/lib/encryption/kms'
import { TenantDataEncryptionService } from '../packages/shared/src/lib/encryption/tenantDataEncryptionService'
import {
  BackfillRefusedError,
  assertBackfillEnvironment,
  type BackfillDb,
  type BackfillQuery,
} from '../packages/shared/src/lib/encryption/plaintextBackfill'
import { formatRehashReport, rehashComplete, runLookupRehash } from '../packages/shared/src/lib/encryption/lookupRehash'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseArgs(argv: string[]): { execute: boolean; tenantId: string | null; batchSize: number } {
  const args = { execute: false, tenantId: null as string | null, batchSize: 200 }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    const [flag, inline] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined]
    const take = () => {
      if (inline !== undefined) return inline
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new BackfillRefusedError(`${flag} needs a value`)
      return v
    }
    switch (flag) {
      case '--execute': args.execute = true; break
      case '--dry-run': args.execute = false; break
      case '--tenant': args.tenantId = take(); break
      case '--batch-size': args.batchSize = Number.parseInt(take(), 10); break
      default: throw new BackfillRefusedError(`Unknown option ${raw}`)
    }
  }
  if (args.tenantId && !UUID_RE.test(args.tenantId)) throw new BackfillRefusedError('--tenant must be a uuid')
  if (!Number.isFinite(args.batchSize) || args.batchSize < 1) throw new BackfillRefusedError('--batch-size must be a positive integer')
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

function emShim(pool: Pool): unknown {
  return {
    getConnection: () => ({
      async execute(sql: string, params: unknown[] = []) {
        let n = 0
        const text = sql.replace(/\?/g, () => `$${++n}`)
        return (await pool.query(text, params)).rows
      },
    }),
  }
}

function safeError(err: unknown): string {
  const e = err as { name?: string; code?: string; table?: string; constraint?: string; message?: string }
  if (e?.name === 'BackfillRefusedError') return `${e.name}: ${e.message}`
  const parts = [`name=${e?.name ?? 'Error'}`]
  if (e?.code) parts.push(`code=${e.code}`)
  if (e?.table) parts.push(`table=${e.table}`)
  if (e?.constraint) parts.push(`constraint=${e.constraint}`)
  return parts.join(' ')
}

async function main(): Promise<number> {
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs(process.argv.slice(2))
    assertBackfillEnvironment(process.env)
  } catch (err) {
    console.error(`[rehash] refused: ${safeError(err)}`)
    return 2
  }
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('[rehash] refused: DATABASE_URL is not set')
    return 2
  }
  const pool = new Pool({ connectionString, max: 2, application_name: 'rehash-contact-lookups' })
  try {
    const service = new TenantDataEncryptionService(emShim(pool) as any, { kms: createKmsService() })
    if (!service.isEnabled()) {
      console.error('[rehash] refused: tenant data encryption service is not enabled')
      return 2
    }
    const deps = {
      keys: service,
      decrypt: async (tenantId: string, organizationId: string, stored: { primary_email: unknown; primary_phone: unknown }) => {
        const out = await service.decryptEntityPayload('customers:customer_entity', { ...stored }, tenantId, organizationId)
        return { primary_email: out.primary_email, primary_phone: out.primary_phone }
      },
    }
    const db = pgDb(pool)
    console.log(`[rehash] mode=${args.execute ? 'EXECUTE' : 'dry-run'} tenant=${args.tenantId ?? 'all'} batch=${args.batchSize}`)
    const preflight = await runLookupRehash(db, deps, { dryRun: true, tenantId: args.tenantId, batchSize: args.batchSize })
    for (const line of formatRehashReport(preflight)) console.log(line)
    if (!args.execute) {
      console.log('[rehash] dry run complete; nothing was written. Re-run with --execute to rewrite.')
      return 0
    }
    const result = await runLookupRehash(db, deps, { dryRun: false, tenantId: args.tenantId, batchSize: args.batchSize, log: (l) => console.log(l) })
    for (const line of formatRehashReport(result)) console.log(line)
    const after = await runLookupRehash(db, deps, { dryRun: true, tenantId: args.tenantId, batchSize: args.batchSize })
    const done = rehashComplete(after)
    console.log(`[rehash] post-run check: ${done ? 'nothing left to rewrite' : 'rows still need rewriting (re-run)'}`)
    return done ? 0 : 3
  } catch (err) {
    console.error(`[rehash] stopped: ${safeError(err)}. The in-flight batch (if any) was rolled back; re-running is safe.`)
    return err instanceof BackfillRefusedError ? 2 : 1
  } finally {
    await pool.end().catch(() => {})
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code })
}
