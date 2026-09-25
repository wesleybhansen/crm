/**
 * One tenant per customer: move every organization except the kept one out of
 * the shared tenant, each into a tenant (and data key) of its own. The logic
 * lives in packages/shared/src/lib/encryption/tenantSplit.ts (see its header
 * for exactly what moves, what is copied, what is re-keyed).
 *
 * Bundled by the Dockerfile builder stage into /app/scripts/split-tenants.cjs
 * in the runner image. Relative imports only.
 *
 *   node /app/scripts/split-tenants.cjs --keep-org <uuid>                 # dry run (default): full run per org, then ROLLBACK
 *   node /app/scripts/split-tenants.cjs --keep-org <uuid> --execute       # commit org by org (resumable)
 *   node /app/scripts/split-tenants.cjs --keep-org <uuid> --verify-only   # read-only verification of committed orgs
 *
 * Options: --org <uuid> (repeatable; default every other root org of the kept org's tenant)
 *          --resume (default for --execute: skip orgs the ledger shows committed)
 *          --sweep (re-run committed orgs too; every step is idempotent)
 *          --allow-unreadable (an envelope stamped with the old key id that does not open is left as is)
 *          --skip-queue-check (rehearsal copies without the production Redis only)
 *
 * Refuses (exit 2) unless: the key scheme is `derived` and the key opens a
 * sample of the old tenant's data; for --execute also MAINTENANCE=1 and the
 * four BullMQ queues drained. Never prints a stored value: counts, table
 * names and ids only.
 * Exit codes: 0 done / verified, 2 refused, 3 verification failed (the failing
 * org's transaction was rolled back), 1 other error.
 */
import { Pool, type PoolClient } from 'pg'
import { createKmsService, resolveTenantKmsProvider } from '../packages/shared/src/lib/encryption/kms'
import { decryptWithAesGcmStrict } from '../packages/shared/src/lib/encryption/aes'
import { TenantDataEncryptionService } from '../packages/shared/src/lib/encryption/tenantDataEncryptionService'
import { isTenantDataEncryptionEnabled } from '../packages/shared/src/lib/encryption/toggles'
import { isMaintenanceMode } from '../packages/shared/src/lib/runtime/tenancy'
import { getRedisUrl, parseRedisUrl } from '../packages/shared/src/lib/redis/connection'
import type { SearchSql } from '../packages/shared/src/lib/encryption/searchIndex'
import { runSearchIndexJob, searchIndexDrift, type SearchBackfillDb } from '../packages/shared/src/lib/encryption/searchIndexBackfill'
import { parseInterval } from '../packages/scheduler/src/modules/scheduler/lib/intervalParser'
import {
  SplitRefusedError,
  SplitVerificationError,
  formatSplitReport,
  runTenantSplit,
  splitReportOk,
  type SplitDb,
  type SplitMode,
  type SplitQuery,
} from '../packages/shared/src/lib/encryption/tenantSplit'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Queues whose job payloads carry a tenant id (docker-compose.prod.yml workers). */
export const TENANT_QUEUES = ['gtm-mailbox-ingest', 'gtm-execution-tick', 'gtm-auto-refill', 'scheduler-execution'] as const

export type Args = {
  mode: SplitMode
  keepOrg: string | null
  orgs: string[]
  resume: boolean
  sweep: boolean
  allowUnreadable: boolean
  skipQueueCheck: boolean
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', keepOrg: null, orgs: [], resume: true, sweep: false, allowUnreadable: false, skipQueueCheck: false }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new SplitRefusedError(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    const [flag, inline] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined]
    const take = () => (inline !== undefined ? inline : value(i++, flag))
    switch (flag) {
      case '--dry-run': args.mode = 'dry-run'; break
      case '--execute': args.mode = 'execute'; break
      case '--verify-only': args.mode = 'verify'; break
      case '--keep-org': args.keepOrg = take(); break
      case '--org': args.orgs.push(take()); break
      case '--resume': args.resume = true; break
      case '--sweep': args.sweep = true; break
      case '--allow-unreadable': args.allowUnreadable = true; break
      case '--skip-queue-check': args.skipQueueCheck = true; break
      default: throw new SplitRefusedError(`Unknown option ${raw}`)
    }
  }
  if (!args.keepOrg) throw new SplitRefusedError('--keep-org <uuid> is required (the organization that keeps the current tenant)')
  for (const v of [args.keepOrg, ...args.orgs]) {
    if (!UUID_RE.test(v)) throw new SplitRefusedError('--keep-org / --org must be uuids')
  }
  if (args.orgs.includes(args.keepOrg)) throw new SplitRefusedError('--org must not name the kept organization')
  return args
}

