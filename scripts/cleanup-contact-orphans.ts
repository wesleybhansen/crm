/**
 * One-off repair after the MCP sweep (2026-09-25). Two phases:
 *
 *   orphans  Tasks, legacy notes, reminders, comments and activities whose
 *            contact is gone (deleted before the delete cascade existed), and
 *            their search/query index entries, are removed.
 *   notes    Legacy contact notes (contact_notes, never shown on the contact's
 *            Notes tab) are moved into customer_comments, encrypted, keeping
 *            author and timestamps; each moved legacy row is soft-deleted.
 *
 * See packages/core/src/modules/customers/lib/contactDataCleanup.ts.
 *
 * Bundled by the Dockerfile builder stage into /app/scripts/cleanup-contact-orphans.cjs
 * in the runner image (the mercato CLI cannot run there). Relative imports only.
 *
 *   node /app/scripts/cleanup-contact-orphans.cjs                  # dry run: counts only
 *   node /app/scripts/cleanup-contact-orphans.cjs --execute        # apply both phases
 *
 * Options: --phase orphans|notes|all (default all) --org <uuid> --tenant <uuid>
 *          --batch-size <n> (notes phase, default 200)
 *
 * Run `notes` before or together with `orphans` (the default order is notes
 * first, so notes of live contacts are moved, not removed). Never prints a
 * stored value: counts only. Idempotent: a second --execute finds nothing.
 * Exit codes: 0 done, 2 refused (precondition), 1 other error.
 */
import { Pool, type PoolClient } from 'pg'
import { createKmsService } from '../packages/shared/src/lib/encryption/kms'
import { TenantDataEncryptionService } from '../packages/shared/src/lib/encryption/tenantDataEncryptionService'
import { BackfillRefusedError, assertBackfillEnvironment } from '../packages/shared/src/lib/encryption/plaintextBackfill'
import {
  cleanupOrphanedContactData,
  mergeLegacyNotesIntoComments,
  type CleanupDb,
  type CleanupSql,
  type EncryptCommentRow,
} from '../packages/core/src/modules/customers/lib/contactDataCleanup'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Phase = 'orphans' | 'notes' | 'all'

export type Args = {
  execute: boolean
  phase: Phase
  organizationId: string | null
  tenantId: string | null
  batchSize: number
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { execute: false, phase: 'all', organizationId: null, tenantId: null, batchSize: 200 }
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
      case '--phase': {
        const p = take()
        if (p !== 'orphans' && p !== 'notes' && p !== 'all') throw new BackfillRefusedError('--phase must be orphans, notes or all')
        args.phase = p
        break
      }
      case '--org': args.organizationId = take(); break
      case '--tenant': args.tenantId = take(); break
      case '--batch-size': args.batchSize = Number.parseInt(take(), 10); break
      default: throw new BackfillRefusedError(`Unknown option ${raw}`)
    }
  }
  for (const [name, v] of [['--org', args.organizationId], ['--tenant', args.tenantId]] as const) {
    if (v && !UUID_RE.test(v)) throw new BackfillRefusedError(`${name} must be a uuid`)
  }
  if (!Number.isFinite(args.batchSize) || args.batchSize < 1 || args.batchSize > 5000) {
    throw new BackfillRefusedError('--batch-size must be 1..5000')
  }
  return args
}

/** `?` placeholders (the shared SQL) to node-postgres `$n`. */
function toPg(sql: string): string {
  let n = 0
  return sql.replace(/\?/g, () => `$${++n}`)
}

export function pgCleanupDb(pool: Pool): CleanupDb {
  const run = (client: Pool | PoolClient): CleanupSql => ({
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await client.query(toPg(sql), params)
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
        return (await pool.query(toPg(sql), params)).rows
      },
    }),
  }
}

/** Comment encryption that fails closed (a missing map or key throws). */
export function commentEncryptor(service: TenantDataEncryptionService, em: unknown): EncryptCommentRow {
  return async (row, tenantId, organizationId) =>
    (await service.encryptEntityPayload('customers:customer_comment', row, tenantId, organizationId, {
      em: em as any,
      requireMap: true,
    })) as Record<string, unknown>
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
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
    if (args.phase !== 'orphans') assertBackfillEnvironment(process.env)
  } catch (err) {
    console.error(`[contact-cleanup] refused: ${safeError(err)}`)
    return 2
  }
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('[contact-cleanup] refused: DATABASE_URL is not set')
    return 2
  }
  const pool = new Pool({ connectionString, max: 2, application_name: 'cleanup-contact-orphans' })
  const scope = { organizationId: args.organizationId, tenantId: args.tenantId }
  try {
    const db = pgCleanupDb(pool)
    console.log(
      `[contact-cleanup] mode=${args.execute ? 'EXECUTE' : 'dry-run'} phase=${args.phase} ` +
        `org=${args.organizationId ?? 'all'} tenant=${args.tenantId ?? 'all'}`,
    )
    if (args.phase !== 'orphans') {
      const em = emShim(pool)
      const service = new TenantDataEncryptionService(em as any, { kms: createKmsService() })
      if (!service.isEnabled()) {
        console.error('[contact-cleanup] refused: tenant data encryption service is not enabled')
        return 2
      }
      const notes = await mergeLegacyNotesIntoComments(db, commentEncryptor(service, em), {
        ...scope,
        apply: args.execute,
        batchSize: args.batchSize,
      })
      console.log(
        `[contact-cleanup] legacy notes: ${notes.legacyNotes} live; ${args.execute ? 'moved' : 'would move'} ${notes.merged} ` +
          `to the Notes tab; ${notes.skippedNoContact} belong to a deleted contact (orphans phase); ${notes.skippedEmpty} empty`,
      )
    }
    if (args.phase !== 'notes') {
      const orphans = await cleanupOrphanedContactData(db, { ...scope, apply: args.execute })
      console.log(
        `[contact-cleanup] orphans of deleted contacts: ${orphans.tasks} task(s), ${orphans.notes} legacy note(s), ` +
          `${orphans.reminders} reminder(s), ${orphans.comments} comment(s), ${orphans.activities} activit${orphans.activities === 1 ? 'y' : 'ies'}` +
          (args.execute ? `; removed, with ${orphans.indexEntriesRemoved} search/index entr${orphans.indexEntriesRemoved === 1 ? 'y' : 'ies'}` : ''),
      )
    }
    if (!args.execute) console.log('[contact-cleanup] dry run complete; nothing was written. Re-run with --execute to apply.')
    return 0
  } catch (err) {
    console.error(`[contact-cleanup] stopped: ${safeError(err)}. The in-flight batch (if any) was rolled back; re-running is safe.`)
    return err instanceof BackfillRefusedError ? 2 : 1
  } finally {
    await pool.end().catch(() => {})
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code })
}