function pgQuery(client: Pool | PoolClient): SplitQuery {
  return {
    async query(sql, params) {
      const result = await client.query(sql, params as unknown[] | undefined)
      return { rows: result.rows as any[], rowCount: result.rowCount ?? 0 }
    },
  }
}

function pgDb(pool: Pool): SplitDb {
  return {
    ...pgQuery(pool),
    async transaction(fn) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const out = await fn(pgQuery(client))
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

/** `?` placeholders (the shared search SQL) to node-postgres `$n`. */
function toPg(sql: string): string {
  let n = 0
  return sql.replace(/\?/g, () => `$${++n}`)
}

function searchDb(pool: Pool): SearchBackfillDb {
  const run = (client: Pool | PoolClient): SearchSql => ({
    async query<T>(sql: string, params: unknown[]): Promise<T[]> {
      return (await client.query(toPg(sql), params as unknown[])).rows as T[]
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
        try { await client.query('rollback') } catch { /* gone */ }
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

/** Errors from pg can carry row values in `detail`; print only the code and names. */
function safeError(err: unknown): string {
  const e = err as { name?: string; code?: string; table?: string; column?: string; constraint?: string; message?: string }
  if (e?.name === 'SplitRefusedError' || e?.name === 'SplitVerificationError' || e?.name === 'TenantDataEncryptionError') return `${e.name}: ${e.message}`
  const parts = [`name=${e?.name ?? 'Error'}`]
  if (e?.code) parts.push(`code=${e.code}`)
  if (e?.table) parts.push(`table=${e.table}`)
  if (e?.column) parts.push(`column=${e.column}`)
  if (e?.constraint) parts.push(`constraint=${e.constraint}`)
  if (e?.message && /^[A-Z_]+:/.test(e.message)) parts.push(`message=${e.message.split('\n')[0]}`)
  return parts.join(' ')
}

type BullQueue = {
  getJobCounts(...types: string[]): Promise<Record<string, number>>
  getDelayed(start?: number, end?: number): Promise<Array<{ id?: string; name?: string }>>
  getRepeatableJobs(): Promise<Array<{ key: string; name: string; id?: string | null }>>
  removeRepeatableByKey(key: string): Promise<boolean>
  add(name: string, data: unknown, opts?: unknown): Promise<unknown>
  close(): Promise<void>
}

async function openQueue(name: string): Promise<BullQueue> {
  const { Queue } = await import('bullmq')
  return new Queue(name, { connection: parseRedisUrl(getRedisUrl('QUEUE')) }) as unknown as BullQueue
}

/** Refuse unless every tenant-carrying queue is drained (repeatable schedules excepted). */
async function assertQueuesDrained(log: (l: string) => void): Promise<void> {
  const problems: string[] = []
  for (const name of TENANT_QUEUES) {
    const queue = await openQueue(name)
    try {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'paused')
      const delayed = await queue.getDelayed(0, 1000)
      // The scheduler keeps the next run of each repeatable schedule delayed;
      // those are re-registered for moved orgs after the split.
      const delayedNonRepeat = delayed.filter((j) => !String(j.id ?? '').startsWith('repeat:')).length
      const busy = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.prioritized ?? 0) + (counts['waiting-children'] ?? 0) + (counts.paused ?? 0)
      log(`[queues] ${name}: waiting=${counts.waiting ?? 0} active=${counts.active ?? 0} delayed=${counts.delayed ?? 0} (non-repeat ${delayedNonRepeat}) prioritized=${counts.prioritized ?? 0} paused=${counts.paused ?? 0}`)
      if (busy > 0 || delayedNonRepeat > 0) problems.push(name)
    } finally {
      await queue.close().catch(() => {})
    }
  }
  if (problems.length) throw new SplitRefusedError(`queues not drained: ${problems.join(', ')}. Stop the workers only after they drain, then retry.`)
}

/** BullMQ repeatables carry the tenant id in their data: re-register moved orgs' schedules. */
async function reregisterSchedules(pool: Pool, scheduleIds: string[], log: (l: string) => void): Promise<number> {
  if (!scheduleIds.length) return 0
  const queue = await openQueue('scheduler-execution')
  let done = 0
  try {
    const repeatables = await queue.getRepeatableJobs()
    for (const id of scheduleIds) {
      const { rows } = await pool.query(
        `select id::text as id, tenant_id::text as tenant_id, organization_id::text as organization_id, scope_type,
                schedule_type, schedule_value, timezone
           from scheduled_jobs where id = $1 and is_enabled and deleted_at is null`,
        [id],
      )
      const s = rows[0]
      if (!s) continue
      const jobName = `schedule-${s.id}`
      for (const r of repeatables) {
        if (r.name === jobName || r.id === jobName) await queue.removeRepeatableByKey(r.key)
      }
      const repeat: { tz: string; pattern?: string; every?: number } = { tz: s.timezone || 'UTC' }
      if (s.schedule_type === 'cron') repeat.pattern = s.schedule_value
      else if (s.schedule_type === 'interval') repeat.every = parseInterval(s.schedule_value)
      else { log(`[schedules] ${s.id}: unsupported type ${s.schedule_type}, left unregistered`); continue }
      // Same shape as BullMQSchedulerService.register.
      await queue.add(
        jobName,
        {
          id: jobName,
          payload: { scheduleId: s.id, tenantId: s.tenant_id, organizationId: s.organization_id, scopeType: s.scope_type },
          createdAt: new Date().toISOString(),
        },
        {
          repeat,
          removeOnComplete: { age: 86400 * 30, count: 1000 },
          removeOnFail: { age: 86400 * 90, count: 5000 },
        },
      )
      done++
    }
  } finally {
    await queue.close().catch(() => {})
  }
  log(`[schedules] re-registered ${done} of ${scheduleIds.length} repeatable schedules under their new tenant`)
  return done
}

async function assertKeyOpensOldTenant(pool: Pool, keepOrg: string, getDek: (t: string) => Promise<string>): Promise<void> {
  const { rows } = await pool.query(`select tenant_id::text as tenant_id from organizations where id = $1`, [keepOrg])
  if (!rows[0]) throw new SplitRefusedError(`keep organization ${keepOrg} not found`)
  const tenantId = rows[0].tenant_id as string
  const dek = await getDek(tenantId)
  // A few envelopes the old tenant certainly has: user emails.
  const sample = await pool.query(
    `select email from users where tenant_id = $1 and (email like '%:v2:%' or email like '%:v1%') limit 5`,
    [tenantId],
  )
  if (!sample.rows.length) {
    console.log('[split] no encrypted user email in the old tenant to sample; relying on the per-row strict decrypt')
    return
  }
  for (const row of sample.rows) {
    try {
      decryptWithAesGcmStrict(String(row.email), dek)
    } catch (err) {
      throw new SplitRefusedError(`the configured key does not open the old tenant's data (${safeError(err)}). Wrong TENANT_DATA_ENCRYPTION_KEY?`)
    }
  }
  console.log(`[split] key check: ${sample.rows.length} sampled old-tenant envelopes open with the configured key`)
}

async function main(): Promise<number> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
    if (!isTenantDataEncryptionEnabled()) throw new SplitRefusedError('TENANT_DATA_ENCRYPTION is disabled')
    const provider = resolveTenantKmsProvider()
    if (provider !== 'derived') throw new SplitRefusedError(`TENANT_KMS_PROVIDER=${provider}: the split only runs under the derived key scheme`)
    if (args.mode === 'execute' && !isMaintenanceMode()) {
      throw new SplitRefusedError('MAINTENANCE=1 is not set. Put the app in maintenance (writes answer 503) before --execute.')
    }
  } catch (err) {
    console.error(`[split] refused: ${safeError(err)}`)
    return 2
  }
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('[split] refused: DATABASE_URL is not set')
    return 2
  }
  const log = (l: string) => console.log(l)
  const pool = new Pool({ connectionString, max: 2, application_name: 'split-tenants' })
  try {
    const kms = createKmsService()
    const getDek = async (tenantId: string) => {
      const dek = await kms.getTenantDek(tenantId)
      if (!dek?.key) throw new SplitRefusedError(`no data key for tenant ${tenantId}`)
      return dek.key
    }
    console.log(`[split] mode=${args.mode} keep_org=${args.keepOrg} orgs=${args.orgs.length ? args.orgs.join(',') : 'all others'} maintenance=${isMaintenanceMode() ? 'on' : 'off'}`)
    try {
      await assertKeyOpensOldTenant(pool, args.keepOrg!, getDek)
      if (args.skipQueueCheck) {
        console.warn('[split] WARNING: --skip-queue-check. Only for rehearsal copies with no workers attached.')
      } else if (args.mode === 'execute') {
        await assertQueuesDrained(log)
      } else if (args.mode === 'dry-run') {
        await assertQueuesDrained(log).catch((err) => console.warn(`[split] (dry run) would refuse --execute: ${safeError(err)}`))
      }
    } catch (err) {
      console.error(`[split] refused: ${safeError(err)}`)
      return 2
    }
    if (args.mode === 'dry-run' && !isMaintenanceMode()) {
      console.warn('[split] (dry run) MAINTENANCE is not set; --execute would refuse.')
    }

    const service = new TenantDataEncryptionService(emShim(pool) as any, { kms })
    const sdb = searchDb(pool)
    const rebuildSearch = async (tenantId: string, organizationId: string, dryRun: boolean): Promise<number> => {
      if (!(await pool.query(`select to_regclass('customer_search_tokens')::text as t`)).rows[0]?.t) return 0
      if (!dryRun) {
        await runSearchIndexJob(sdb, service, { mode: 'backfill', dryRun: false, tenantId, organizationId })
      }
      const check = await runSearchIndexJob(sdb, service, { mode: 'check', dryRun: true, tenantId, organizationId })
      return searchIndexDrift(check)
    }

    const report = await runTenantSplit(pgDb(pool), {
      keepOrganizationId: args.keepOrg!,
      organizationIds: args.orgs.length ? args.orgs : undefined,
      mode: args.mode,
      resume: args.resume,
      sweep: args.sweep,
      allowUnreadable: args.allowUnreadable,
      getDek,
      rebuildSearch,
      log,
    })
    for (const line of formatSplitReport(report)) console.log(line)

    if (args.mode === 'execute') {
      const scheduleIds = report.orgs.flatMap((o) => o.scheduledJobIds)
      if (scheduleIds.length) {
        if (args.skipQueueCheck) console.warn(`[schedules] ${scheduleIds.length} schedules NOT re-registered (--skip-queue-check)`)
        else await reregisterSchedules(pool, scheduleIds, log)
      }
      console.log('[split] next: `mercato directory tenants:reseed --unseeded` to finish seeding the new tenants (sign-in also heals).')
    }
    if (args.mode === 'dry-run') console.log('[split] dry run complete: every organization ran in full and was rolled back. Re-run with --execute.')
    const ok = splitReportOk(report)
    console.log(`[split] result: ${ok ? 'OK' : 'VERIFICATION FAILED'}`)
    return ok ? 0 : 3
  } catch (err) {
    console.error(`[split] stopped: ${safeError(err)}`)
    if (err instanceof SplitRefusedError) return 2
    if (err instanceof SplitVerificationError) {
      console.error('[split] the failing organization was rolled back; organizations committed before it are recorded in tenant_split_ledger. Re-running resumes.')
      return 3
    }
    console.error('[split] the in-flight organization (if any) was rolled back. Re-running resumes from the ledger.')
    return 1
  } finally {
    await pool.end().catch(() => {})
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code })
}
